import { randomUUID } from "node:crypto";
import { getDb } from "./index.js";

// ── Instance types ──────────────────────────────────────────────

export type DeviceCredentials = {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  publicKeyBase64Url: string;
};

export type Instance = {
  id: string;
  name: string;
  gatewayUrl: string;
  gatewayToken: string;
  bridgeUrl: string;
  containerId: string | null;
  deviceCredentials: DeviceCredentials | null;
  createdAt: number;
};

type InstanceRow = {
  id: string;
  name: string;
  gateway_url: string;
  gateway_token: string;
  bridge_url: string;
  container_id: string | null;
  device_credentials: string | null;
  created_at: number;
};

function rowToInstance(row: InstanceRow): Instance {
  return {
    id: row.id,
    name: row.name,
    gatewayUrl: row.gateway_url,
    gatewayToken: row.gateway_token,
    bridgeUrl: row.bridge_url,
    containerId: row.container_id,
    deviceCredentials: row.device_credentials ? JSON.parse(row.device_credentials) : null,
    createdAt: row.created_at,
  };
}

// ── Connection types ──────────────────────────────────────────

export type Connection = {
  id: string;
  instanceId: string;
  provider: string;
  externalId: string;
  externalName: string | null;
  credentials: Record<string, unknown>;
  connectedAt: number;
};

type ConnectionRow = {
  id: string;
  instance_id: string;
  provider: string;
  external_id: string;
  external_name: string | null;
  credentials: string;
  connected_at: number;
};

function rowToConnection(row: ConnectionRow): Connection {
  return {
    id: row.id,
    instanceId: row.instance_id,
    provider: row.provider,
    externalId: row.external_id,
    externalName: row.external_name,
    credentials: JSON.parse(row.credentials),
    connectedAt: row.connected_at,
  };
}

// ── EventLog types ──────────────────────────────────────────

export type EventLog = {
  id: number;
  instanceId: string | null;
  connectionId: string | null;
  provider: string;
  externalId: string | null;
  eventType: string;
  status: string;
  responseStatus: number | null;
  latencyMs: number | null;
  createdAt: number;
};

type EventLogRow = {
  id: number;
  instance_id: string | null;
  connection_id: string | null;
  provider: string;
  external_id: string | null;
  event_type: string;
  status: string;
  response_status: number | null;
  latency_ms: number | null;
  created_at: number;
};

function rowToEventLog(row: EventLogRow): EventLog {
  return {
    id: row.id,
    instanceId: row.instance_id,
    connectionId: row.connection_id,
    provider: row.provider,
    externalId: row.external_id,
    eventType: row.event_type,
    status: row.status,
    responseStatus: row.response_status,
    latencyMs: row.latency_ms,
    createdAt: row.created_at,
  };
}

// ── Instance CRUD ───────────────────────────────────────────────

