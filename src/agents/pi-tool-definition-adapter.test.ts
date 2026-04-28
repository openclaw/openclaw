import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { ClientToolDefinition } from "./pi-embedded-runner/run/params.js";
import {
  CLIENT_TOOL_NAME_CONFLICT_PREFIX,
  createClientToolNameConflictError,
  findClientToolNameConflicts,
  isClientToolNameConflictError,
  toClientToolDefinitions,
  toToolDefinitions,
  withToolCallTimeout,
} from "./pi-tool-definition-adapter.js";

type ToolExecute = ReturnType<typeof toToolDefinitions>[number]["execute"];
const extensionContext = {} as Parameters<ToolExecute>[4];

async function executeThrowingTool(name: string, callId: string) {
  const tool = {
    name,
    label: name === "bash" ? "Bash" : "Boom",
    description: "throws",
    parameters: Type.Object({}),
    execute: async () => {
      throw new Error("nope");
    },
  } satisfies AgentTool;

  const defs = toToolDefinitions([tool]);
  const def = defs[0];
  if (!def) {
    throw new Error("missing tool definition");
  }
  return await def.execute(callId, {}, undefined, undefined, extensionContext);
}

async function executeTool(tool: AgentTool, callId: string) {
  const defs = toToolDefinitions([tool]);
  const def = defs[0];
  if (!def) {
    throw new Error("missing tool definition");
  }
  return await def.execute(callId, {}, undefined, undefined, extensionContext);
}

describe("pi tool definition adapter", () => {
  it("wraps tool errors into a tool result", async () => {
    const result = await executeThrowingTool("boom", "call1");

    expect(result.details).toMatchObject({
      status: "error",
      tool: "boom",
    });
    expect(result.details).toMatchObject({ error: "nope" });
    expect(JSON.stringify(result.details)).not.toContain("\n    at ");
  });

  it("normalizes exec tool aliases in error results", async () => {
    const result = await executeThrowingTool("bash", "call2");

    expect(result.details).toMatchObject({
      status: "error",
      tool: "exec",
      error: "nope",
    });
  });

  it("coerces details-only tool results to include content", async () => {
    const tool = {
      name: "memory_query",
      label: "Memory Query",
      description: "returns details only",
      parameters: Type.Object({}),
      execute: (async () => ({
        details: {
          hits: [{ id: "a1", score: 0.9 }],
        },
      })) as unknown as AgentTool["execute"],
    } satisfies AgentTool;

    const result = await executeTool(tool, "call3");
    expect(result.details).toEqual({
      hits: [{ id: "a1", score: 0.9 }],
    });
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text?: string }).text).toContain('"hits"');
  });

  it("coerces non-standard object results to include content", async () => {
    const tool = {
      name: "memory_query_raw",
      label: "Memory Query Raw",
      description: "returns plain object",
      parameters: Type.Object({}),
      execute: (async () => ({
        count: 2,
        ids: ["m1", "m2"],
      })) as unknown as AgentTool["execute"],
    } satisfies AgentTool;

    const result = await executeTool(tool, "call4");
    expect(result.details).toEqual({
      count: 2,
      ids: ["m1", "m2"],
    });
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text?: string }).text).toContain('"count"');
  });
});

// ---------------------------------------------------------------------------
// toClientToolDefinitions – streaming tool-call argument coercion (#57009)
// ---------------------------------------------------------------------------

function makeClientTool(name: string): ClientToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description: `${name} tool`,
      parameters: { type: "object", properties: { query: { type: "string" } } },
    },
  };
}

async function executeClientTool(
  params: unknown,
): Promise<{ calledWith: Record<string, unknown> | undefined }> {
  let captured: Record<string, unknown> | undefined;
  const [def] = toClientToolDefinitions([makeClientTool("search")], (_name, p) => {
    captured = p;
  });
  if (!def) {
    throw new Error("missing client tool definition");
  }
  await def.execute("call-c1", params, undefined, undefined, extensionContext);
  return { calledWith: captured };
}

