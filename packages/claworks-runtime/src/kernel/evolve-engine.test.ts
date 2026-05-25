import { describe, expect, it, vi } from "vitest";
import { createCbrStore } from "../planes/data/cbr-store.js";
import { createEvolveEngine, parseEvolutionDraftText } from "./evolve-engine.js";

function makeMockKernel() {
  const handlers = new Map<string, Array<(payload: Record<string, unknown>) => void>>();
  return {
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
  };
}

function makeEvolveRuntime(
  overrides: Partial<{
    cbrStore: ReturnType<typeof createCbrStore> | undefined;
    structuredPrompt: string;
  }> = {},
) {
  const cbrStore = overrides.cbrStore ?? createCbrStore();
  const kernel = makeMockKernel();
  const capturedPrompts: string[] = [];
  const kbIngested: Array<{ text: string; opts: unknown }> = [];
  const published: Array<{ type: string; payload: Record<string, unknown> }> = [];

  const runtime = {
    cbrStore,
    kb: {
      ingest: vi.fn(async (text: string, opts: unknown) => {
        kbIngested.push({ text, opts });
      }),
      search: vi.fn(async (query: string, opts?: { namespace?: string }) => {
        return kbIngested
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
            namespace: (d.opts as { namespace?: string })?.namespace,
          }));
      }),
    },
    kernel: {
      ...kernel,
      publish: vi.fn(async (type: string, _source: string, payload: Record<string, unknown>) => {
        published.push({ type, payload });
      }),
    },
    capabilities: {
      list: () => [{ id: "notify.dispatch", description: "通知" }],
    },
    playbookEngine: {
      listPlaybooks: () => [],
      list: () => [],
      listRuns: async () => [],
      loadFromPacks: vi.fn(async () => undefined),
    },
    loadedPacks: [],
    packLoader: { load: vi.fn() },
    logger: vi.fn(),
    structuredOutput: {
      complete: vi.fn(async (prompt: string) => {
        capturedPrompts.push(prompt);
        return {
          data: {
            title: "测试方案",
            description: "测试",
            playbook_yaml: "id: test_evolved\nsteps: []",
            required_capabilities: [],
            missing_capabilities: [],
            trigger_event: "user.custom_event",
            test_event: "user.custom_event",
            test_payload: {},
            confidence: 0.9,
            warnings: [],
          },
          fallback: false,
        };
      }),
    },
    _capturedPrompts: capturedPrompts,
    _kbIngested: kbIngested,
    _published: published,
  };

  return runtime;
}

