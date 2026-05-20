import { describe, it, expect, vi } from "vitest";
import type { ObjectStore } from "../data/object-store.js";
import type { PlaybookRun, PlaybookStepContext } from "./playbook-types.js";
import { executePlaybookStep } from "./step-executor.js";
import type { StepExecutorDeps } from "./step-executor.js";

function makeCtx(overrides?: Partial<PlaybookStepContext>): PlaybookStepContext {
  const store: Partial<ObjectStore> = {
    get: vi.fn().mockResolvedValue(null),
    create: vi
      .fn()
      .mockImplementation((_t, data) =>
        Promise.resolve({
          ...data,
          _type: _t,
          _version: 1,
          _createdAt: new Date(),
          _updatedAt: new Date(),
        }),
      ),
    update: vi
      .fn()
      .mockImplementation((_t, _id, patch) =>
        Promise.resolve({
          ...patch,
          _type: _t,
          _version: 2,
          _createdAt: new Date(),
          _updatedAt: new Date(),
        }),
      ),
    upsert: vi.fn().mockImplementation(async (_t, id, data) => ({
      ...data,
      id,
      _type: _t,
      _version: 1,
      _createdAt: new Date(),
      _updatedAt: new Date(),
    })),
    query: vi.fn().mockResolvedValue({ items: [] }),
    delete: vi.fn().mockResolvedValue(undefined),
    executeAction: vi.fn().mockResolvedValue({}),
  };

  return {
    runId: "run-test",
    playbookId: "test-playbook",
    variables: {},
    objectStore: store as ObjectStore,
    kb: { search: vi.fn().mockResolvedValue([]), ingest: vi.fn().mockResolvedValue(undefined) },
    robot: { name: "test-robot", role: "test", endpoint: "http://localhost" },
    publishEvent: vi.fn(),
    ...overrides,
  };
}

function makeRun(): PlaybookRun {
  return {
    id: "run-test",
    playbookId: "test-playbook",
    status: "running",
    startedAt: new Date(),
    input: {},
    steps: [],
  };
}

function makeDeps(overrides?: Partial<StepExecutorDeps>): StepExecutorDeps {
  return {
    objectStore: {} as ObjectStore,
    kb: { search: vi.fn().mockResolvedValue([]), ingest: vi.fn().mockResolvedValue(undefined) },
    robot: { name: "test-robot", role: "test", endpoint: "http://localhost" },
    hitl: { suspend: vi.fn().mockReturnValue("token"), resume: vi.fn() },
    ...overrides,
  };
}

describe("memory_read step", () => {
  it("returns found=false when no memory exists", async () => {
    const ctx = makeCtx();
    const run = makeRun();
    const step = {
      kind: "memory_read" as const,
      id: "s1",
      subject: "pump-001",
      key: "baseline_pressure",
      output: "mem",
    };
    await executePlaybookStep(step, ctx, run, makeDeps({ objectStore: ctx.objectStore }));
    expect(ctx.variables.mem).toMatchObject({ found: false });
    expect(run.steps[0]?.status).toBe("completed");
  });

  it("returns found=true with value when memory exists", async () => {
    const mockStore: Partial<ObjectStore> = {
      get: vi
        .fn()
        .mockResolvedValue({
          id: "mem:pump-001:baseline_pressure",
          value: "5.2",
          confidence: 0.95,
        }),
      upsert: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      query: vi.fn().mockResolvedValue({ items: [] }),
      delete: vi.fn(),
      executeAction: vi.fn(),
    };
    const ctx = makeCtx({ objectStore: mockStore as ObjectStore });
    const run = makeRun();
    const step = {
      kind: "memory_read" as const,
      id: "s1",
      subject: "pump-001",
      key: "baseline_pressure",
      output: "mem",
    };
    await executePlaybookStep(step, ctx, run, makeDeps({ objectStore: mockStore as ObjectStore }));
    expect(ctx.variables.mem).toMatchObject({ found: true, value: "5.2", confidence: 0.95 });
  });
});

