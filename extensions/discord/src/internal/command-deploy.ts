import { createHash } from "node:crypto";
import { ApplicationCommandType, Routes, type APIApplicationCommand } from "discord-api-types/v10";
import type { DiscordCommandDeployHashStore } from "../command-deploy-store.js";
import { commandsEqual, stableComparableObject } from "./command-comparison.js";
import type { BaseCommand } from "./commands.js";
import type { RequestClient } from "./rest.js";

type SerializedCommand = ReturnType<BaseCommand["serialize"]>;

const DISCORD_APPLICATION_COMMAND_LIMIT_REACHED = 30032;

export class DiscordCommandDeployer {
  private hash: string | undefined;
  private hashLoaded = false;

  constructor(
    private readonly params: {
      clientId: string;
      commands: BaseCommand[];
      hashStore?: DiscordCommandDeployHashStore;
      rest: () => RequestClient;
    },
  ) {}

  async deploy() {
    const commands = this.params.commands
      .filter((command) => command.name !== "*")
      .map((command) => command.serialize());
    const hash = stableCommandSetHash(commands);
    await this.loadPersistedHash();
    if (this.hash === hash) {
      return;
    }
    await this.reconcileGlobalCommands(commands);
    this.hash = hash;
    try {
      await this.params.hashStore?.register(this.cacheKey, hash);
    } catch {
      // Cache persistence must not turn a successful Discord deploy into a startup failure.
    }
  }

  // Shared stores must not let one application's hash suppress another's deploy (#77359).
  private get cacheKey(): string {
    return `app:${this.params.clientId}:global:reconcile`;
  }

  private async reconcileGlobalCommands(desired: SerializedCommand[]) {
    // SAFETY: Discord's global-command list endpoint returns APIApplicationCommand[].
    const existing = (await this.request(
      "get",
      Routes.applicationCommands(this.params.clientId),
    )) as APIApplicationCommand[];
    const existingByKey = new Map(existing.map((command) => [stableCommandKey(command), command]));
    const desiredCommands = desired.map((command) => ({
      command,
      key: stableCommandKey(command),
    }));
    const desiredKeys = new Set(desiredCommands.map(({ key }) => key));
    for (const { command, key } of desiredCommands) {
      const current = existingByKey.get(key);
      if (current && !commandsEqual(current, command)) {
        await this.request(
          "patch",
          Routes.applicationCommand(this.params.clientId, current.id),
          command,
        );
      }
    }
    for (const { command, key } of desiredCommands) {
      if (existingByKey.has(key)) {
        continue;
      }
      try {
        await this.request("post", Routes.applicationCommands(this.params.clientId), command);
      } catch (error) {
        if (!isApplicationCommandLimitError(error)) {
          throw error;
        }
        // Reconcile cannot create before deleting at Discord's hard cap. Bulk
        // overwrite replaces the complete set without an unsafe delete gap.
        await this.request("put", Routes.applicationCommands(this.params.clientId), desired);
        return;
      }
    }
    for (const command of existing) {
      if (!desiredKeys.has(stableCommandKey(command))) {
        await this.request("delete", Routes.applicationCommand(this.params.clientId, command.id));
      }
    }
  }

  private async loadPersistedHash(): Promise<void> {
    if (this.hashLoaded) {
      return;
    }
    this.hashLoaded = true;
    try {
      this.hash = await this.params.hashStore?.lookup(this.cacheKey);
    } catch {
      // Cache lookup failure is a miss. Reconcile repairs the canonical row after success.
    }
  }

  private async request(
    method: "get" | "post" | "put" | "patch" | "delete",
    path: string,
    body?: SerializedCommand | SerializedCommand[],
  ): Promise<unknown> {
    const rest = this.params.rest();
    const timeoutMs = rest.options.timeout;
    const startedAt = Date.now();
    try {
      return method === "get" || body === undefined
        ? await rest[method](path)
        : await rest[method](path, { body });
    } catch (error) {
      // Annotate only this owner's requests; concurrent startup REST traffic is unrelated.
      if (error && typeof error === "object") {
        if (
          body !== undefined &&
          (!("deployRequestBody" in error) || error.deployRequestBody === undefined)
        ) {
          Object.assign(error, { deployRequestBody: body });
        }
        Object.assign(error, {
          deployRestMethod: method,
          deployRestPath: path,
          deployRequestMs: Date.now() - startedAt,
          ...(Number.isFinite(timeoutMs) ? { deployTimeoutMs: timeoutMs } : {}),
        });
      }
      throw error;
    }
  }
}

function stableCommandKey(command: { name: string; type?: ApplicationCommandType }) {
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
    .toSorted((a, b) => stableCommandKey(a).localeCompare(stableCommandKey(b)))
    .map((command) => stableComparableObject(command));
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}
