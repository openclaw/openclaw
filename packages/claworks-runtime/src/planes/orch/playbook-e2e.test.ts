/**
 * Playbook Engine E2E 集成测试（第十轮优化，场景 A–E）
 *
 * 使用内嵌 Playbook 定义 + stub 依赖，无需真实 LLM / 数据库。
 * 文件路径：src/planes/orch/playbook-e2e.test.ts
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createActionRegistry } from "../../kernel/action-registry.js";
import { CW_EVENTS } from "../../kernel/event-names.js";
import { openDatabase } from "../data/db.js";
import { createKnowledgeBase } from "../data/knowledge-base.js";
import { createObjectStore } from "../data/object-store.js";
import { createHitlGate } from "./hitl-gate.js";
import { createPlaybookEngine } from "./playbook-engine.js";
import type { PlaybookDefinition } from "./playbook-types.js";
import type { LlmCompleteFn } from "./step-executor.js";

// ─── 工厂助手 ────────────────────────────────────────────────────────────────

function makeEngine(
  overrides: {
    llmComplete?: LlmCompleteFn;
    publishEvent?: (
      type: string,
      source: string,
      payload: Record<string, unknown>,
      correlationId?: string,
    ) => Promise<void>;
    actionRegistry?: ReturnType<typeof createActionRegistry>;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "cw-e2e-"));
  const { db, close } = openDatabase(`sqlite://${join(dir, "t.db")}`);

  const engine = createPlaybookEngine({
    db,
    objectStore: createObjectStore(db),
    kb: createKnowledgeBase(),
    robot: { name: "e2e-bot", role: "monolith", version: "0", endpoint: "http://127.0.0.1:18800" },
    hitl: createHitlGate(),
    actionRegistry: overrides.actionRegistry,
    ...overrides,
  });

  return { engine, close };
}

function loadSingle(engine: ReturnType<typeof makeEngine>["engine"], def: PlaybookDefinition) {
  return engine.loadFromPacks([
    {
      manifest: {
        id: "e2e",
        name: "E2E Test Pack",
        version: "1",
        license: "MIT",
        provides: { objectTypes: [], playbooks: [def.id], actionTypes: [] },
      },
      path: "/tmp",
      objectTypes: [],
      playbooks: [def],
    },
  ]);
}

/** Playbook 运行结束时会额外发布 playbook.run.completed；测试只关心步骤级 publish_event。 */
function stepPublishedEvents<T extends { type: string }>(published: T[]): T[] {
  return published.filter((e) => e.type !== CW_EVENTS.PLAYBOOK_RUN_COMPLETED);
}

// ─── 场景 A：publish_event 步骤 → 事件发布验证 ─────────────────────────────

describe("场景 A: publish_event 步骤正确触发下游事件", () => {
  it("playbook 单步 publish_event，事件类型和 payload 正确发布", async () => {
    const published: Array<{ type: string; payload: Record<string, unknown> }> = [];

    const { engine, close } = makeEngine({
      publishEvent: async (type, _source, payload) => {
        published.push({ type, payload });
      },
    });

    const def: PlaybookDefinition = {
      id: "pub_flow",
      name: "PublishTest",
      pack: "e2e",
      trigger: { kind: "manual" },
      priority: 0,
      steps: [
        {
          kind: "publish_event",
          id: "evt_step",
          eventType: "downstream.triggered",
          payload: { source_msg: "hello", priority: 1 },
        },
      ],
    };

    await loadSingle(engine, def);
    const run = await engine.trigger("pub_flow", { user: "alice" });

    expect(run.status).toBe("completed");
    expect(stepPublishedEvents(published)).toHaveLength(1);
    expect(stepPublishedEvents(published)[0]!.type).toBe("downstream.triggered");
    expect(stepPublishedEvents(published)[0]!.payload.source_msg).toBe("hello");

    close();
  });

  it("多步骤：action → publish_event，两步均成功，事件包含正确类型", async () => {
    const published: string[] = [];
    const actionReg = createActionRegistry();
    actionReg.registerAll("e2e", { noop_action: async () => ({ status: "ok", done: true }) });

    const { engine, close } = makeEngine({
      publishEvent: async (type) => {
        published.push(type);
      },
      actionRegistry: actionReg,
    });

    const def: PlaybookDefinition = {
      id: "action_then_pub_flow",
      name: "ActionThenPub",
      pack: "e2e",
      trigger: { kind: "manual" },
      priority: 0,
      steps: [
        {
          kind: "action",
          id: "step_noop",
          actionApiName: "noop_action",
          params: {},
        },
        {
          kind: "publish_event",
          id: "step_pub",
          eventType: "test.rule_matched",
          payload: { rule_id: "urgent_rule" },
        },
      ],
    };

    await loadSingle(engine, def);
    const run = await engine.trigger("action_then_pub_flow", {});

    expect(run.status).toBe("completed");
    expect(published).toContain("test.rule_matched");

    close();
  });
});

