import crypto from "node:crypto";
import type { Client } from "@buape/carbon";
import { Routes } from "discord-api-types/v10";
import type { NativeCommandSpec } from "../../../../src/auto-reply/commands-registry.js";
import type { OpenClawConfig } from "../../../../src/config/config.js";
import {
  buildDiscordNativeCommandDeploymentDefinition,
  type DiscordNativeCommandDeploymentDefinition,
} from "./native-command.js";

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
  const liveCommands = await fetchLiveCommands({
    client: params.client,
    applicationId: params.applicationId,
  });
  const liveByName = new Map(liveCommands.map((command) => [command.name, command]));
  const deletedLiveCommands = liveCommands.filter((command) => !desiredByName.has(command.name));
  const updatedCommands = desiredCommands.flatMap((desired) => {
    const live = liveByName.get(desired.name);
    if (!live || live.signatureHash === desired.signatureHash) {
      return [];
    }
    return [{ live, desired }];
  });
  const createdCommands = desiredCommands.filter((desired) => !liveByName.has(desired.name));

  const summary: DiscordNativeCommandReconcileSummary = {
    validated: 0,
    unchanged: 0,
    created: 0,
    updated: 0,
    deleted: 0,
    leftAlone: 0,
  };

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
  const matchedByNameCount = summary.validated;

  params.runtime.log?.(
    `discord: native command reconcile loaded live=${liveCommands.length} desired=${desiredCommands.length} matched=${matchedByNameCount} extra=${deletedLiveCommands.length} missing=${createdCommands.length} drifted=${updatedCommands.length}`,
  );
  if (deletedLiveCommands.length > 0) {
    params.runtime.log?.(
      `discord: native command reconcile deleting extra live commands: ${summarizeCommandNames(deletedLiveCommands.map((command) => command.name))}`,
    );
  }
  if (updatedCommands.length > 0) {
    params.runtime.log?.(
      `discord: native command reconcile updating drifted commands: ${summarizeCommandNames(updatedCommands.map(({ desired }) => desired.name))}`,
    );
  }
  if (createdCommands.length > 0) {
    params.runtime.log?.(
      `discord: native command reconcile creating missing commands: ${summarizeCommandNames(createdCommands.map((command) => command.name))}`,
    );
  }

  if (summary.created === 0 && summary.updated === 0 && summary.deleted === 0) {
    params.runtime.log?.(
      `discord: native command reconcile summary validated=${summary.validated} unchanged=${summary.unchanged} created=${summary.created} updated=${summary.updated} deleted=${summary.deleted} leftAlone=${summary.leftAlone}`,
    );

    return {
      mode: "reconcile",
      liveCount: liveCommands.length,
      savedCount: 0,
      summary,
    };
  }

  for (const live of deletedLiveCommands) {
    await params.client.rest.delete(Routes.applicationCommand(params.applicationId, live.id));
  }
  for (const { live, desired } of updatedCommands) {
    await params.client.rest.patch(Routes.applicationCommand(params.applicationId, live.id), {
      body: desired.body,
    });
  }
  for (const desired of createdCommands) {
    await params.client.rest.post(Routes.applicationCommands(params.applicationId), {
      body: desired.body,
    });
  }

  params.runtime.log?.(
    `discord: native command reconcile summary validated=${summary.validated} unchanged=${summary.unchanged} created=${summary.created} updated=${summary.updated} deleted=${summary.deleted} leftAlone=${summary.leftAlone}`,
  );

  return {
    mode: "reconcile",
    liveCount: liveCommands.length,
    savedCount: 0,
    summary,
  };
}

export const __testing = {
  hashDefinition,
  normalizeLiveCommand,
};
