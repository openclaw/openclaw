import { describe, expect, it, vi } from "vitest";
import type { ObjectStore } from "../data/object-store.js";
import { executeFunction } from "./function-executor.js";
import type { PlaybookRun, PlaybookStepContext } from "./playbook-types.js";
import { StepFailedError, executePlaybookStep } from "./step-executor.js";
import type { StepExecutorDeps } from "./step-executor.js";

function makeCtx(): PlaybookStepContext {
  const store: Partial<ObjectStore> = {
    get: vi.fn().mockResolvedValue(null),
    query: vi.fn().mockResolvedValue({ items: [] }),
    upsert: vi.fn().mockResolvedValue({}),
  };
  return {
    runId: "run-prod",
    playbookId: "pb-prod",
    variables: {},
    objectStore: store as ObjectStore,
    kb: { search: vi.fn().mockResolvedValue([]), ingest: vi.fn() },
    robot: { name: "robot", role: "monolith", endpoint: "http://127.0.0.1:18800" },
    publishEvent: vi.fn(),
  };
}

function makeRun(): PlaybookRun {
  return {
    id: "run-prod",
    playbookId: "pb-prod",
    status: "running",
    input: {},
    steps: [],
    startedAt: new Date(),
  };
}

function baseDeps(overrides?: Partial<StepExecutorDeps>): StepExecutorDeps {
  return {
    objectStore: makeCtx().objectStore,
    kb: makeCtx().kb,
    robot: makeCtx().robot,
    hitl: {
      suspend: vi.fn().mockReturnValue("token"),
      resolve: vi.fn(),
      list: vi.fn().mockReturnValue([]),
    },
    productionMode: true,
    publishAnomaly: vi.fn().mockResolvedValue(undefined),
    logger: vi.fn(),
    ...overrides,
  };
}

describe("step-executor production fail-closed", () => {
  it("llm step throws when bridge missing and productionMode=true", async () => {
    const ctx = makeCtx();
    const run = makeRun();
    await expect(
      executePlaybookStep(
        { kind: "llm", id: "llm1", prompt: "hello", output: "out" },
        ctx,
        run,
        baseDeps(),
      ),
    ).rejects.toBeInstanceOf(StepFailedError);
  });

  it("llm step returns stub when productionMode=false", async () => {
    const ctx = makeCtx();
    const run = makeRun();
    await executePlaybookStep(
      { kind: "llm", id: "llm1", prompt: "hello", output: "out" },
      ctx,
      run,
      baseDeps({ productionMode: false }),
    );
    expect(ctx.variables.out).toBe("hello");
  });

  it("skill step uses local scriptRun before skillRun harness", async () => {
    const ctx = makeCtx();
    const run = makeRun();
    const skillRun = vi.fn();
    const scriptRun = vi.fn().mockResolvedValue({ ok: true, value: 42 });
    await executePlaybookStep(
      { kind: "skill", id: "s-local", skillId: "calc.expression", output: "r" },
      ctx,
      run,
      baseDeps({ scriptRun, skillRun }),
    );
    expect(scriptRun).toHaveBeenCalledWith({
      scriptId: "calc.expression",
      input: {},
    });
    expect(skillRun).not.toHaveBeenCalled();
    expect(ctx.variables.r).toMatchObject({
      ok: true,
      source: "local",
      skill_id: "calc.expression",
    });
  });

  it("skill step falls through to skillRun when local script missing", async () => {
    const ctx = makeCtx();
    const run = makeRun();
    const skillRun = vi.fn().mockResolvedValue({ text: "harness ok" });
    const scriptRun = vi.fn().mockRejectedValue(new Error("Script not found: remote-skill"));
    await executePlaybookStep(
      { kind: "skill", id: "s-harness", skillId: "remote-skill", output: "r" },
      ctx,
      run,
      baseDeps({ scriptRun, skillRun }),
    );
    expect(scriptRun).toHaveBeenCalled();
    expect(skillRun).toHaveBeenCalledWith({ skillId: "remote-skill", input: {} });
    expect(ctx.variables.r).toMatchObject({ text: "harness ok", source: "harness" });
  });

  it("skill step throws when skillRun missing in production", async () => {
    const ctx = makeCtx();
    const run = makeRun();
    await expect(
      executePlaybookStep(
        { kind: "skill", id: "s1", skillId: "my-skill", output: "r" },
        ctx,
        run,
        baseDeps(),
      ),
    ).rejects.toBeInstanceOf(StepFailedError);
  });
});

describe("function-executor production fail-closed", () => {
  it("unknown function throws in production mode", async () => {
    await expect(
      executeFunction("totally_unknown_fn", {}, { productionMode: true }),
    ).rejects.toThrow(/未知 function/);
  });

  it("unknown function returns stub in dev mode", async () => {
    const result = await executeFunction(
      "totally_unknown_fn",
      { x: 1 },
      {
        productionMode: false,
      },
    );
    expect(result).toMatchObject({ status: "stub", function: "totally_unknown_fn" });
  });
});