describe("toClientToolDefinitions – param coercion", () => {
  it("passes plain object params through unchanged", async () => {
    const { calledWith } = await executeClientTool({ query: "hello" });
    expect(calledWith).toEqual({ query: "hello" });
  });

  it("parses a JSON string into an object (streaming delta accumulation)", async () => {
    const { calledWith } = await executeClientTool('{"query":"hello","limit":10}');
    expect(calledWith).toEqual({ query: "hello", limit: 10 });
  });

  it("parses a JSON string with surrounding whitespace", async () => {
    const { calledWith } = await executeClientTool('  {"query":"hello"}  ');
    expect(calledWith).toEqual({ query: "hello" });
  });

  it("falls back to empty object for invalid JSON string", async () => {
    const { calledWith } = await executeClientTool("not-json");
    expect(calledWith).toEqual({});
  });

  it("falls back to empty object for empty string", async () => {
    const { calledWith } = await executeClientTool("");
    expect(calledWith).toEqual({});
  });

  it("falls back to empty object for null", async () => {
    const { calledWith } = await executeClientTool(null);
    expect(calledWith).toEqual({});
  });

  it("falls back to empty object for undefined", async () => {
    const { calledWith } = await executeClientTool(undefined);
    expect(calledWith).toEqual({});
  });

  it("falls back to empty object for a JSON array string", async () => {
    const { calledWith } = await executeClientTool("[1,2,3]");
    expect(calledWith).toEqual({});
  });

  it("handles nested JSON string correctly", async () => {
    const { calledWith } = await executeClientTool(
      '{"action":"search","params":{"q":"test","page":1}}',
    );
    expect(calledWith).toEqual({ action: "search", params: { q: "test", page: 1 } });
  });
});

describe("client tool name conflict checks", () => {
  it("detects collisions with existing built-in names after normalization", () => {
    expect(
      findClientToolNameConflicts({
        tools: [makeClientTool("Web_Search"), makeClientTool("exec")],
        existingToolNames: ["web_search", "read"],
      }),
    ).toEqual(["Web_Search"]);
  });

  it("detects duplicate client tool names after normalization", () => {
    expect(
      findClientToolNameConflicts({
        tools: [makeClientTool("Weather"), makeClientTool("weather")],
      }),
    ).toEqual(["Weather", "weather"]);
  });

  it("detects collisions with reserved Pi built-in tool names", () => {
    expect(
      findClientToolNameConflicts({
        tools: [makeClientTool("Bash"), makeClientTool("grep")],
        existingToolNames: ["bash", "edit", "find", "grep", "ls", "read", "write"],
      }),
    ).toEqual(["Bash", "grep"]);
  });

  it("wraps conflict errors with a stable prefix", () => {
    const err = createClientToolNameConflictError(["exec", "Web_Search"]);
    expect(err.message).toBe(`${CLIENT_TOOL_NAME_CONFLICT_PREFIX} exec, Web_Search`);
    expect(isClientToolNameConflictError(err)).toBe(true);
    expect(isClientToolNameConflictError(new Error("other failure"))).toBe(false);
  });
});

// ─── Helper ───
function extractJsonFromResult(result: unknown): unknown {
  if (result && typeof result === "object" && "details" in result) {
    return (result as { details: unknown }).details;
  }
  return result;
}

function createMockSignal(overrides?: Partial<AbortSignal>): AbortSignal & {
  addSpy: ReturnType<typeof vi.fn>;
  removeSpy: ReturnType<typeof vi.fn>;
} {
  const addSpy = vi.fn();
  const removeSpy = vi.fn();
  return {
    aborted: false,
    reason: undefined,
    onabort: null,
    addEventListener: addSpy,
    removeEventListener: removeSpy,
    throwIfAborted: () => {},
    dispatchEvent: () => true,
    addSpy: addSpy,
    removeSpy: removeSpy,
    ...overrides,
  } as unknown as AbortSignal & {
    addSpy: ReturnType<typeof vi.fn>;
    removeSpy: ReturnType<typeof vi.fn>;
  };
}

