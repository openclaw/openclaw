import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { Client } from "@buape/carbon";
import { Routes } from "discord-api-types/v10";
import type { NativeCommandSpec } from "../../../../src/auto-reply/commands-registry.js";
import type { OpenClawConfig } from "../../../../src/config/config.js";
import { resolveStateDir } from "../../../../src/config/paths.js";
import { resolveRequiredHomeDir } from "../../../../src/infra/home-dir.js";
import {
  readJsonFileWithFallback,
  writeJsonFileAtomically,
} from "../../../../src/plugin-sdk/json-store.js";
import { normalizeAccountId as normalizeSharedAccountId } from "../../../../src/routing/account-id.js";
import {
  buildDiscordNativeCommandDeploymentDefinition,
  type DiscordNativeCommandDeploymentDefinition,
} from "./native-command.js";

type PersistedDiscordNativeCommand = {
  id: string;
  name: string;
  signatureHash: string;
  deployedAt: string;
  lastSeenAt: string;
};

type DiscordNativeCommandState = {
  version: 1;
  accountId: string;
  applicationId: string;
  commands: PersistedDiscordNativeCommand[];
};

type LiveDiscordCommand = {
  id: string;
  name: string;
  signatureHash: string;
  body: Record<string, unknown>;
};

type DesiredDiscordCommand = {
  name: string;
  signatureHash: string;
  body: DiscordNativeCommandDeploymentDefinition;
};

type DiscordNativeCommandReconcileSummary = {
  validated: number;
  unchanged: number;
  created: number;
  updated: number;
  deleted: number;
  leftAlone: number;
};

type LoadedDiscordNativeCommandState = {
  exists: boolean;
  state: DiscordNativeCommandState;
};

const DISCORD_COMMAND_RESPONSE_ONLY_FIELDS = new Set([
  "application_id",
  "description_localized",
  "guild_id",
  "id",
  "name_localized",
  "version",
]);

export type DiscordNativeCommandReconcileResult = {
  mode: "reconcile";
  liveCount: number;
  savedCount: number;
  summary: DiscordNativeCommandReconcileSummary;
};

function normalizeAccountId(accountId?: string): string {
  return normalizeSharedAccountId(accountId);
}

function resolveStatePath(params: { accountId: string; env?: NodeJS.ProcessEnv }): string {
  const env = params.env ?? process.env;
  const stateDir = resolveStateDir(env, () => resolveRequiredHomeDir(env, os.homedir));
  return path.join(
    stateDir,
    "discord",
    `native-commands-${normalizeAccountId(params.accountId)}.json`,
  );
}

function toSortedObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => toSortedObject(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .toSorted()
      .map((key) => [key, toSortedObject(record[key])]),
  );
}

function hashDefinition(definition: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(toSortedObject(definition)))
    .digest("hex");
}

function summarizeCommandNames(names: string[], maxEntries = 8): string {
  if (names.length === 0) {
    return "(none)";
  }
  const sample = [...names].sort().slice(0, maxEntries);
  const remainder = names.length - sample.length;
  return remainder > 0 ? `${sample.join(", ")} (+${remainder} more)` : sample.join(", ");
}

function toDesiredCommand(params: {
  cfg: OpenClawConfig;
  command: NativeCommandSpec;
}): DesiredDiscordCommand {
  const body = buildDiscordNativeCommandDeploymentDefinition({
    cfg: params.cfg,
    command: params.command,
  });
  return {
    name: body.name.trim().toLowerCase(),
    signatureHash: hashDefinition(body),
    body,
  };
}

function toPersistedState(params: {
  accountId: string;
  applicationId: string;
  commands: LiveDiscordCommand[];
}): DiscordNativeCommandState {
  const now = new Date().toISOString();
  return {
    version: 1,
    accountId: normalizeAccountId(params.accountId),
    applicationId: params.applicationId,
    commands: params.commands.map((command) => ({
      id: command.id,
      name: command.name,
      signatureHash: command.signatureHash,
      deployedAt: now,
      lastSeenAt: now,
    })),
  };
}

