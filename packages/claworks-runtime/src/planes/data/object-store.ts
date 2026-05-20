import { randomUUID } from "node:crypto";
import type { PlaybookStepContext } from "../orch/playbook-types.js";
import type { CwDatabase } from "./db.js";
import { mesProductionDispatch } from "./mes-dispatch.js";
import type { ValidationResult } from "./ontology-types.js";
import { publishWorkOrderCreated } from "./work-order-events.js";

export interface CwObject {
  id: string;
  _type: string;
  _version: number;
  _createdAt: Date;
  _updatedAt: Date;
  [field: string]: unknown;
}

export interface ObjectQueryOptions {
  filter?: Record<string, unknown>;
  limit?: number;
  cursor?: string;
  orderBy?: { field: string; dir: "asc" | "desc" };
}

export interface ObjectStore {
  query(
    typeName: string,
    opts?: ObjectQueryOptions,
  ): Promise<{ items: CwObject[]; nextCursor?: string }>;
  get(typeName: string, id: string): Promise<CwObject | null>;
  create(
    typeName: string,
    data: Record<string, unknown>,
    ctx?: PlaybookStepContext,
  ): Promise<CwObject>;
  update(typeName: string, id: string, patch: Record<string, unknown>): Promise<CwObject>;
  /** 创建或更新（按 id）：存在则 patch，不存在则 create。 */
  upsert(typeName: string, id: string, data: Record<string, unknown>): Promise<CwObject>;
  delete(typeName: string, id: string): Promise<void>;
  executeAction(
    typeName: string,
    id: string,
    actionType: string,
    params: Record<string, unknown>,
    ctx: PlaybookStepContext,
  ): Promise<Record<string, unknown>>;
}

type ObjectRow = {
  id: string;
  type_name: string;
  data: string;
  version: number;
  created_at: number;
  updated_at: number;
};

export type ObjectStoreOptions = {
  validate?: (typeName: string, data: Record<string, unknown>) => ValidationResult;
  /** Called after create/update/upsert when type is a policy object (e.g. RbacPolicy). */
  onPolicyWrite?: (typeName: string) => void;
};

function notifyPolicyWrite(opts: ObjectStoreOptions | undefined, typeName: string): void {
  if (typeName === "RbacPolicy" || typeName === "IngressPolicy") {
    opts?.onPolicyWrite?.(typeName);
  }
}