// ─── withToolCallTimeout unit tests ───
describe("withToolCallTimeout", () => {
  // === Happy path ===
  it("completes fast tools within timeout", async () => {
    const result = await withToolCallTimeout(
      async () => "done",
      1000,
      "fast-tool",
    );
    expect(result).toBe("done");
  });

  it("disables timeout when set to 0", async () => {
    const result = await withToolCallTimeout(
      async () => "no-timeout",
      0,
      "tool",
    );
    expect(result).toBe("no-timeout");
  });

  it("disables timeout when negative", async () => {
    const result = await withToolCallTimeout(
      async () => "negative",
      -1,
      "tool",
    );
    expect(result).toBe("negative");
  });

  // === Timeout path ===
  it("times out slow tools", async () => {
    vi.useFakeTimers();
    const promise = withToolCallTimeout(
      () => new Promise(() => {}), // never resolves
      100,
      "slow-tool",
    );
    vi.advanceTimersByTime(100);
    await expect(promise).rejects.toThrow("timed out after 100ms");
    vi.useRealTimers();
  });

  it("propagates abort signal to tool on timeout", async () => {
    vi.useFakeTimers();
    let receivedSignal: AbortSignal | undefined;
    const promise = withToolCallTimeout(
      async (sig) => {
        receivedSignal = sig;
        return new Promise(() => {}); // never resolves
      },
      100,
      "abort-prop-tool",
    );
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal!.aborted).toBe(false);
    vi.advanceTimersByTime(100);
    await expect(promise).rejects.toThrow("timed out");
    expect(receivedSignal!.aborted).toBe(true);
    vi.useRealTimers();
  });

  // === Parent abort path ===
  it("handles parent abort signal", async () => {
    let abortCallback: (() => void) | null = null;
    const mockSignal = createMockSignal();
    mockSignal.addEventListener = vi.fn((_event: string, cb: () => void) => {
      abortCallback = cb;
    }) as unknown as typeof mockSignal.addEventListener;

    const promise = withToolCallTimeout(
      () => new Promise(() => {}),
      10000,
      "abort-tool",
      mockSignal,
    );

    // Trigger parent abort
    setTimeout(() => abortCallback?.(), 5);
    await expect(promise).rejects.toThrow("aborted");
  });

  it("handles already-aborted parent signal", async () => {
    const abortedSignal = createMockSignal({ aborted: true });
    let called = false;
    // When parent is already aborted, execute is called directly with parent signal
    await withToolCallTimeout(
      async () => {
        called = true;
        return "bypassed";
      },
      1000,
      "tool",
      abortedSignal,
    ).catch(() => "caught");
    expect(called).toBe(true);
  });

  // === Error path ===
  it("handles tool execution errors (thrown Error)", async () => {
    await expect(
      withToolCallTimeout(
        async () => { throw new Error("tool broke"); },
        1000,
        "error-tool",
      ),
    ).rejects.toThrow("tool broke");
  });

  it("handles non-Error throws (string)", async () => {
    await expect(
      withToolCallTimeout(
        async () => { throw "string error"; },
        1000,
        "string-throw-tool",
      ),
    ).rejects.toThrow("string error");
  });

  // === Cleanup / resource leak ===
  it("cleans up abort listeners on normal completion", async () => {
    const mockSignal = createMockSignal();
    await withToolCallTimeout(
      async () => "ok",
      1000,
      "cleanup-tool",
      mockSignal,
    );
    expect(mockSignal.addSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(mockSignal.removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("cleans up abort listeners when timeout fires", async () => {
    vi.useFakeTimers();
    const mockSignal = createMockSignal();
    const promise = withToolCallTimeout(
      () => new Promise(() => {}),
      50,
      "timeout-cleanup-tool",
      mockSignal,
    );
    vi.advanceTimersByTime(50);
    await expect(promise).rejects.toThrow("timed out");
    expect(mockSignal.removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
    vi.useRealTimers();
  });
});

// ─── toToolDefinitions config tests ───
describe("toToolDefinitions with timeout config", () => {
  const makeTool = (executeFn: AgentTool["execute"]): AgentTool => ({
    name: "test-tool",
    label: "Test",
    description: "test",
    parameters: Type.Object({}),
    execute: executeFn,
  } satisfies AgentTool);

  it("uses configured toolCallTimeoutSeconds", async () => {
    vi.useFakeTimers();
    const tool = makeTool(async () => {
      return new Promise(() => {}); // never resolves
    });
    const defs = toToolDefinitions([tool], { toolCallTimeoutSeconds: 0.05 });
    const promise = defs[0].execute("call-1", {}, undefined, undefined, extensionContext);
    vi.advanceTimersByTime(50);
    const result = await promise;
    const json = extractJsonFromResult(result);
    expect(json).toMatchObject({ status: "error", tool: "test-tool" });
    expect((json as { error: string }).error).toContain("timed out");
    vi.useRealTimers();
  });

  it("defaults to 60s when config not provided", async () => {
    const tool = makeTool(async () => {
      return { content: [{ type: "text" as const, text: "ok" }], details: { fast: true } };
    });
    // Just verify it doesn't throw with no config
    const defs = toToolDefinitions([tool]);
    const result = await defs[0].execute("call-2", {}, undefined, undefined, extensionContext);
    expect(result.details).toMatchObject({ fast: true });
  });

  it("disables timeout when toolCallTimeoutSeconds is 0", async () => {
    const tool = makeTool(async () => {
      return { content: [{ type: "text" as const, text: "ok" }], details: { noTimeout: true } };
    });
    const defs = toToolDefinitions([tool], { toolCallTimeoutSeconds: 0 });
    const result = await defs[0].execute("call-3", {}, undefined, undefined, extensionContext);
    expect(result.details).toMatchObject({ noTimeout: true });
  });

  it("completes fast tools and returns correct result", async () => {
    const tool = makeTool(async () => {
      return { content: [{ type: "text" as const, text: "ok" }], details: { value: 42 } };
    });
    const defs = toToolDefinitions([tool], { toolCallTimeoutSeconds: 5 });
    const result = await defs[0].execute("call-4", {}, undefined, undefined, extensionContext);
    expect(result.details).toMatchObject({ value: 42 });
  });
});
