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
  /** 时序过滤：按对象的某个 ISO-8601 字符串字段（或 _createdAt）过滤时间范围 */
  time_range?: {
    /** 要过滤的字段名，默认 "_createdAt" */
    field?: string;
    /** ISO-8601 起始（含），如 "2026-05-01T00:00:00Z" */
    from?: string;
    /** ISO-8601 截止（含），如 "2026-05-31T23:59:59Z" */
    to?: string;
  };
}

export type AggregationPeriod = "hour" | "day" | "week" | "month";
export type AggregationFn = "count" | "sum" | "avg" | "min" | "max";

export interface TimeSeriesQueryOptions {
  /** 要聚合的时间字段，默认 "_createdAt" */
  time_field?: string;
  /** 时间范围（同 ObjectQueryOptions.time_range） */
  from?: string;
  to?: string;
  /** 分组粒度，默认 "day" */
  group_by_period?: AggregationPeriod;
  /** 聚合函数，默认 "count" */
  aggregate_fn?: AggregationFn;
  /** 当 aggregate_fn != "count" 时，指定要聚合的数字字段 */
  aggregate_field?: string;
  /** 额外的属性过滤（同 ObjectQueryOptions.filter） */
  filter?: Record<string, unknown>;
}

export interface TimeSeriesBucket {
  /** 时间桶标签，如 "2026-05-01"（day）、"2026-05-01T08"（hour）、"2026-W20"（week）、"2026-05"（month） */
  period: string;
  value: number;
  count: number;
}

export interface TimeSeriesResult {
  type_name: string;
  group_by_period: AggregationPeriod;
  aggregate_fn: AggregationFn;
  aggregate_field?: string;
  from?: string;
  to?: string;
  buckets: TimeSeriesBucket[];
  total_count: number;
  total_value: number;
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
  /**
   * 时序聚合查询：按时间字段将对象分桶并聚合数值。
   * 适用于跨期趋势分析（日/周/月报对比、绩效曲线等）。
   */
  queryTimeSeries(typeName: string, opts?: TimeSeriesQueryOptions): Promise<TimeSeriesResult>;
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
  /** Validate FSM transition (action, currentState) → allowed + nextState. */
  validateFsmTransition?: (
    typeName: string,
    action: string,
    currentState: string,
  ) => { allowed: boolean; nextState?: string; reason?: string };
  /** Called after create/update/upsert when type is a policy object (e.g. RbacPolicy). */
  onPolicyWrite?: (typeName: string) => void;
};

function notifyPolicyWrite(opts: ObjectStoreOptions | undefined, typeName: string): void {
  if (typeName === "RbacPolicy" || typeName === "IngressPolicy") {
    opts?.onPolicyWrite?.(typeName);
  }
}

// ── Time-series helpers ─────────────────────────────────────────────────

function periodKey(ts: string | Date, granularity: AggregationPeriod): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) {
    return "unknown";
  }
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  const hr = String(d.getUTCHours()).padStart(2, "0");
  switch (granularity) {
    case "hour":
      return `${y}-${mo}-${da}T${hr}`;
    case "day":
      return `${y}-${mo}-${da}`;
    case "week": {
      // ISO week number
      const jan1 = new Date(Date.UTC(y, 0, 1));
      const weekNo = Math.ceil(
        ((d.getTime() - jan1.getTime()) / 86400000 + jan1.getUTCDay() + 1) / 7,
      );
      return `${y}-W${String(weekNo).padStart(2, "0")}`;
    }
    case "month":
      return `${y}-${mo}`;
  }
}

function applyAggFn(fn: AggregationFn, values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  switch (fn) {
    case "count":
      return values.length;
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    case "avg":
      return values.reduce((a, b) => a + b, 0) / values.length;
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
  }
}

function withinTimeRange(
  obj: CwObject,
  timeField: string,
  from: string | undefined,
  to: string | undefined,
): boolean {
  const raw = timeField === "_createdAt" ? obj._createdAt : obj[timeField];
  if (raw == null) {
    return false;
  }
  const ts = raw instanceof Date ? raw.toISOString() : String(raw);
  if (from && ts < from) {
    return false;
  }
  if (to && ts > to) {
    return false;
  }
  return true;
}

