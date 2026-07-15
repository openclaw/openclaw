// Discord plugin module implements command deploy behavior.
import { createHash } from "node:crypto";
import path from "node:path";
import { ApplicationCommandType, type APIApplicationCommand } from "discord-api-types/v10";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";
import {
  createApplicationCommand,
  deleteApplicationCommand,
  editApplicationCommand,
  listApplicationCommands,
  overwriteApplicationCommands,
  overwriteGuildApplicationCommands,
} from "./api.js";
import { commandsEqual, stableComparableObject } from "./command-comparison.js";
import type { BaseCommand } from "./commands.js";
import type { RequestClient } from "./rest.js";

export type DeployCommandOptions = {
  mode?: "overwrite" | "reconcile";
  force?: boolean;
};

type SerializedCommand = ReturnType<BaseCommand["serialize"]>;

const DISCORD_APPLICATION_COMMAND_LIMIT_REACHED = 30032;

/**
 * Per-`command-deploy-cache.json` path async mutex. `server-channels.ts` can
 * start several Discord deployers concurrently in the same Node.js process;
 * each one shares the same on-disk cache file. Without this lock, two
 * deployers can run `persistHashes` in parallel, both read the same on-disk
 * snapshot before either writes, and the later `rename` then overwrites the
 * earlier writer's entries — defeating the rate-limit cache.
 *
 * This is an in-process lock; cross-process serialization would need an OS
 * file lock. Discord deployers only run inside the gateway process, so an
 * in-process mutex is sufficient for the documented concurrency surface.
 */
const cachePersistLocks = new KeyedAsyncQueue();

async function withCachePersistLock<T>(storePath: string, fn: () => Promise<T>): Promise<T> {
  return await cachePersistLocks.enqueue(storePath, fn);
}

export class DiscordCommandDeployer {
  private readonly hashes = new Map<string, string>();
  private readonly pendingHashes = new Map<string, string>();
  private hashesLoaded = false;

  constructor(
    private readonly params: {
      clientId: string;
      commands: BaseCommand[];
      devGuilds?: string[];
      hashStorePath?: string;
      rest: () => RequestClient;
    },
  ) {}

  async getCommands(): Promise<APIApplicationCommand[]> {
    return await listApplicationCommands(this.rest, this.params.clientId);
  }

  async deploy(options: DeployCommandOptions = {}) {
    const commands = this.params.commands.filter((command) => command.name !== "*");
    const globalCommands = commands.filter((command) => !command.guildIds);
    const serializedGlobal = globalCommands.map((command) => command.serialize());
    for (const [guildId, entries] of groupGuildCommands(commands)) {
      await this.putCommandSetIfChanged(
        this.scopedCacheKey(`guild:${guildId}`),
        entries,
        async () => {
          await overwriteGuildApplicationCommands(
            this.rest,
            this.params.clientId,
            guildId,
            entries,
          );
        },
        options,
      );
    }
    if (this.params.devGuilds?.length) {
      for (const guildId of this.params.devGuilds) {
        const entries = commands.map((command) => command.serialize());
        await this.putCommandSetIfChanged(
          this.scopedCacheKey(`dev-guild:${guildId}`),
          entries,
          async () => {
            await overwriteGuildApplicationCommands(
              this.rest,
              this.params.clientId,
              guildId,
              entries,
            );
          },
          options,
        );
      }
      return { mode: options.mode ?? "reconcile", usedDevGuilds: true };
    }
    if (options.mode !== "overwrite") {
      await this.putCommandSetIfChanged(
        this.scopedCacheKey("global:reconcile"),
        serializedGlobal,
        async () => {
          await this.reconcileGlobalCommands(serializedGlobal);
        },
        options,
      );
      return { mode: "reconcile" as const, usedDevGuilds: false };
    }
    await this.putCommandSetIfChanged(
      this.scopedCacheKey("global:overwrite"),
      serializedGlobal,
      async () => {
        await overwriteApplicationCommands(this.rest, this.params.clientId, serializedGlobal);
      },
      options,
    );
    return { mode: "overwrite" as const, usedDevGuilds: false };
  }

  /**
   * Scope cache keys by Discord application id so multi-bot setups that share a
   * single deploy-cache file still reconcile each application separately. The
   * prior unscoped `global:reconcile` / `guild:<id>` keys let a later account
   * with an identical command set reuse the first account's hash and skip its
   * own application's reconcile entirely (#77359).
   */
  private scopedCacheKey(suffix: string): string {
    return `app:${this.params.clientId}:${suffix}`;
  }

  private async reconcileGlobalCommands(desired: SerializedCommand[]) {
    const existing = await this.getCommands();
    const existingByKey = new Map(existing.map((command) => [stableCommandKey(command), command]));
    const desiredCommands = desired.map((command) => ({
      command,
      key: stableCommandKey(command as APIApplicationCommand),
    }));
    const desiredKeys = new Set(desiredCommands.map(({ key }) => key));
    for (const { command, key } of desiredCommands) {
      const current = existingByKey.get(key);
      if (current && !commandsEqual(current, command)) {
        await editApplicationCommand(this.rest, this.params.clientId, current.id, command);
      }
    }
    for (const { command, key } of desiredCommands) {
      if (existingByKey.has(key)) {
        continue;
      }
      try {
        await createApplicationCommand(this.rest, this.params.clientId, command);
      } catch (error) {
        if (!isApplicationCommandLimitError(error)) {
          throw error;
        }
        // Reconcile cannot create before deleting at Discord's hard cap. Bulk
        // overwrite replaces the complete set without an unsafe delete gap.
        await overwriteApplicationCommands(this.rest, this.params.clientId, desired);
        return;
      }
    }
    for (const command of existing) {
      if (!desiredKeys.has(stableCommandKey(command))) {
        await deleteApplicationCommand(this.rest, this.params.clientId, command.id);
      }
    }
  }