async function loadState(params: {
  accountId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<LoadedDiscordNativeCommandState> {
  const filePath = resolveStatePath(params);
  const fallback: DiscordNativeCommandState = {
    version: 1,
    accountId: normalizeAccountId(params.accountId),
    applicationId: "",
    commands: [],
  };
  const { value, exists } = await readJsonFileWithFallback<DiscordNativeCommandState>(
    filePath,
    fallback,
  );
  if (
    !value ||
    typeof value !== "object" ||
    value.version !== 1 ||
    !Array.isArray(value.commands)
  ) {
    return { exists, state: fallback };
  }
  return {
    exists,
    state: {
      version: 1,
      accountId:
        typeof value.accountId === "string"
          ? normalizeAccountId(value.accountId)
          : fallback.accountId,
      applicationId: typeof value.applicationId === "string" ? value.applicationId : "",
      commands: value.commands
        .filter((entry): entry is PersistedDiscordNativeCommand =>
          Boolean(entry && typeof entry === "object"),
        )
        .map((entry) => ({
          id: typeof entry.id === "string" ? entry.id : "",
          name: typeof entry.name === "string" ? entry.name.trim().toLowerCase() : "",
          signatureHash: typeof entry.signatureHash === "string" ? entry.signatureHash : "",
          deployedAt:
            typeof entry.deployedAt === "string" ? entry.deployedAt : new Date(0).toISOString(),
          lastSeenAt:
            typeof entry.lastSeenAt === "string" ? entry.lastSeenAt : new Date(0).toISOString(),
        }))
        .filter((entry) => entry.id && entry.name && entry.signatureHash),
    },
  };
}

async function saveState(params: {
  state: DiscordNativeCommandState;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const filePath = resolveStatePath({
    accountId: params.state.accountId,
    env: params.env,
  });
  await writeJsonFileAtomically(filePath, params.state);
}

function sanitizeLiveCommandBody(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const sanitized = Object.fromEntries(
    Object.entries(record).filter(([key]) => !DISCORD_COMMAND_RESPONSE_ONLY_FIELDS.has(key)),
  );
  const name = typeof sanitized.name === "string" ? sanitized.name.trim() : "";
  if (!name) {
    return null;
  }
  return sanitized;
}

function normalizeLiveCommand(raw: unknown): LiveDiscordCommand | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  const body = sanitizeLiveCommandBody(raw);
  const name = typeof body?.name === "string" ? body.name.trim().toLowerCase() : "";
  if (!id || !name || !body) {
    return null;
  }
  return {
    id,
    name,
    signatureHash: hashDefinition(body),
    body,
  };
}

async function fetchLiveCommands(params: {
  client: Client;
  applicationId: string;
}): Promise<LiveDiscordCommand[]> {
  const raw = await params.client.rest.get(Routes.applicationCommands(params.applicationId));
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((entry) => normalizeLiveCommand(entry))
    .filter((entry): entry is LiveDiscordCommand => Boolean(entry));
}

export async function reconcileDiscordNativeCommands(params: {
  client: Client;
  cfg: OpenClawConfig;
  runtime: {
    log?: (message: string) => void;
  };
  accountId: string;
  applicationId: string;
  commandSpecs: NativeCommandSpec[];
  extraDefinitions?: DiscordNativeCommandDeploymentDefinition[];
  env?: NodeJS.ProcessEnv;
}): Promise<DiscordNativeCommandReconcileResult> {
  const desiredCommands = [
    ...params.commandSpecs.map((command) =>
      toDesiredCommand({
        cfg: params.cfg,
        command,
      }),
    ),
    ...(params.extraDefinitions ?? []).map((body) => ({
      name: body.name.trim().toLowerCase(),
      signatureHash: hashDefinition(body),
      body,
    })),
  ];
  const desiredByName = new Map(desiredCommands.map((command) => [command.name, command]));
  const loadedState = await loadState({ accountId: params.accountId, env: params.env });
  const savedState = loadedState.state;
  const savedByName = new Map(savedState.commands.map((command) => [command.name, command]));
  const liveCommands = await fetchLiveCommands({
    client: params.client,
    applicationId: params.applicationId,
  });
  const liveByName = new Map(liveCommands.map((command) => [command.name, command]));
  const treatMissingStateAsLegacyOverwrite = !loadedState.exists && liveCommands.length > 0;
  const preservedLiveCommands = treatMissingStateAsLegacyOverwrite
    ? []
    : liveCommands.filter(
        (command) => !desiredByName.has(command.name) && !savedByName.has(command.name),
      );
  const deletedLiveCommands = liveCommands.filter((command) => {
    if (desiredByName.has(command.name)) {
      return false;
    }
    if (treatMissingStateAsLegacyOverwrite) {
      return true;
    }
    const saved = savedByName.get(command.name);
    return saved?.id === command.id;
  });

  const summary: DiscordNativeCommandReconcileSummary = {
    validated: 0,
    unchanged: 0,
    created: 0,
    updated: 0,
    deleted: 0,
    leftAlone: 0,
  };
  const resultingCommands: LiveDiscordCommand[] = [];

  params.runtime.log?.(
    `discord: native command reconcile loaded saved=${savedState.commands.length} live=${liveCommands.length} desired=${desiredCommands.length} trackedLive=${liveCommands.length - preservedLiveCommands.length} unexpectedLive=${preservedLiveCommands.length}`,
  );
  if (treatMissingStateAsLegacyOverwrite) {
    params.runtime.log?.(
      "discord: native command reconcile state missing; using legacy bulk overwrite to seed managed state",
    );
  } else if (preservedLiveCommands.length > 0) {
    params.runtime.log?.(
      `discord: native command reconcile leaving unexpected live commands untouched: ${summarizeCommandNames(preservedLiveCommands.map((command) => command.name))}`,
    );
  }

  for (const desired of desiredCommands) {
    const live = liveByName.get(desired.name);
    if (live) {
      if (live.signatureHash === desired.signatureHash) {
        summary.validated += 1;
        summary.unchanged += 1;
        continue;
      }
      summary.validated += 1;
      summary.updated += 1;
      continue;
    }

    summary.created += 1;
  }

  summary.deleted = deletedLiveCommands.length;
  summary.leftAlone = preservedLiveCommands.length;

  if (summary.created === 0 && summary.updated === 0 && summary.deleted === 0) {
    await saveState({
      env: params.env,
      state: toPersistedState({
        accountId: params.accountId,
        applicationId: params.applicationId,
        commands: liveCommands.filter((command) => desiredByName.has(command.name)),
      }),
    });

    params.runtime.log?.(
      `discord: native command reconcile summary validated=${summary.validated} unchanged=${summary.unchanged} created=${summary.created} updated=${summary.updated} deleted=${summary.deleted} leftAlone=${summary.leftAlone}`,
    );

    return {
      mode: "reconcile",
      liveCount: liveCommands.length,
      savedCount: savedState.commands.length,
      summary,
    };
  }

  const overwriteBody = [
    ...preservedLiveCommands.map((command) => command.body),
    ...desiredCommands.map((command) => command.body),
  ];
  const overwriteResult = await params.client.rest.put(
    Routes.applicationCommands(params.applicationId),
    {
      body: overwriteBody,
    },
  );
  const syncedLiveCommands = Array.isArray(overwriteResult)
    ? overwriteResult
        .map((entry) => normalizeLiveCommand(entry))
        .filter((entry): entry is LiveDiscordCommand => Boolean(entry))
    : await fetchLiveCommands({
        client: params.client,
        applicationId: params.applicationId,
      });

  resultingCommands.push(
    ...syncedLiveCommands.filter((command) => desiredByName.has(command.name)),
  );

  const persistedCommands = resultingCommands.filter((command) => command.id);
  await saveState({
    env: params.env,
    state: toPersistedState({
      accountId: params.accountId,
      applicationId: params.applicationId,
      commands: persistedCommands,
    }),
  });

  params.runtime.log?.(
    `discord: native command reconcile summary validated=${summary.validated} unchanged=${summary.unchanged} created=${summary.created} updated=${summary.updated} deleted=${summary.deleted} leftAlone=${summary.leftAlone}`,
  );

  return {
    mode: "reconcile",
    liveCount: liveCommands.length,
    savedCount: savedState.commands.length,
    summary,
  };
}

export async function snapshotDiscordNativeCommandState(params: {
  client: Client;
  accountId: string;
  applicationId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const liveCommands = await fetchLiveCommands({
    client: params.client,
    applicationId: params.applicationId,
  });
  await saveState({
    env: params.env,
    state: toPersistedState({
      accountId: params.accountId,
      applicationId: params.applicationId,
      commands: liveCommands,
    }),
  });
}

export const __testing = {
  hashDefinition,
  normalizeLiveCommand,
  resolveStatePath,
};
