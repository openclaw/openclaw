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
});
