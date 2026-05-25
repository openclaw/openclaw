import { describe, expect, it, vi } from "vitest";
import { handleAutonomyLearnOpportunity } from "./autonomy-engine.js";
import { createEvolveEngine } from "./evolve-engine.js";

function makePipelineKernel() {
  const handlers = new Map<string, Array<(payload: Record<string, unknown>) => void>>();
  const published: Array<{ type: string; source: string; payload: Record<string, unknown> }> = [];

  return {
    handlers,
    published,
    subscribe(type: string, handler: (payload: Record<string, unknown>) => void) {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
      return () => {
        handlers.set(
          type,
          (handlers.get(type) ?? []).filter((h) => h !== handler),
        );
      };
    },
    emit(type: string, payload: Record<string, unknown>) {
      for (const handler of handlers.get(type) ?? []) {
        handler(payload);
      }
    },
    publish: vi.fn(async (type: string, source: string, payload: Record<string, unknown>) => {
      published.push({ type, source, payload });
      for (const handler of handlers.get(type) ?? []) {
        handler(payload);
      }
    }),
  };
}

function makePipelineRuntime() {
  const kernel = makePipelineKernel();
  const kbIngested: Array<{ text: string; opts: unknown }> = [];

  const runtime = {
    kb: {
      ingest: vi.fn(async (text: string, opts: unknown) => {
        kbIngested.push({ text, opts });
      }),
      search: vi.fn(async (query: string, opts?: { namespace?: string }) =>
        kbIngested
          .filter(
            (d) =>
              !opts?.namespace || (d.opts as { namespace?: string })?.namespace === opts.namespace,
          )
          .filter((d) => d.text.includes(query))
          .map((d, i) => ({
            id: `kb-${i}`,
            score: 1,
            text: d.text,
            title: (d.opts as { title?: string })?.title,
          })),
      ),
    },
    kernel,
    cbrStore: {
      add: vi.fn(),
      search: vi.fn(() => []),
    },
    ruleEngine: undefined,
    capabilities: { list: () => [] },
    playbookEngine: {
      listPlaybooks: () => [],
      list: () => [],
      listRuns: async () => [],
      load: vi.fn(),
      unload: vi.fn(),
      trigger: vi.fn(async () => ({ steps: [], status: "completed" as const })),
    },
    structuredOutput: {
      complete: vi.fn(async () => ({
        data: {
          title: "E2E 草稿",
          description: "pipeline test",
          playbook_yaml: [
            "id: e2e_draft_pb",
            "name: E2E Draft",
            "trigger:",
            "  kind: event",
            "  pattern: e2e.test",
            "steps: []",
          ].join("\n"),
          required_capabilities: [],
          missing_capabilities: [],
          trigger_event: "e2e.test",
          test_event: "e2e.test",
          test_payload: {},
          confidence: 0.8,
          warnings: [],
        },
        fallback: false,
      })),
    },
    logger: vi.fn(),
    _kbIngested: kbIngested,
    _published: kernel.published,
  };

  const evolveEngine = createEvolveEngine(runtime as never);
  (runtime as { evolveEngine: typeof evolveEngine }).evolveEngine = evolveEngine;

  return { runtime, evolveEngine, kernel };
}

describe("evolve pipeline e2e", () => {
  it("proposeDraft → playbook_drafted → suggestions_ready", async () => {
    const { runtime, evolveEngine } = makePipelineRuntime();
    evolveEngine.startDraftReviewPipeline();

    await evolveEngine.proposeDraft(
      { description: "为 E2E 测试生成 Playbook" },
      { source: "e2e.test", signal: "knowledge_gap" },
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    const drafted = runtime._published.find((e) => e.type === "evolve.playbook_drafted");
    const ready = runtime._published.find((e) => e.type === "evolve.suggestions_ready");
    expect(drafted).toBeTruthy();
    expect(ready).toBeTruthy();
    expect(ready?.payload.draft_id).toBe(drafted?.payload.id);
    expect(ready?.payload.hitl_required).toBe(true);
    expect(ready?.payload.simulation).toEqual(
      expect.objectContaining({ yaml_valid: true, passed: true }),
    );
  });

  it("autonomy.learn_opportunity(knowledge_gap) 触发完整草稿审核链", async () => {
    const { runtime, evolveEngine } = makePipelineRuntime();
    evolveEngine.startDraftReviewPipeline();

    await handleAutonomyLearnOpportunity(runtime as never, {
      signal: "knowledge_gap",
      description: "未解析意图过多，需要新 Playbook",
      metadata: {
        gap_type: "knowledge_gap",
        last_input: "帮我查一下 OEE 趋势",
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const eventTypes = runtime._published.map((e) => e.type);
    expect(eventTypes).toContain("evolve.playbook_drafted");
    expect(eventTypes).toContain("evolve.suggestions_ready");
    expect(eventTypes).toContain("autonomy.learn_handled");

    const ready = runtime._published.find((e) => e.type === "evolve.suggestions_ready");
    expect(ready?.payload.signal).toBe("knowledge_gap");
    expect(ready?.payload.simulation).toEqual(expect.objectContaining({ yaml_valid: true }));
  });
});
