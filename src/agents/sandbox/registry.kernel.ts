import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Insertable, Selectable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import type { SandboxBrowserRegistryEntry, SandboxRegistryEntry } from "./registry.types.js";

export type SandboxRegistryInsert = Insertable<DB["sandbox_registry_entries"]>;

type SandboxRegistryRow = Selectable<DB["sandbox_registry_entries"]>;
type SandboxRegistryDatabase = Pick<DB, "sandbox_registry_entries">;

export function containerEntryToRow(
  entry: SandboxRegistryEntry,
  existing?: SandboxRegistryEntry | null,
) {
  const next: SandboxRegistryEntry = {
    ...entry,
    backendId: entry.backendId ?? existing?.backendId,
    backendTarget: entry.backendTarget ?? existing?.backendTarget,
    runtimeLabel: entry.runtimeLabel ?? existing?.runtimeLabel,
    createdAtMs: existing?.createdAtMs ?? entry.createdAtMs,
    image: existing?.image ?? entry.image,
    configLabelKind: entry.configLabelKind ?? existing?.configLabelKind,
    configHash: entry.configHash ?? existing?.configHash,
    runtimeState: entry.runtimeState ?? existing?.runtimeState,
    workspaceDir: existing?.workspaceDir ?? entry.workspaceDir,
  };
  return {
    registry_kind: "container",
    container_name: next.containerName,
    session_key: next.sessionKey,
    backend_id: next.backendId ?? null,
    runtime_label: next.runtimeLabel ?? null,
    image: next.image,
    created_at_ms: next.createdAtMs,
    last_used_at_ms: next.lastUsedAtMs,
    config_label_kind: next.configLabelKind ?? null,
    config_hash: next.configHash ?? null,
    cdp_port: null,
    no_vnc_port: null,
    entry_json: JSON.stringify(next),
    updated_at: Date.now(),
  } satisfies SandboxRegistryInsert;
}

export function browserEntryToRow(
  entry: SandboxBrowserRegistryEntry,
  existing?: SandboxBrowserRegistryEntry | null,
) {
  const next: SandboxBrowserRegistryEntry = {
    ...entry,
    createdAtMs: existing?.createdAtMs ?? entry.createdAtMs,
    image: existing?.image ?? entry.image,
    configHash: entry.configHash ?? existing?.configHash,
    workspaceDir: entry.workspaceDir ?? existing?.workspaceDir,
  };
  return {
    registry_kind: "browser",
    container_name: next.containerName,
    session_key: next.sessionKey,
    backend_id: null,
    runtime_label: null,
    image: next.image,
    created_at_ms: next.createdAtMs,
    last_used_at_ms: next.lastUsedAtMs,
    config_label_kind: null,
    config_hash: next.configHash ?? null,
    cdp_port: next.cdpPort,
    no_vnc_port: next.noVncPort ?? null,
    entry_json: JSON.stringify(next),
    updated_at: Date.now(),
  } satisfies SandboxRegistryInsert;
}

export function insertSandboxRegistryRowIfMissingInDatabase(
  db: DatabaseSync,
  row: SandboxRegistryInsert,
): void {
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<SandboxRegistryDatabase>(db)
      .insertInto("sandbox_registry_entries")
      .values(row)
      .onConflict((conflict) => conflict.columns(["registry_kind", "container_name"]).doNothing()),
  );
}

function parseRegistryEntryJson(row: SandboxRegistryRow): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(row.entry_json) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function optionalPayloadString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function rowToContainerEntry(row: SandboxRegistryRow): SandboxRegistryEntry | null {
  if (row.registry_kind !== "container") {
    return null;
  }
  const payload = parseRegistryEntryJson(row);
  if (!payload) {
    return null;
  }
  return normalizeSandboxRegistryEntry({
    ...payload,
    containerName: row.container_name,
    sessionKey: row.session_key ?? optionalPayloadString(payload.sessionKey),
    createdAtMs: row.created_at_ms ?? Number(payload.createdAtMs ?? 0),
    lastUsedAtMs: row.last_used_at_ms ?? Number(payload.lastUsedAtMs ?? 0),
    image: row.image ?? optionalPayloadString(payload.image),
    ...(row.backend_id != null ? { backendId: row.backend_id } : {}),
    ...(row.runtime_label != null ? { runtimeLabel: row.runtime_label } : {}),
    ...(row.config_label_kind != null ? { configLabelKind: row.config_label_kind } : {}),
    ...(row.config_hash != null ? { configHash: row.config_hash } : {}),
  });
}