export function createObjectStore(db: CwDatabase, opts?: ObjectStoreOptions): ObjectStore {
  const selectByType = db.prepare(
    "SELECT id, type_name, data, version, created_at, updated_at FROM cw_objects WHERE type_name = ? LIMIT ? OFFSET ?",
  );
  const selectByTypeTimeRange = db.prepare(
    `SELECT id, type_name, data, version, created_at, updated_at FROM cw_objects
     WHERE type_name = ? AND created_at >= ? AND created_at <= ?
     ORDER BY created_at ASC LIMIT ?`,
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
      let items: CwObject[];

      if (opts?.time_range) {
        const tr = opts.time_range;
        const fromMs = tr.from ? new Date(tr.from).getTime() : 0;
        const toMs = tr.to ? new Date(tr.to).getTime() : Date.now() + 1e12;
        // For non-_createdAt fields we still fetch all and filter in JS
        if (!tr.field || tr.field === "_createdAt") {
          const rows = selectByTypeTimeRange.all(
            typeName,
            fromMs,
            toMs,
            limit + 1 + offset,
          ) as ObjectRow[];
          items = rows.slice(offset, offset + limit).map(rowToObject);
          const hasMore = rows.length > offset + limit;
          const filtered = opts.filter
            ? items.filter((o) => matchesFilter(o, opts.filter!))
            : items;
          return { items: filtered, nextCursor: hasMore ? String(offset + limit) : undefined };
        }
        // field != _createdAt: load broader set and filter in memory
        const rows = selectByType.all(typeName, 2000, 0) as ObjectRow[];
        items = rows.map(rowToObject).filter((o) => withinTimeRange(o, tr.field!, tr.from, tr.to));
      } else {
        const rows = selectByType.all(typeName, limit + 1, offset) as ObjectRow[];
        items = rows.slice(0, limit).map(rowToObject);
        const filtered = opts?.filter ? items.filter((o) => matchesFilter(o, opts.filter!)) : items;
        const nextCursor = rows.length > limit ? String(offset + limit) : undefined;
        return { items: filtered, nextCursor };
      }

      const filtered = opts?.filter ? items.filter((o) => matchesFilter(o, opts.filter!)) : items;
      const page = filtered.slice(offset, offset + limit);
      const nextCursor = filtered.length > offset + limit ? String(offset + limit) : undefined;
      return { items: page, nextCursor };
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
        ...payload,
        _type: typeName,
        _version: 1,
        _createdAt: new Date(now),
        _updatedAt: new Date(now),
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

      // FSM transition guard — check if the action is allowed from the current state
      if (opts?.validateFsmTransition) {
        // Try to find the FSM state field from the object
        const stateValue = (() => {
          // look for common state field names
          for (const key of ["status", "state", "fsm_state"]) {
            if (typeof obj[key] === "string") {
              return { field: key, value: obj[key] as string };
            }
          }
          return null;
        })();
        if (stateValue) {
          const check = opts.validateFsmTransition(typeName, actionType, stateValue.value);
          if (!check.allowed) {
            throw new Error(
              `FSM transition denied for ${typeName}/${id}: ${check.reason ?? `action "${actionType}" not allowed from state "${stateValue.value}"`}`,
            );
          }
          // If FSM defines a next state, apply it automatically to the patch
          if (check.nextState && check.nextState !== stateValue.value) {
            (params as Record<string, unknown>)[stateValue.field] = check.nextState;
          }
        }
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
        return { status: "ok", ...wo };
      }
      // Unknown action — report as unsupported rather than silently echoing params
      const strict = process.env.CLAWORKS_STRICT_ACTIONS === "1";
      const msg = `unsupported action '${actionType}' on type '${typeName}' (object: ${id})`;
      if (strict) {
        throw new Error(msg);
      }
      return { status: "unsupported", actionType, typeName, objectId: id, message: msg };
    },

    async queryTimeSeries(typeName, tsOpts) {
      const granularity: AggregationPeriod = tsOpts?.group_by_period ?? "day";
      const aggFn: AggregationFn = tsOpts?.aggregate_fn ?? "count";
      const timeField = tsOpts?.time_field ?? "_createdAt";
      const aggField = tsOpts?.aggregate_field;

      // Fetch all matching rows (time + filter pre-screen via DB when possible)
      const fromMs = tsOpts?.from ? new Date(tsOpts.from).getTime() : 0;
      const toMs = tsOpts?.to ? new Date(tsOpts.to).getTime() : Date.now() + 1e12;
      const rows = selectByTypeTimeRange.all(typeName, fromMs, toMs, 5000) as ObjectRow[];
      let items = rows.map(rowToObject);

      if (tsOpts?.filter) {
        items = items.filter((o) => matchesFilter(o, tsOpts.filter!));
      }

      // For non-_createdAt time fields, re-filter by the specified field
      if (timeField !== "_createdAt") {
        items = items.filter((o) => withinTimeRange(o, timeField, tsOpts?.from, tsOpts?.to));
      }

      // Group into buckets
      const bucketMap = new Map<string, number[]>();
      for (const obj of items) {
        const raw = timeField === "_createdAt" ? obj._createdAt : obj[timeField];
        if (raw == null) {
          continue;
        }
        const key = periodKey(raw instanceof Date ? raw : String(raw), granularity);
        if (!bucketMap.has(key)) {
          bucketMap.set(key, []);
        }
        const numVal = aggFn === "count" ? 1 : aggField ? Number(obj[aggField] ?? 0) : 1;
        bucketMap.get(key)!.push(numVal);
      }

      const buckets: TimeSeriesBucket[] = [...bucketMap.entries()]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([period, vals]) => ({
          period,
          value: applyAggFn(aggFn, vals),
          count: vals.length,
        }));

      const totalValue = buckets.reduce((s, b) => s + b.value, 0);
      const totalCount = items.length;

      return {
        type_name: typeName,
        group_by_period: granularity,
        aggregate_fn: aggFn,
        aggregate_field: aggField,
        from: tsOpts?.from,
        to: tsOpts?.to,
        buckets,
        total_count: totalCount,
        total_value: totalValue,
      };
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