  private async putCommandSetIfChanged(
    key: string,
    commands: SerializedCommand[],
    deploy: () => Promise<void>,
    options: { force?: boolean },
  ): Promise<void> {
    const hash = stableCommandSetHash(commands);
    await this.loadPersistedHashes();
    if (!options.force && this.hashes.get(key) === hash) {
      return;
    }
    await deploy();
    this.hashes.set(key, hash);
    this.pendingHashes.set(key, hash);
    await this.persistHashes();
  }

  private async loadPersistedHashes(): Promise<void> {
    if (this.hashesLoaded) {
      return;
    }
    this.hashesLoaded = true;
    const storePath = this.params.hashStorePath;
    if (!storePath) {
      return;
    }
    try {
      const parsed = await privateFileStore(path.dirname(storePath)).readJsonIfExists<{
        hashes?: unknown;
      }>(path.basename(storePath));
      if (!parsed?.hashes || typeof parsed.hashes !== "object") {
        return;
      }
      for (const [key, value] of Object.entries(parsed.hashes)) {
        if (typeof value === "string" && key.trim() && value.trim()) {
          this.hashes.set(key, value);
        }
      }
    } catch {
      // Best-effort cache only. A corrupt or missing file should never block startup.
    }
  }

  private async persistHashes(): Promise<void> {
    const storePath = this.params.hashStorePath;
    if (!storePath) {
      return;
    }
    // Serialize concurrent persists for the same on-disk path. The earlier
    // "re-read inside persistHashes" merge alone is not enough — two
    // deployers running `persistHashes` in true parallel would both read the
    // same snapshot before either writes, and the later `rename` would still
    // overwrite the earlier one's `app:<id>:...` entries. The mutex makes the
    // read-merge-write cycle atomic for in-process callers.
    await withCachePersistLock(storePath, async () => {
      await this.persistHashesLocked(storePath);
    });
  }

  private async persistHashesLocked(storePath: string): Promise<void> {
    try {
      // Re-read the on-disk hashes immediately before writing and merge only
      // keys this deployer changed. Previously loaded hashes can be stale when
      // sibling deployers update the same file, so on-disk wins for untouched
      // keys while pending keys win because this deployer just produced them.
      const storeFile = path.basename(storePath);
      const fileStore = privateFileStore(path.dirname(storePath));
      const merged = new Map<string, string>();
      let onDisk: { hashes?: unknown } | null = null;
      try {
        onDisk = await fileStore.readJsonIfExists<{
          hashes?: unknown;
        }>(storeFile);
      } catch {
        // A corrupt cache should not become permanent. Treat the re-read as
        // empty and replace it with the fresh pending hashes after deploy.
      }
      if (onDisk?.hashes && typeof onDisk.hashes === "object") {
        for (const [key, value] of Object.entries(onDisk.hashes)) {
          if (typeof value === "string" && key.trim() && value.trim()) {
            merged.set(key, value);
          }
        }
      }
      for (const [key, value] of this.pendingHashes.entries()) {
        merged.set(key, value);
      }
      await fileStore.writeJson(
        storeFile,
        {
          version: 1,
          updatedAt: new Date().toISOString(),
          hashes: Object.fromEntries(
            [...merged.entries()].toSorted(([left], [right]) => left.localeCompare(right)),
          ),
        },
        { trailingNewline: true },
      );
      // Refresh in-memory state so future writes from the same deployer also
      // see entries that other deployers added concurrently.
      for (const [key, value] of merged.entries()) {
        this.hashes.set(key, value);
      }
      this.pendingHashes.clear();
    } catch {
      // The cache is only an optimization to avoid redundant Discord writes.
    }
  }

  private get rest(): RequestClient {
    return this.params.rest();
  }
}

function groupGuildCommands(commands: BaseCommand[]): Map<string, SerializedCommand[]> {
  const guildCommands = new Map<string, SerializedCommand[]>();
  for (const command of commands.filter((entry) => entry.guildIds)) {
    for (const guildId of command.guildIds ?? []) {
      const entries = guildCommands.get(guildId) ?? [];
      entries.push(command.serialize());
      guildCommands.set(guildId, entries);
    }
  }
  return guildCommands;
}

function stableCommandKey(command: Pick<APIApplicationCommand, "name" | "type">) {
  return `${command.type ?? ApplicationCommandType.ChatInput}:${command.name}`;
}

function isApplicationCommandLimitError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "discordCode" in error &&
    error.discordCode === DISCORD_APPLICATION_COMMAND_LIMIT_REACHED
  );
}

function stableCommandSetHash(commands: SerializedCommand[]): string {
  const stable = commands
    .map((command) => stableComparableObject(command))
    .toSorted((a, b) =>
      stableCommandKey(a as APIApplicationCommand).localeCompare(
        stableCommandKey(b as APIApplicationCommand),
      ),
    );
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}
