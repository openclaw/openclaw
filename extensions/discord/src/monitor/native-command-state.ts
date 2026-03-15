import crypto from "node:crypto";
import type { BaseCommand, Client } from "@buape/carbon";
import { Routes } from "discord-api-types/v10";
type LiveDiscordCommand = {
  id: string;
  name: string;
  signatureHash: string;
  body: Record<string, unknown>;
};

type DesiredDiscordCommand = {
  name: string;
  signatureHash: string;
  body: Record<string, unknown>;
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
  "dm_permission",
  "guild_id",
  "id",
  "name_localized",
  "nsfw",
  "version",
]);

export type DiscordNativeCommandReconcileResult = {
  mode: "reconcile";
  liveCount: number;
  savedCount: number;
  summary: DiscordNativeCommandReconcileSummary;
};

const DISCORD_SUBCOMMAND_ONLY_FIELDS = new Set([
  "contexts",
  "default_member_permissions",
  "integration_types",
]);

function toSortedObject(value: unknown, path: string[] = []): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => toSortedObject(entry, path));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .toSorted()
      .flatMap((key) => {
        const normalizedValue = normalizeCommandComparisonValue(key, record[key], path);
        if (normalizedValue === undefined) {
          return [];
        }
        return [[key, toSortedObject(normalizedValue, [...path, key])]];
      }),
  );
}

function normalizeCommandComparisonValue(key: string, value: unknown, path: string[]): unknown {
  if (value === undefined) {
    return undefined;
  }
  // Discord omits explicit false for optional command option flags, so
  // required:false and autocomplete:false should compare the same as missing.
  if ((key === "required" || key === "autocomplete") && value === false) {
    return undefined;
  }
  // Carbon serializes subcommands by spreading a full BaseCommand payload into
  // the options array. Discord does not echo these top-level command fields
  // back on subcommand option objects.
  if (path.includes("options") && DISCORD_SUBCOMMAND_ONLY_FIELDS.has(key)) {
    return undefined;
  }
  return value;
}

function stringifySorted(value: unknown): string {
  return JSON.stringify(toSortedObject(value));
}

function hashDefinition(definition: unknown): string {
  return crypto.createHash("sha256").update(stringifySorted(definition)).digest("hex");
}

function summarizeCommandNames(names: string[], maxEntries = 8): string {
  if (names.length === 0) {
    return "(none)";
  }
  const sample = [...names].sort().slice(0, maxEntries);
  const remainder = names.length - sample.length;
  return remainder > 0 ? `${sample.join(", ")} (+${remainder} more)` : sample.join(", ");
}

function describeDrift(live: Record<string, unknown>, desired: Record<string, unknown>): string {
  const liveSorted = toSortedObject(live) as Record<string, unknown>;
  const desiredSorted = toSortedObject(desired) as Record<string, unknown>;
  const allKeys = [
    ...new Set([...Object.keys(liveSorted), ...Object.keys(desiredSorted)]),
  ].toSorted();
  const mismatches: string[] = [];
  for (const key of allKeys) {
    const liveValue = liveSorted[key];
    const desiredValue = desiredSorted[key];
    if (stringifySorted(liveValue) === stringifySorted(desiredValue)) {
      continue;
    }
    mismatches.push(
      `${key}: live=${JSON.stringify(liveValue)} desired=${JSON.stringify(desiredValue)}`,
    );
    if (mismatches.length >= 6) {
      break;
    }
  }
  return mismatches.length > 0 ? mismatches.join("; ") : "hash mismatch with no field diff";
}

function normalizeDesiredCommandBody(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name) {
    return null;
  }
  return record;
}

function toDesiredCommand(command: BaseCommand): DesiredDiscordCommand | null {
  const body = normalizeDesiredCommandBody(command.serialize());
  if (!body) {
    return null;
  }
  const name = typeof body.name === "string" ? body.name.trim().toLowerCase() : "";
  if (!name) {
    return null;
  }
  return {
    name,
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
  runtime: {
    log?: (message: string) => void;
  };
  accountId: string;
  applicationId: string;
  commands: BaseCommand[];
}): Promise<DiscordNativeCommandReconcileResult> {
  const desiredCommands = params.commands
    .map((command) => toDesiredCommand(command))
    .filter((command): command is DesiredDiscordCommand => Boolean(command));
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
    const sample = updatedCommands.at(0);
    if (sample) {
      params.runtime.log?.(
        `discord: native command reconcile drift sample /${sample.desired.name}: ${describeDrift(sample.live.body, sample.desired.body)}`,
      );
    }
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
