// Exercises after_tool_call result isolation for plugin-owned (Proxy) tool results.
import { beforeEach, describe, expect, it, vi } from "vitest";

const runAfterToolCall = vi.fn(async () => undefined);
const hookRunner = { hasHooks: vi.fn(() => true), runAfterToolCall };

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookRunner,
}));
vi.mock("../agent-tools.before-tool-call.js", () => ({
  consumeAdjustedParamsForToolCall: () => undefined,
}));

const { runAgentHarnessAfterToolCallHook } = await import("./hook-helpers.js");

class Timestamp {
  constructor(
    readonly _seconds: number,
    readonly _nanoseconds: number,
  ) {}
}

function deliveredEvent(): Record<string, unknown> {
  expect(runAfterToolCall).toHaveBeenCalledTimes(1);
  return (runAfterToolCall.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
}

describe("runAgentHarnessAfterToolCallHook result isolation", () => {
  beforeEach(() => {
    runAfterToolCall.mockClear();
  });

  it("passes cloneable results through as an isolated copy", async () => {
    const result = { content: [{ type: "text", text: "ok" }], details: { n: 1 } };
    await runAgentHarnessAfterToolCallHook({
      toolName: "edp_data",
      toolCallId: "call-1",
      startArgs: { method: "edp.get" },
      result,
    });
    const event = deliveredEvent();
    expect(event.result).toEqual(result);
    expect(event.result).not.toBe(result);
  });

  it("projects plugin value views (Proxy) with nested class instances instead of dropping the event", async () => {
    // Plugin results containing class instances arrive as Proxy views that structuredClone rejects.
    const details = {
      document: { _id: "doc-1", vendorAccess: { windowStartAt: new Timestamp(1792515600, 0) } },
    };
    const result = new Proxy(
      { content: [{ type: "text", text: JSON.stringify(details) }], details },
      {},
    );
    expect(() => structuredClone(result)).toThrow();

    await runAgentHarnessAfterToolCallHook({
      toolName: "edp_data",
      toolCallId: "call-2",
      startArgs: { method: "edp.get", params: { collection: "propertyTasks", id: "doc-1" } },
      result,
    });

    const event = deliveredEvent();
    expect(event.toolName).toBe("edp_data");
    expect(event.params).toEqual({
      method: "edp.get",
      params: { collection: "propertyTasks", id: "doc-1" },
    });
    expect(event.result).toEqual({
      content: [{ type: "text", text: JSON.stringify(details) }],
      details: {
        document: {
          _id: "doc-1",
          vendorAccess: { windowStartAt: { _seconds: 1792515600, _nanoseconds: 0 } },
        },
      },
    });
  });

  it("still delivers the event without result when no data projection is possible", async () => {
    const cyclic: Record<string, unknown> = { fn: () => undefined };
    cyclic.self = cyclic;
    const result = new Proxy(cyclic, {});

    await runAgentHarnessAfterToolCallHook({
      toolName: "edp_data",
      toolCallId: "call-3",
      startArgs: { method: "edp.query" },
      result,
    });

    const event = deliveredEvent();
    expect(event.toolCallId).toBe("call-3");
    expect(event).not.toHaveProperty("result");
  });

  it("never hands shared memory to hooks through the projection", async () => {
    const result = new Proxy({ bytes: new Uint8Array(new SharedArrayBuffer(4)), ok: true }, {});

    await runAgentHarnessAfterToolCallHook({
      toolName: "edp_data",
      toolCallId: "call-4",
      startArgs: {},
      result,
    });

    const event = deliveredEvent();
    const projected = event.result as Record<string, unknown>;
    expect(projected.ok).toBe(true);
    expect(projected.bytes).not.toBeInstanceOf(Uint8Array);
  });
});