// ─── 场景 B：steps 结果跨步骤引用 ─────────────────────────────────────────

describe("场景 B: action 输出通过 steps[id][result] 被后续步骤引用", () => {
  it("步骤 A 的 action 结果存入 steps，步骤 B 通过模板插值引用 value 字段", async () => {
    const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const actionReg = createActionRegistry();

    // 步骤 A：返回包含 value 字段的结果
    actionReg.registerAll("e2e", { produce_value: async () => ({ value: "result_from_A" }) });

    const { engine, close } = makeEngine({
      publishEvent: async (type, _src, payload) => {
        published.push({ type, payload });
      },
      actionRegistry: actionReg,
    });

    const def: PlaybookDefinition = {
      id: "ref_flow",
      name: "StepRef",
      pack: "e2e",
      trigger: { kind: "manual" },
      priority: 0,
      steps: [
        {
          kind: "action",
          id: "step_a",
          actionApiName: "produce_value",
          params: {},
          // result 自动写入 steps['step_a']['result'] = { value: "result_from_A" }
        },
        {
          kind: "publish_event",
          id: "step_b",
          eventType: "ref.test",
          payload: {
            // 通过 steps['step_a']['result'].get('value') 引用 A 的输出
            resolved_value: "{{ steps['step_a']['result'].get('value') }}",
          },
        },
      ],
    };

    await loadSingle(engine, def);
    const run = await engine.trigger("ref_flow", {});

    expect(run.status).toBe("completed");
    expect(stepPublishedEvents(published)).toHaveLength(1);
    expect(stepPublishedEvents(published)[0]!.payload.resolved_value).toBe("result_from_A");

    close();
  });

  it("LLM 步骤 output 变量在后续步骤中通过模板引用", async () => {
    const published: Array<{ type: string; payload: Record<string, unknown> }> = [];

    const { engine, close } = makeEngine({
      llmComplete: async () => ({ text: "FIXED_VALUE" }),
      publishEvent: async (type, _src, payload) => {
        published.push({ type, payload });
      },
    });

    const def: PlaybookDefinition = {
      id: "llm_ref_flow",
      name: "LlmRef",
      pack: "e2e",
      trigger: { kind: "manual" },
      priority: 0,
      steps: [
        {
          kind: "llm",
          id: "step_a",
          prompt: "return value",
          output: "step_a_out", // ctx.variables['step_a_out'] = "FIXED_VALUE"
        },
        {
          kind: "publish_event",
          id: "step_b",
          eventType: "llm_ref.test",
          payload: { resolved_value: "{{ step_a_out }}" },
        },
      ],
    };

    await loadSingle(engine, def);
    const run = await engine.trigger("llm_ref_flow", {});

    expect(run.status).toBe("completed");
    expect(published[0]!.payload.resolved_value).toBe("FIXED_VALUE");

    close();
  });
});

// ─── 场景 C：Playbook 全局超时 ────────────────────────────────────────────

describe("场景 C: Playbook 全局超时", () => {
  it("timeout_seconds 极小，run.status === 'failed' 且 error 包含 timeout", async () => {
    const { engine, close } = makeEngine({
      llmComplete: async () => {
        // 人工延时保证超时触发
        await new Promise((res) => setTimeout(res, 300));
        return { text: "delayed" };
      },
    });

    const def: PlaybookDefinition = {
      id: "timeout_flow",
      name: "Timeout",
      pack: "e2e",
      trigger: { kind: "manual" },
      priority: 0,
      timeout_seconds: 0.05, // 50ms 超时
      steps: [
        {
          kind: "llm",
          id: "slow_step",
          prompt: "slow prompt",
          output: "slow_out",
        },
      ],
    };

    await loadSingle(engine, def);
    const run = await engine.trigger("timeout_flow", {});

    expect(run.status).toBe("failed");
    expect(run.error?.toLowerCase()).toMatch(/timeout/);

    close();
  });
});

// ─── 场景 D：并发限制 ────────────────────────────────────────────────────

describe("场景 D: 并发限制防止资源滥用", () => {
  it("同时触发 10 次，超出上限(8)的 run 状态 failed 含 concurrency_limit_exceeded", async () => {
    const { engine, close } = makeEngine({
      llmComplete: async () => {
        await new Promise((res) => setTimeout(res, 200));
        return { text: "done" };
      },
    });

    const def: PlaybookDefinition = {
      id: "concurrent_flow",
      name: "Concurrent",
      pack: "e2e",
      trigger: { kind: "manual" },
      priority: 0,
      steps: [
        {
          kind: "llm",
          id: "llm_step",
          prompt: "concurrent work",
          output: "out",
        },
      ],
    };

    await loadSingle(engine, def);

    // 10 次并发触发（不等待单个结果，全部同时发起）
    const results = await Promise.all(
      Array.from({ length: 10 }, () => engine.trigger("concurrent_flow", {})),
    );

    const failed = results.filter(
      (r) => r.status === "failed" && r.error?.includes("concurrency_limit_exceeded"),
    );
    expect(failed.length).toBeGreaterThan(0);

    // 所有结果都有明确的 status
    for (const r of results) {
      expect(["completed", "failed"]).toContain(r.status);
    }

    close();
  });
});