describe("EvolveEngine", () => {
  it("startAutoLearning 在 playbook.run.failed 时将失败案例写入 CbrStore", () => {
    const runtime = makeEvolveRuntime();
    const engine = createEvolveEngine(runtime as never);

    engine.startAutoLearning();
    runtime.kernel.emit("playbook.run.failed", {
      playbook_id: "alarm_handler",
      error: "objectstore.create 超时",
      duration_ms: 4200,
    });

    const cases = runtime.cbrStore!.search("alarm_handler 执行失败", 5);
    expect(cases.length).toBeGreaterThan(0);
    expect(cases[0]?.problem).toContain("alarm_handler");
    expect(cases[0]?.problem).toContain("objectstore.create 超时");
  });

  it("propose 检索 CbrStore 相似案例并注入 LLM 提示", async () => {
    const cbrStore = createCbrStore();
    cbrStore.add(
      "Playbook 'dispatch_order' 执行失败: 连接 ERP 超时",
      "失败案例已记录，供下次 propose/分析时参考。",
      { category: "playbook_failure", auto_learned: true },
    );

    const runtime = makeEvolveRuntime({ cbrStore });
    const engine = createEvolveEngine(runtime as never);

    await engine.propose({ description: "ERP 工单派发失败，需要自动重试 Playbook" });

    expect(runtime.structuredOutput.complete).toHaveBeenCalled();
    const prompt = runtime._capturedPrompts[0] ?? "";
    expect(prompt).toContain("参考案例");
    expect(prompt).toContain("dispatch_order");
  });

  it("proposeDraft 写入 evolution_drafts 并发布 evolve.playbook_drafted", async () => {
    const runtime = makeEvolveRuntime();
    const engine = createEvolveEngine(runtime as never);

    const proposal = await engine.proposeDraft(
      { description: "为 OEE 查询生成 Playbook" },
      { source: "test.propose_draft", signal: "knowledge_gap" },
    );

    expect(proposal.id).toBeTruthy();
    expect(runtime.kb.ingest).toHaveBeenCalledWith(
      expect.stringContaining("pending_review"),
      expect.objectContaining({
        namespace: "evolution_drafts",
        metadata: expect.objectContaining({ status: "pending_review", signal: "knowledge_gap" }),
      }),
    );
    expect(runtime._published.some((e) => e.type === "evolve.playbook_drafted")).toBe(true);
    expect(
      runtime._published.find((e) => e.type === "evolve.playbook_drafted")?.payload.status,
    ).toBe("pending_review");
  });

  it("parseEvolutionDraftText 解析 KB 草稿正文", () => {
    const text = [
      "# Playbook Draft: OEE",
      "status: pending_review",
      "proposal_id: evolved_123",
      "confidence: 0.85",
      "",
      "id: evolved_123",
      "name: OEE Query",
      "trigger:",
      "  kind: event",
      "  pattern: oee.query",
    ].join("\n");
    const parsed = parseEvolutionDraftText(text);
    expect(parsed?.proposalId).toBe("evolved_123");
    expect(parsed?.playbookYaml).toContain("id: evolved_123");
  });

  it("promoteDraft 无 approved 时 fail-closed 返回 approval_required", async () => {
    const runtime = makeEvolveRuntime();
    const engine = createEvolveEngine(runtime as never);
    const proposal = await engine.proposeDraft({ description: "test draft" });

    const result = await engine.promoteDraft({
      proposalId: proposal.id,
      approved: false,
    });
    expect(result.status).toBe("approval_required");
    expect(runtime._published.some((e) => e.type === "hitl.approval_requested")).toBe(true);
  });

  it("promoteDraft approved=true 部署草稿并发布 evolve.playbook_deployed", async () => {
    const runtime = makeEvolveRuntime();
    runtime.packLoader.load = vi.fn(async () => ({
      manifest: { id: "user_evolved" },
      path: "/tmp",
      objectTypes: [],
      playbooks: [],
    }));
    runtime.playbookEngine.loadFromPacks = vi.fn(async () => undefined);
    const engine = createEvolveEngine(runtime as never);
    const proposal = await engine.proposeDraft({ description: "deploy me" });

    const result = await engine.promoteDraft({
      proposalId: proposal.id,
      approved: true,
      verifyAfterDeploy: false,
    });
    expect(result.status).toBe("deployed_unverified");
    expect(result.deployed).toBe(true);
    expect(runtime._published.some((e) => e.type === "evolve.playbook_deployed")).toBe(true);
  });

  it("startDraftReviewPipeline 在 evolve.playbook_drafted 后发布 evolve.suggestions_ready", async () => {
    const runtime = makeEvolveRuntime();
    const engine = createEvolveEngine(runtime as never);

    const proposal = await engine.proposeDraft(
      { description: "OEE 查询 Playbook" },
      { source: "test.draft_review", signal: "knowledge_gap" },
    );
    runtime._published.length = 0;

    engine.startDraftReviewPipeline();
    runtime.kernel.emit("evolve.playbook_drafted", {
      id: proposal.id,
      title: proposal.title,
      status: "pending_review",
      signal: "knowledge_gap",
      confidence: proposal.confidence,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const ready = runtime._published.find((e) => e.type === "evolve.suggestions_ready");
    expect(ready).toBeTruthy();
    expect(ready?.payload.draft_id).toBe(proposal.id);
    expect(ready?.payload.hitl_required).toBe(true);
    expect(ready?.payload.simulation).toEqual(
      expect.objectContaining({ skipped: true, yaml_valid: true }),
    );
    expect(ready?.payload.suggestions).toEqual(
      expect.arrayContaining([expect.stringMatching(/evolve\.promote_draft/)]),
    );
  });
});