export function rowToBrowserEntry(row: SandboxRegistryRow): SandboxBrowserRegistryEntry | null {
  if (row.registry_kind !== "browser") {
    return null;
  }
  const payload = parseRegistryEntryJson(row);
  if (!payload) {
    return null;
  }
  return {
    ...payload,
    containerName: row.container_name,
    sessionKey: row.session_key ?? optionalPayloadString(payload.sessionKey),
    createdAtMs: row.created_at_ms ?? Number(payload.createdAtMs ?? 0),
    lastUsedAtMs: row.last_used_at_ms ?? Number(payload.lastUsedAtMs ?? 0),
    image: row.image ?? optionalPayloadString(payload.image),
    cdpPort: row.cdp_port ?? Number(payload.cdpPort ?? 0),
    ...(row.no_vnc_port != null ? { noVncPort: row.no_vnc_port } : {}),
    ...(row.config_hash != null ? { configHash: row.config_hash } : {}),
  };
}

function normalizeSandboxRegistryEntry(entry: SandboxRegistryEntry): SandboxRegistryEntry {
  return {
    ...entry,
    backendId: entry.backendId?.trim() || "docker",
    runtimeLabel: entry.runtimeLabel?.trim() || entry.containerName,
    configLabelKind: entry.configLabelKind?.trim() || "Image",
  };
}

function readRegistryRows(
  db: DatabaseSync,
  kind: "container" | "browser",
  filter?: { backendId: string; scopeKey: string },
): SandboxRegistryRow[] {
  if (!tableExists(db, "sandbox_registry_entries")) {
    return [];
  }
  let query = getNodeSqliteKysely<SandboxRegistryDatabase>(db)
    .selectFrom("sandbox_registry_entries")
    .selectAll()
    .where("registry_kind", "=", kind);
  if (filter) {
    query = query
      .where("session_key", "=", filter.scopeKey)
      .where("backend_id", "=", filter.backendId);
  }
  return executeSqliteQuerySync(
    db,
    filter
      ? query.orderBy("last_used_at_ms", "desc").orderBy("container_name", "asc")
      : query.orderBy("container_name", "asc"),
  ).rows;
}

export function readSandboxRegistryEntryInDatabase(
  db: DatabaseSync,
  containerName: string,
): SandboxRegistryEntry | null {
  if (!tableExists(db, "sandbox_registry_entries")) {
    return null;
  }
  const row = readSandboxRegistryRowInDatabase(db, "container", containerName);
  return row ? rowToContainerEntry(row) : null;
}

export function readSandboxRegistryRowInDatabase(
  db: DatabaseSync,
  kind: "container" | "browser",
  containerName: string,
): SandboxRegistryRow | null {
  return (
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<SandboxRegistryDatabase>(db)
        .selectFrom("sandbox_registry_entries")
        .selectAll()
        .where("registry_kind", "=", kind)
        .where("container_name", "=", containerName)
        .limit(1),
    ).rows[0] ?? null
  );
}

export function readSandboxRegistryInDatabase(db: DatabaseSync): SandboxRegistryEntry[] {
  return readRegistryRows(db, "container")
    .map(rowToContainerEntry)
    .filter((entry): entry is SandboxRegistryEntry => entry !== null);
}

export function readSandboxRuntimeIdsInDatabase(
  db: DatabaseSync,
  filter: { backendId: string; scopeKey: string },
): string[] {
  return readRegistryRows(db, "container", filter)
    .map(rowToContainerEntry)
    .filter((entry): entry is SandboxRegistryEntry => entry !== null)
    .map((entry) => entry.containerName);
}

export function readSandboxBrowserRegistryInDatabase(
  db: DatabaseSync,
): SandboxBrowserRegistryEntry[] {
  return readRegistryRows(db, "browser")
    .map(rowToBrowserEntry)
    .filter((entry): entry is SandboxBrowserRegistryEntry => entry !== null);
}