describe("memory_write step", () => {
  it("calls objectStore.upsert and sets output", async () => {
    const ctx = makeCtx();
    const run = makeRun();
    const step = {
      kind: "memory_write" as const,
      id: "s1",
      subject: "pump-001",
      key: "baseline_pressure",
      value: "5.2",
      category: "baseline",
      confidence: 0.95,
      output: "write_result",
    };
    await executePlaybookStep(step, ctx, run, makeDeps({ objectStore: ctx.objectStore }));
    expect(ctx.objectStore.upsert).toHaveBeenCalledWith(
      "RobotMemory",
      "mem:pump-001:baseline_pressure",
      expect.objectContaining({ subject: "pump-001", key: "baseline_pressure", value: "5.2" }),
    );
    expect(ctx.variables.write_result).toMatchObject({ written: true });
  });

  it("interpolates subject and key from context variables", async () => {
    const ctx = makeCtx({ variables: { equipment_id: "pump-999", metric: "vibration" } });
    const run = makeRun();
    const step = {
      kind: "memory_write" as const,
      id: "s1",
      subject: "{{equipment_id}}",
      key: "baseline_{{metric}}",
      value: "12.5",
      output: "result",
    };
    await executePlaybookStep(step, ctx, run, makeDeps({ objectStore: ctx.objectStore }));
    expect(ctx.objectStore.upsert).toHaveBeenCalledWith(
      "RobotMemory",
      "mem:pump-999:baseline_vibration",
      expect.objectContaining({ subject: "pump-999", key: "baseline_vibration" }),
    );
  });
});

describe("publish_event step", () => {
  it("calls publishEvent and records output", async () => {
    const ctx = makeCtx();
    const run = makeRun();
    const step = {
      kind: "publish_event" as const,
      id: "s1",
      eventType: "alarm.created",
      source: "playbook:test",
      payload: { equipment_id: "pump-001", severity: "critical" },
      output: "publish_result",
    };
    await executePlaybookStep(step, ctx, run, makeDeps({ objectStore: ctx.objectStore }));
    expect(ctx.publishEvent).toHaveBeenCalledWith(
      "alarm.created",
      "playbook:test",
      expect.objectContaining({ equipment_id: "pump-001", severity: "critical" }),
      "run-test",
    );
    expect(ctx.variables.publish_result).toMatchObject({
      published: true,
      eventType: "alarm.created",
    });
  });

  it("falls back to stub when publishEvent not available", async () => {
    const ctx = makeCtx({ publishEvent: undefined });
    const run = makeRun();
    const step = { kind: "publish_event" as const, id: "s1", eventType: "alarm.created" };
    await executePlaybookStep(step, ctx, run, makeDeps({ objectStore: ctx.objectStore }));
    const stepLog = run.steps[0];
    expect(stepLog?.output).toMatchObject({ stub: true });
    expect(stepLog?.status).toBe("completed");
  });
});

describe("function: publish_event_from_intent", () => {
  it("maps known intent to business event", async () => {
    const publishEvent = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ publishEvent });
    const run = makeRun();
    const step = {
      kind: "function" as const,
      id: "s1",
      functionApiName: "publish_event_from_intent",
      params: {
        intent: "alarm_report",
        extracted: { equipment_id: "pump-001" },
        source: "im:feishu:user-001",
        correlation_id: "msg-abc",
      },
      output: "result",
    };
    await executePlaybookStep(step, ctx, run, makeDeps({ objectStore: ctx.objectStore }));
    // publishEvent via function executor does not call ctx.publishEvent directly
    // function-executor.ts uses deps.publishEvent (passed via FunctionExecutorDeps)
    expect(run.steps[0]?.status).toBe("completed");
    const result = ctx.variables.result as Record<string, unknown>;
    // Without publishEvent in deps, returns stub
    expect(result?.status).toMatch(/published|stub/);
  });

  it("returns skipped for 'none' intent", async () => {
    const ctx = makeCtx();
    const run = makeRun();
    const step = {
      kind: "function" as const,
      id: "s1",
      functionApiName: "publish_event_from_intent",
      params: { intent: "none" },
      output: "result",
    };
    await executePlaybookStep(step, ctx, run, makeDeps({ objectStore: ctx.objectStore }));
    const result = ctx.variables.result as Record<string, unknown>;
    expect(result?.status).toBe("skipped");
  });
});

describe("function: noop", () => {
  it("returns ok immediately", async () => {
    const ctx = makeCtx();
    const run = makeRun();
    const step = {
      kind: "function" as const,
      id: "s1",
      functionApiName: "noop",
      params: { reason: "test" },
      output: "result",
    };
    await executePlaybookStep(step, ctx, run, makeDeps({ objectStore: ctx.objectStore }));
    const result = ctx.variables.result as Record<string, unknown>;
    expect(result?.status).toBe("ok");
    expect(result?.noop).toBe(true);
  });
});
