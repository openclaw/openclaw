import { describe, expect, it, vi } from "vitest";
import type { ObjectStore } from "../data/object-store.js";
import type { PlaybookRun, PlaybookStepContext } from "./playbook-types.js";
import { executePlaybookStep } from "./step-executor.js";
import type { StepExecutorDeps } from "./step-executor.js";

function makeCtx(): PlaybookStepContext {
  const store: Partial<ObjectStore> = {
    get: vi.fn().mockResolvedValue(null),
    query: vi.fn().mockResolvedValue({ items: [] }),
    upsert: vi.fn().mockResolvedValue({}),
  };
  return {
    runId: "run-ctx",
    playbookId: "pb-ctx",
    variables: {
      _ctx: { keywords: ["alarm", "pump"] },
    },
    objectStore: store as ObjectStore,
    kb: { search: vi.fn().mockResolvedValue([]), ingest: vi.fn() },
    robot: { name: "robot", role: "monolith", endpoint: "http://127.0.0.1:18800" },
    publishEvent: vi.fn(),
  };
}

function makeRun(): PlaybookRun {
  return {
    id: "run-ctx",
    playbookId: "pb-ctx",
    status: "running",
    input: {},
    steps: [],
    startedAt: new Date(),
  };
}

function baseDeps(overrides?: Partial<StepExecutorDeps>): StepExecutorDeps {
  const ctx = makeCtx();
  return {
    objectStore: ctx.objectStore,
    kb: ctx.kb,
    robot: ctx.robot,
    hitl: {
      suspend: vi.fn().mockReturnValue("token"),
      resolve: vi.fn(),
      list: vi.fn().mockReturnValue([]),
    },
    productionMode: false,
    publishAnomaly: vi.fn().mockResolvedValue(undefined),
    logger: vi.fn(),
    ...overrides,
  };
}

describe("executePlaybookStep llm rich context injection", () => {
  it("passes KB case text to llmComplete prompt in rich mode", async () => {
    const llmComplete = vi.fn().mockResolvedValue({ text: "analysis done" });
    const kbSearch = vi
      .fn()
      .mockResolvedValue([
        { title: "Pump alarm case", text: "prior pump-001 overheat recovery steps" },
      ]);

    const ctx = makeCtx();
    const run = makeRun();

    await executePlaybookStep(
      {
        kind: "llm",
        id: "llm-rich",
        prompt: "analyze pump alarm",
        output: "reply",
        context_level: "rich",
      },
      ctx,
      run,
      baseDeps({
        llmComplete,
        kb: { search: kbSearch, ingest: vi.fn() },
      }),
    );

    expect(kbSearch).toHaveBeenCalled();
    expect(llmComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringMatching(/参考案例[\s\S]*prior pump-001 overheat recovery steps/),
      }),
    );
  });

  it("passes domain namespace KB text to llmComplete prompt in rich mode", async () => {
    const llmComplete = vi.fn().mockResolvedValue({ text: "domain-aware reply" });
    const kbSearch = vi.fn().mockImplementation(async (_query, opts) => {
      if (opts?.namespace === "domain") {
        return [{ text: "alarm escalation SOP: notify on-call within 5 minutes" }];
      }
      return [];
    });

    const ctx = makeCtx();
    const run = makeRun();

    await executePlaybookStep(
      {
        kind: "llm",
        id: "llm-domain",
        prompt: "handle alarm event",
        output: "reply",
        context_level: "rich",
        domain: "alarm",
      },
      ctx,
      run,
      baseDeps({
        llmComplete,
        kb: { search: kbSearch, ingest: vi.fn() },
      }),
    );

    expect(kbSearch).toHaveBeenCalledWith(
      "alarm 领域知识",
      expect.objectContaining({ namespace: "domain" }),
    );
    expect(llmComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringMatching(
          /领域知识 \[alarm\][\s\S]*alarm escalation SOP: notify on-call within 5 minutes/,
        ),
      }),
    );
  });

  it("uses promptRegistry template for classify task_type llm step", async () => {
    const llmComplete = vi.fn().mockResolvedValue({ text: '{"intent":"oee_query"}' });
    const renderPromptTemplate = vi.fn((id: string, vars: Record<string, unknown>) =>
      id === "intent_classify" ? `CLASSIFY_TEMPLATE:\n${String(vars.message)}` : null,
    );

    const ctx = makeCtx();
    const run = makeRun();

    await executePlaybookStep(
      {
        kind: "llm",
        id: "llm-classify",
        prompt: "查一下 OEE",
        output: "intent",
        task_type: "classify",
      },
      ctx,
      run,
      baseDeps({
        llmComplete,
        renderPromptTemplate,
      }),
    );

    expect(renderPromptTemplate).toHaveBeenCalledWith(
      "intent_classify",
      expect.objectContaining({ message: "查一下 OEE" }),
    );
    expect(llmComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "CLASSIFY_TEMPLATE:\n查一下 OEE",
      }),
    );
  });

  it("passes KB case text to subagentRun prompt in rich mode", async () => {
    const subagentRun = vi.fn().mockResolvedValue({ text: "subagent analysis" });
    const kbSearch = vi
      .fn()
      .mockResolvedValue([{ title: "Subagent case", text: "prior subagent pump triage flow" }]);

    const ctx = makeCtx();
    const run = makeRun();

    await executePlaybookStep(
      {
        kind: "subagent",
        id: "sub-rich",
        prompt: "triage pump alarm",
        output: "reply",
        context_level: "rich",
      },
      ctx,
      run,
      baseDeps({
        subagentRun,
        kb: { search: kbSearch, ingest: vi.fn() },
      }),
    );

    expect(kbSearch).toHaveBeenCalled();
    expect(subagentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringMatching(/参考案例[\s\S]*prior subagent pump triage flow/),
      }),
    );
  });
});