export function createInstance(params: {
  name: string;
  gatewayUrl: string;
  gatewayToken: string;
  bridgeUrl: string;
  containerId?: string | null;
  deviceCredentials?: DeviceCredentials | null;
}): Instance {
  const id = randomUUID();
  const createdAt = Date.now();
  const deviceCredJson = params.deviceCredentials ? JSON.stringify(params.deviceCredentials) : null;
  getDb()
    .prepare(
      `INSERT INTO instances (id, name, gateway_url, gateway_token, bridge_url, container_id, device_credentials, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      params.name,
      params.gatewayUrl,
      params.gatewayToken,
      params.bridgeUrl,
      params.containerId ?? null,
      deviceCredJson,
      createdAt,
    );

  return {
    id,
    ...params,
    containerId: params.containerId ?? null,
    deviceCredentials: params.deviceCredentials ?? null,
    createdAt,
  };
}

export function getInstance(id: string): Instance | undefined {
  const row = getDb().prepare("SELECT * FROM instances WHERE id = ?").get(id) as
    | InstanceRow
    | undefined;
  return row ? rowToInstance(row) : undefined;
}

export function listInstances(): Instance[] {
  const rows = getDb()
    .prepare("SELECT * FROM instances ORDER BY created_at DESC")
    .all() as InstanceRow[];
  return rows.map(rowToInstance);
}

export function updateInstanceContainerId(id: string, containerId: string | null): boolean {
  const result = getDb()
    .prepare("UPDATE instances SET container_id = ? WHERE id = ?")
    .run(containerId, id);
  return result.changes > 0;
}

export function updateInstanceUrls(id: string, gatewayUrl: string, bridgeUrl: string): boolean {
  const result = getDb()
    .prepare("UPDATE instances SET gateway_url = ?, bridge_url = ? WHERE id = ?")
    .run(gatewayUrl, bridgeUrl, id);
  return result.changes > 0;
}

export function deleteInstance(id: string): boolean {
  const db = getDb();
  db.prepare("DELETE FROM connections WHERE instance_id = ?").run(id);
  const result = db.prepare("DELETE FROM instances WHERE id = ?").run(id);
  return result.changes > 0;
}

// ── Connection CRUD ─────────────────────────────────────────────

export function upsertConnection(params: {
  instanceId: string;
  provider: string;
  externalId: string;
  externalName?: string | null;
  credentials: Record<string, unknown>;
}): Connection {
  const connectedAt = Date.now();
  const credJson = JSON.stringify(params.credentials);

  const existing = getDb()
    .prepare("SELECT id FROM connections WHERE provider = ? AND external_id = ?")
    .get(params.provider, params.externalId) as { id: string } | undefined;

  if (existing) {
    getDb()
      .prepare(
        `UPDATE connections SET instance_id = ?, external_name = ?, credentials = ?, connected_at = ?
         WHERE id = ?`,
      )
      .run(params.instanceId, params.externalName ?? null, credJson, connectedAt, existing.id);

    return {
      id: existing.id,
      instanceId: params.instanceId,
      provider: params.provider,
      externalId: params.externalId,
      externalName: params.externalName ?? null,
      credentials: params.credentials,
      connectedAt,
    };
  }

  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO connections (id, instance_id, provider, external_id, external_name, credentials, connected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      params.instanceId,
      params.provider,
      params.externalId,
      params.externalName ?? null,
      credJson,
      connectedAt,
    );

  return {
    id,
    instanceId: params.instanceId,
    provider: params.provider,
    externalId: params.externalId,
    externalName: params.externalName ?? null,
    credentials: params.credentials,
    connectedAt,
  };
}

export function getConnectionByProviderAndExternalId(
  provider: string,
  externalId: string,
): Connection | undefined {
  const row = getDb()
    .prepare("SELECT * FROM connections WHERE provider = ? AND external_id = ?")
    .get(provider, externalId) as ConnectionRow | undefined;
  return row ? rowToConnection(row) : undefined;
}

export function listConnections(): Connection[] {
  const rows = getDb()
    .prepare("SELECT * FROM connections ORDER BY connected_at DESC")
    .all() as ConnectionRow[];
  return rows.map(rowToConnection);
}

export function listConnectionsByInstance(instanceId: string): Connection[] {
  const rows = getDb()
    .prepare("SELECT * FROM connections WHERE instance_id = ? ORDER BY connected_at DESC")
    .all(instanceId) as ConnectionRow[];
  return rows.map(rowToConnection);
}

export function deleteConnection(id: string): boolean {
  const result = getDb().prepare("DELETE FROM connections WHERE id = ?").run(id);
  return result.changes > 0;
}

// ── Event Log ───────────────────────────────────────────────────

export function insertEventLog(params: {
  instanceId?: string | null;
  connectionId?: string | null;
  provider: string;
  externalId?: string | null;
  eventType: string;
  status: string;
  responseStatus?: number | null;
  latencyMs?: number | null;
}): EventLog {
  const createdAt = Date.now();
  const result = getDb()
    .prepare(
      `INSERT INTO event_log (instance_id, connection_id, provider, external_id, event_type, status, response_status, latency_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.instanceId ?? null,
      params.connectionId ?? null,
      params.provider,
      params.externalId ?? null,
      params.eventType,
      params.status,
      params.responseStatus ?? null,
      params.latencyMs ?? null,
      createdAt,
    );

  return {
    id: result.lastInsertRowid as number,
    instanceId: params.instanceId ?? null,
    connectionId: params.connectionId ?? null,
    provider: params.provider,
    externalId: params.externalId ?? null,
    eventType: params.eventType,
    status: params.status,
    responseStatus: params.responseStatus ?? null,
    latencyMs: params.latencyMs ?? null,
    createdAt,
  };
}

export function listEventLogs(filters?: {
  instanceId?: string;
  provider?: string;
  status?: string;
  limit?: number;
  offset?: number;
}): { events: EventLog[]; total: number } {
  const conditions: string[] = [];
  const bindValues: unknown[] = [];

  if (filters?.instanceId) {
    conditions.push("instance_id = ?");
    bindValues.push(filters.instanceId);
  }
  if (filters?.provider) {
    conditions.push("provider = ?");
    bindValues.push(filters.provider);
  }
  if (filters?.status) {
    conditions.push("status = ?");
    bindValues.push(filters.status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filters?.limit ?? 50;
  const offset = filters?.offset ?? 0;

  const total = (
    getDb()
      .prepare(`SELECT COUNT(*) as count FROM event_log ${where}`)
      .get(...bindValues) as { count: number }
  ).count;

  const rows = getDb()
    .prepare(`SELECT * FROM event_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...bindValues, limit, offset) as EventLogRow[];

  return { events: rows.map(rowToEventLog), total };
}
