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
    create: vi.fn().mockResolvedValue({ id: "wo-1", title: "WO-1" }),
    executeAction: vi.fn().mockResolvedValue({ status: "object_store_fallback" }),
  };
  return {
    runId: "run-cap",
    playbookId: "pb-cap",
    variables: { user_id: "u1" },
    objectStore: store as ObjectStore,
    kb: { search: vi.fn().mockResolvedValue([]), ingest: vi.fn() },
    robot: { name: "robot", role: "monolith", endpoint: "http://127.0.0.1:18800" },
    publishEvent: vi.fn(),
  };
}

function makeRun(): PlaybookRun {
  return {
    id: "run-cap",
    playbookId: "pb-cap",
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
    logger: vi.fn(),
    ...overrides,
  };
}

describe("step-executor capability routing", () => {
  it("routes registered capability actionApiName to capabilityInvoke", async () => {
    const ctx = makeCtx();
    const run = makeRun();
    const capabilityInvoke = vi.fn().mockResolvedValue({
      intent: "alarm_report",
      confidence: 0.92,
    });
    const capabilityHas = vi.fn((id: string) => id === "perceive.intent");

    await executePlaybookStep(
      {
        kind: "action",
        id: "classify",
        actionApiName: "perceive.intent",
        params: { text: "3号生产线温度超标" },
      },
      ctx,
      run,
      baseDeps({ capabilityInvoke, capabilityHas }),
    );

    expect(capabilityInvoke).toHaveBeenCalledWith(
      "perceive.intent",
      { text: "3号生产线温度超标" },
      ctx,
    );
    expect(ctx.objectStore.executeAction).not.toHaveBeenCalled();
    expect(
      (ctx.variables.steps as Record<string, { result: Record<string, unknown> }>).classify.result
        .intent,
    ).toBe("alarm_report");
  });

  it("prefers actionRegistry over capabilityInvoke", async () => {
    const ctx = makeCtx();
    const run = makeRun();
    const capabilityInvoke = vi.fn();
    const actionRegistry = {
      has: vi.fn().mockReturnValue(true),
      get: vi.fn().mockReturnValue({
        apiName: "perceive.intent",
        packId: "custom-pack",
        handler: vi.fn().mockResolvedValue({ source: "pack_handler" }),
      }),
      register: vi.fn(),
      registerAll: vi.fn(),
      list: vi.fn().mockReturnValue([]),
      unregisterPack: vi.fn(),
      clear: vi.fn(),
    };

    await executePlaybookStep(
      {
        kind: "action",
        id: "classify",
        actionApiName: "perceive.intent",
        params: { text: "hello" },
      },
      ctx,
      run,
      baseDeps({ capabilityInvoke, capabilityHas: () => true, actionRegistry }),
    );

    expect(actionRegistry.get).toHaveBeenCalledWith("perceive.intent");
    expect(capabilityInvoke).not.toHaveBeenCalled();
    expect(
      (ctx.variables.steps as Record<string, { result: Record<string, unknown> }>).classify.result
        .source,
    ).toBe("pack_handler");
  });

  it("falls through when capability is not registered", async () => {
    const ctx = makeCtx();
    const run = makeRun();
    const capabilityInvoke = vi.fn();
    const capabilityHas = vi.fn().mockReturnValue(false);

    await executePlaybookStep(
      {
        kind: "action",
        id: "create",
        actionApiName: "create_work_order",
        params: { title: "WO-1" },
      },
      ctx,
      run,
      baseDeps({ capabilityInvoke, capabilityHas }),
    );

    expect(capabilityInvoke).not.toHaveBeenCalled();
    expect(ctx.objectStore.create).toHaveBeenCalled();
  });
});
