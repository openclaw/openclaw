/**
 * playbook-simulator.ts — Playbook 干跑模拟器
 *
 * 设计原则（对齐 OpenClaw 依赖注入风格）：
 *   - 不修改 PlaybookEngine 接口，不传 dryRun flag
 *   - 通过替换注入的 ObjectStore 为纯内存 MockObjectStore 实现隔离
 *   - PlaybookEngine 执行时所有 object.* 操作均写入内存，不触碰真实 DB
 *   - 输出 SimulateResult：步骤日志、副作用列表、错误
 *
 * 用法（REST）：POST /v1/playbooks/:id/simulate
 * 用法（代码）：const sim = createPlaybookSimulator(engine); await sim.simulate("my-playbook", ctx)
 */

import type { CwObject, ObjectStore } from "../data/object-store.js";
import type { PlaybookStepContext } from "./playbook-types.js";

// ── MockObjectStore（纯内存）──────────────────────────────────────────────

type MockEntry = CwObject;

export function createMockObjectStore(): ObjectStore & { dumpAll(): Record<string, MockEntry[]> } {
  const store = new Map<string, Map<string, MockEntry>>();

  function getTypeMap(typeName: string): Map<string, MockEntry> {
    if (!store.has(typeName)) store.set(typeName, new Map());
    return store.get(typeName)!;
  }

  function makeEntry(typeName: string, id: string, data: Record<string, unknown>): MockEntry {
    const now = new Date();
    return {
      ...data,
      id,
      _type: typeName,
      _version: 1,
      _createdAt: now,
      _updatedAt: now,
    };
  }

  return {
    async query(typeName, opts) {
      const map = getTypeMap(typeName);
      let items = [...map.values()];
      if (opts?.filter) {
        for (const [k, v] of Object.entries(opts.filter)) {
          items = items.filter((item) => item[k] === v);
        }
      }
      const limit = opts?.limit ?? 50;
      return { items: items.slice(0, limit) };
    },

    async get(typeName, id) {
      return getTypeMap(typeName).get(id) ?? null;
    },

    async create(typeName, data, _ctx) {
      const id = String(data.id ?? `mock_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
      const entry = makeEntry(typeName, id, { ...data, id });
      getTypeMap(typeName).set(id, entry);
      return entry;
    },

    async update(typeName, id, patch) {
      const map = getTypeMap(typeName);
      const existing = map.get(id) ?? makeEntry(typeName, id, {});
      const now = new Date();
      const updated: MockEntry = {
        ...existing,
        ...patch,
        id,
        _type: typeName,
        _version: (existing._version as number) + 1,
        _createdAt: existing._createdAt,
        _updatedAt: now,
      };
      map.set(id, updated);
      return updated;
    },

    async upsert(typeName, id, data) {
      const existing = getTypeMap(typeName).get(id);
      if (existing) {
        return this.update(typeName, id, data);
      }
      return this.create(typeName, { ...data, id });
    },

    async delete(typeName, id) {
      getTypeMap(typeName).delete(id);
    },

    async executeAction(typeName, id, actionType, params, _ctx) {
      return { status: "mock_ok", typeName, id, actionType, params };
    },

    async queryTimeSeries(typeName, opts) {
      return {
        type_name: typeName,
        group_by_period: opts?.group_by_period ?? "day",
        aggregate_fn: opts?.aggregate_fn ?? "count",
        aggregate_field: opts?.aggregate_field,
        from: opts?.from,
        to: opts?.to,
        buckets: [],
        total_count: 0,
        total_value: 0,
      };
    },

    dumpAll() {
      const result: Record<string, MockEntry[]> = {};
      for (const [type, map] of store.entries()) {
        result[type] = [...map.values()];
      }
      return result;
    },
  };
}

// ── PlaybookSimulator ─────────────────────────────────────────────────────

export interface SimulateStepLog {
  step: number;
  type: string;
  name?: string;
  status: "ok" | "error" | "skip";
  durationMs: number;
  output?: unknown;
  error?: string;
}

export interface SimulateResult {
  playbook_id: string;
  status: "ok" | "error";
  steps: SimulateStepLog[];
  side_effects: {
    objects_created: Array<{ type: string; id: string; data: Record<string, unknown> }>;
    objects_updated: Array<{ type: string; id: string }>;
    objects_deleted: Array<{ type: string; id: string }>;
    events_would_publish: string[];
    notifications_would_send: number;
  };
  error?: string;
  duration_ms: number;
}

export interface PlaybookSimulator {
  simulate(
    playbookId: string,
    initialVars?: Record<string, unknown>,
    triggerEvent?: Record<string, unknown>,
  ): Promise<SimulateResult>;
}

/**
 * 创建 PlaybookSimulator。
 *
 * @param runPlaybook 用于触发 Playbook 的函数（由外部注入，避免引入 PlaybookEngine 全量依赖）
 *   函数签名：(playbookId, vars, event, mockStore) => Promise<{ steps, error? }>
 */
export function createPlaybookSimulator(
  runPlaybook: (
    playbookId: string,
    vars: Record<string, unknown>,
    event: Record<string, unknown>,
    mockStore: ReturnType<typeof createMockObjectStore>,
  ) => Promise<{ steps: SimulateStepLog[]; error?: string }>,
): PlaybookSimulator {
  return {
    async simulate(playbookId, initialVars = {}, triggerEvent = {}) {
      const t0 = Date.now();
      const mockStore = createMockObjectStore();

      try {
        const result = await runPlaybook(playbookId, initialVars, triggerEvent, mockStore);
        const dump = mockStore.dumpAll();

        const objectsCreated = Object.entries(dump).flatMap(([type, entries]) =>
          entries.map((e) => {
            const { _type, _version, _createdAt, _updatedAt, ...fields } = e;
            return { type, id: e.id, data: fields as Record<string, unknown> };
          }),
        );

        return {
          playbook_id: playbookId,
          status: result.error ? "error" : "ok",
          steps: result.steps,
          side_effects: {
            objects_created: objectsCreated,
            objects_updated: [],
            objects_deleted: [],
            events_would_publish: result.steps
              .filter((s) => s.type === "event" || s.type === "notify")
              .map((s) => String(s.name ?? s.type)),
            notifications_would_send: result.steps.filter((s) => s.type === "notify").length,
          },
          error: result.error,
          duration_ms: Date.now() - t0,
        };
      } catch (e) {
        return {
          playbook_id: playbookId,
          status: "error",
          steps: [],
          side_effects: {
            objects_created: [],
            objects_updated: [],
            objects_deleted: [],
            events_would_publish: [],
            notifications_would_send: 0,
          },
          error: String(e),
          duration_ms: Date.now() - t0,
        };
      }
    },
  };
}