// ─── 场景 E：condition 过滤 ───────────────────────────────────────────────

describe("场景 E: 步骤级 condition 过滤", () => {
  it("count=5，condition '{{ count }} > 3' 为 true，步骤 B 被执行", async () => {
    const published: string[] = [];

    const { engine, close } = makeEngine({
      publishEvent: async (type) => {
        published.push(type);
      },
    });

    const def: PlaybookDefinition = {
      id: "condition_flow_true",
      name: "Condition True",
      pack: "e2e",
      trigger: { kind: "manual" },
      priority: 0,
      steps: [
        {
          kind: "publish_event",
          id: "step_a",
          eventType: "internal.a",
          payload: {},
        },
        {
          kind: "publish_event",
          id: "step_b",
          eventType: "internal.b_executed",
          payload: {},
          // trigger input 中的 count 注入为 variables，插值后 "5 > 3" → true
          condition: "{{ count }} > 3",
        },
      ],
    };

    await loadSingle(engine, def);
    const run = await engine.trigger("condition_flow_true", { count: 5 });

    expect(run.status).toBe("completed");
    expect(published).toContain("internal.b_executed");

    close();
  });

  it("count=1，condition '{{ count }} > 3' 为 false，步骤 B 被跳过", async () => {
    const published: string[] = [];

    const { engine, close } = makeEngine({
      publishEvent: async (type) => {
        published.push(type);
      },
    });

    const def: PlaybookDefinition = {
      id: "condition_flow_false",
      name: "Condition False",
      pack: "e2e",
      trigger: { kind: "manual" },
      priority: 0,
      steps: [
        {
          kind: "publish_event",
          id: "step_a",
          eventType: "internal.a",
          payload: {},
        },
        {
          kind: "publish_event",
          id: "step_b",
          eventType: "internal.b_executed",
          payload: {},
          condition: "{{ count }} > 3",
        },
      ],
    };

    await loadSingle(engine, def);
    const run = await engine.trigger("condition_flow_false", { count: 1 });

    expect(run.status).toBe("completed");
    expect(published).not.toContain("internal.b_executed");
    expect(published).toContain("internal.a");

    close();
  });

  it("action 步骤 A 的 count 字段通过 float(steps[...]) > 3 条件正确引用", async () => {
    const published: string[] = [];
    const actionReg = createActionRegistry();

    actionReg.registerAll("e2e", {
      make_count: async (params) => ({ count: params.count_value ?? 5 }),
    });

    const { engine, close } = makeEngine({
      publishEvent: async (type) => {
        published.push(type);
      },
      actionRegistry: actionReg,
    });

    const def: PlaybookDefinition = {
      id: "steps_cond_flow",
      name: "Steps Condition",
      pack: "e2e",
      trigger: { kind: "manual" },
      priority: 0,
      steps: [
        {
          kind: "action",
          id: "step_a",
          actionApiName: "make_count",
          params: { count_value: 5 },
          // steps['step_a']['result'] = { count: 5 }
        },
        {
          kind: "publish_event",
          id: "step_b",
          eventType: "steps_cond.passed",
          payload: {},
          // condition 使用 floatCmp 模式
          condition: "float(steps['step_a']['result'].get('count', 0)) > 3",
        },
      ],
    };

    await loadSingle(engine, def);
    const run = await engine.trigger("steps_cond_flow", {});

    expect(run.status).toBe("completed");
    expect(published).toContain("steps_cond.passed");

    close();
  });

  it("steps count=1 时条件 float(steps[...]) > 3 为 false，步骤 B 跳过", async () => {
    const published: string[] = [];
    const actionReg = createActionRegistry();

    actionReg.registerAll("e2e", { make_count_low: async () => ({ count: 1 }) });

    const { engine, close } = makeEngine({
      publishEvent: async (type) => {
        published.push(type);
      },
      actionRegistry: actionReg,
    });

    const def: PlaybookDefinition = {
      id: "steps_cond_flow_false",
      name: "Steps Condition False",
      pack: "e2e",
      trigger: { kind: "manual" },
      priority: 0,
      steps: [
        {
          kind: "action",
          id: "step_a",
          actionApiName: "make_count_low",
          params: {},
        },
        {
          kind: "publish_event",
          id: "step_b",
          eventType: "steps_cond.skipped",
          payload: {},
          condition: "float(steps['step_a']['result'].get('count', 0)) > 3",
        },
      ],
    };

    await loadSingle(engine, def);
    const run = await engine.trigger("steps_cond_flow_false", {});

    expect(run.status).toBe("completed");
    expect(published).not.toContain("steps_cond.skipped");

    close();
  });
});