export function createObjectStore(db: CwDatabase, opts?: ObjectStoreOptions): ObjectStore {
  const selectByType = db.prepare(
    "SELECT id, type_name, data, version, created_at, updated_at FROM cw_objects WHERE type_name = ? LIMIT ? OFFSET ?",
  );
  const selectOne = db.prepare(
    "SELECT id, type_name, data, version, created_at, updated_at FROM cw_objects WHERE type_name = ? AND id = ?",
  );
  const insert = db.prepare(
    "INSERT INTO cw_objects (id, type_name, data, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const updateStmt = db.prepare(
    "UPDATE cw_objects SET data = ?, version = ?, updated_at = ? WHERE type_name = ? AND id = ?",
  );
  const deleteStmt = db.prepare("DELETE FROM cw_objects WHERE type_name = ? AND id = ?");

  return {
    async query(typeName, opts) {
      const limit = opts?.limit ?? 50;
      const offset = opts?.cursor ? Number.parseInt(opts.cursor, 10) : 0;
      const rows = selectByType.all(typeName, limit + 1, offset) as ObjectRow[];
      const items = rows.slice(0, limit).map(rowToObject);
      const filtered = opts?.filter ? items.filter((o) => matchesFilter(o, opts.filter!)) : items;
      const nextCursor = rows.length > limit ? String(offset + limit) : undefined;
      return { items: filtered, nextCursor };
    },

    async get(typeName, id) {
      const row = selectOne.get(typeName, id) as ObjectRow | undefined;
      return row ? rowToObject(row) : null;
    },

    async create(typeName, data, ctx?: PlaybookStepContext) {
      const validation = opts?.validate?.(typeName, data);
      if (validation && !validation.valid) {
        const msg = validation.errors.map((e) => `${e.field}: ${e.message}`).join("; ");
        throw new Error(`Ontology validation failed for ${typeName}: ${msg}`);
      }
      const id = String(data.id ?? randomUUID());
      const now = Date.now();
      const payload = { ...data, id };
      insert.run(id, typeName, JSON.stringify(payload), 1, now, now);
      const obj = {
        id,
        _type: typeName,
        _version: 1,
        _createdAt: new Date(now),
        _updatedAt: new Date(now),
        ...payload,
      };
      if (typeName === "WorkOrder" && ctx) {
        await publishWorkOrderCreated(ctx, obj, data);
      }
      notifyPolicyWrite(opts, typeName);
      return obj;
    },

    async update(typeName, id, patch) {
      const existing = await this.get(typeName, id);
      if (!existing) {
        throw new Error(`Object not found: ${typeName}/${id}`);
      }
      const now = Date.now();
      const merged = { ...stripMeta(existing), ...patch, id };
      const version = existing._version + 1;
      updateStmt.run(JSON.stringify(merged), version, now, typeName, id);
      const updated = {
        ...merged,
        _type: typeName,
        _version: version,
        _createdAt: existing._createdAt,
        _updatedAt: new Date(now),
      };
      notifyPolicyWrite(opts, typeName);
      return updated;
    },

    async upsert(typeName, id, data) {
      const existing = await this.get(typeName, id);
      if (existing) {
        return this.update(typeName, id, { ...data, id });
      }
      return this.create(typeName, { ...data, id });
    },

    async delete(typeName, id) {
      deleteStmt.run(typeName, id);
    },

    async executeAction(typeName, id, actionType, params, ctx) {
      if (actionType === "mes_production_dispatch") {
        return await mesProductionDispatch(params);
      }

      if (actionType === "ingest_kb_text" || typeName === "_kb") {
        const text = String(params.text ?? "");
        await ctx.kb.ingest(text, {
          namespace: params.layer ? String(params.layer) : String(params.namespace ?? "default"),
          source: params.source_uri
            ? String(params.source_uri)
            : params.source
              ? String(params.source)
              : params.title
                ? String(params.title)
                : undefined,
        });
        const documentId = `kb-${Date.now()}`;
        return {
          status: "ok",
          document_id: documentId,
          title: params.title,
          station_id: params.station_id,
        };
      }

      const obj = await this.get(typeName, id);
      if (!obj) {
        throw new Error(`Object not found: ${typeName}/${id}`);
      }
      if (actionType === "acknowledge_alarm") {
        const updated = await this.update(typeName, id, {
          status: "acknowledged",
          acknowledged_by: params.acknowledged_by,
          ...(params.note ? { note: params.note } : {}),
        });
        return { status: "ok", ...updated };
      }
      if (actionType === "create_work_order") {
        const wo = await this.create(
          "WorkOrder",
          {
            ...params,
            status: params.status ?? "open",
            source: params.source ?? "playbook",
          },
          ctx,
        );
        return { status: "ok", id: wo.id, ...wo };
      }
      return { status: "ok", actionType, params, objectId: id };
    },
  };
}

function rowToObject(row: ObjectRow): CwObject {
  const data = JSON.parse(row.data) as Record<string, unknown>;
  return {
    ...data,
    id: row.id,
    _type: row.type_name,
    _version: row.version,
    _createdAt: new Date(row.created_at),
    _updatedAt: new Date(row.updated_at),
  };
}

function stripMeta(obj: CwObject): Record<string, unknown> {
  const { _type, _version, _createdAt, _updatedAt, ...rest } = obj;
  return rest;
}

function matchesFilter(obj: CwObject, filter: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(filter)) {
    if (obj[k] !== v) {
      return false;
    }
  }
  return true;
}
