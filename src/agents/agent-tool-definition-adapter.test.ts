/**
 * Unit coverage for adapting runtime and client-hosted tools.
 * Exercises result coercion, error wrapping, client delegation, and conflict
 * detection at the ToolDefinition boundary.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentTool } from "openclaw/plugin-sdk/agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { addTestHook } from "../plugins/hooks.test-helpers.js";
import type { PluginFinalToolInputPolicyRegistration } from "../plugins/host-hooks.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  createClientToolNameConflictError,
  findClientToolNameConflicts,
  isClientToolNameConflictError,
  toClientToolDefinitions,
  toToolDefinitions,
} from "./agent-tool-definition-adapter.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { createExecTool } from "./bash-tools.exec.js";
import type { ClientToolDefinition } from "./embedded-agent-runner/run/params.js";
import { applyNodesToolWorkspaceGuard } from "./openclaw-tools.nodes-workspace-guard.js";

type ToolExecute = ReturnType<typeof toToolDefinitions>[number]["execute"];
const extensionContext = {} as Parameters<ToolExecute>[4];
const CLIENT_TOOL_NAME_CONFLICT_PREFIX = "client tool name conflict:";

function installFinalToolInputPolicy(
  policy: PluginFinalToolInputPolicyRegistration,
  beforeToolCall?: Parameters<typeof addTestHook>[0]["handler"],
): void {
  const registry = createEmptyPluginRegistry();
  registry.finalToolInputPolicies = [
    {
      pluginId: "test-final-input-policy",
      pluginName: "Test Final Input Policy",
      policy,
      source: "test",
    },
  ];
  if (beforeToolCall) {
    addTestHook({
      registry,
      pluginId: "test-before-tool-call",
      hookName: "before_tool_call",
      handler: beforeToolCall,
    });
  }
  initializeGlobalHookRunner(registry);
}

afterEach(() => {
  resetGlobalHookRunner();
});

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

describe("agent tool definition adapter", () => {
  it("preserves argument preparation and execution mode contracts", () => {
    const prepareArguments = vi.fn((args: unknown) => args as Record<string, never>);
    const tool = {
      name: "serial_tool",
      label: "Serial Tool",
      description: "runs sequentially",
      parameters: Type.Object({}),
      prepareArguments,
      executionMode: "sequential",
      execute: async () => ({
        content: [{ type: "text", text: "done" }],
        details: {},
      }),
    } satisfies AgentTool;

    const [definition] = toToolDefinitions([tool]);

    expect(definition?.prepareArguments).toBe(prepareArguments);
    expect(definition?.executionMode).toBe("sequential");
  });

  it("wraps tool errors into a tool result", async () => {
    const result = await executeThrowingTool("boom", "call1");

    const details = result.details as
      | { status?: string; tool?: string; error?: string }
      | undefined;
    expect(details?.status).toBe("error");
    expect(details?.tool).toBe("boom");
    expect(details?.error).toBe("nope");
    expect(JSON.stringify(result.details)).not.toContain("\n    at ");
  });

  it("normalizes exec tool aliases in error results", async () => {
    const result = await executeThrowingTool("bash", "call2");

    const details = result.details as
      | { status?: string; tool?: string; error?: string }
      | undefined;
    expect(details?.status).toBe("error");
    expect(details?.tool).toBe("exec");
    expect(details?.error).toBe("nope");
  });

  it("preserves exec deny before prepared workdir failures", async () => {
    const tool = createExecTool({
      security: "deny",
      ask: "off",
    });
    const [definition] = toToolDefinitions([tool]);
    const missingWorkdir = path.join(os.tmpdir(), `openclaw-missing-denied-cwd-${Date.now()}`);

    const existing = await definition.execute(
      "call-denied-existing-cwd",
      {
        command: "echo denied",
        workdir: process.cwd(),
      },
      undefined,
      undefined,
      extensionContext,
    );
    const missing = await definition.execute(
      "call-denied-missing-cwd",
      {
        command: "echo denied",
        workdir: missingWorkdir,
      },
      undefined,
      undefined,
      extensionContext,
    );

    const expected = {
      status: "error",
      error: "exec denied: host=gateway security=deny",
    };
    expect(existing.details).toMatchObject(expected);
    expect(missing.details).toMatchObject(expected);
    expect(JSON.stringify(missing)).not.toContain("unavailable or not a directory");
  });

  it("does not validate backend sandbox workdirs before exec deny", async () => {
    const validateWorkdir = vi.fn(async (workdir: string) => workdir);
    const tool = createExecTool({
      host: "sandbox",
      security: "deny",
      ask: "off",
      sandbox: {
        containerName: "remote-sandbox-workdir-test",
        workspaceDir: process.cwd(),
        containerWorkdir: "/remote/workspace",
        workdirValidation: "backend",
        validateWorkdir,
      },
    });
    const [definition] = toToolDefinitions([tool]);

    const result = await definition.execute(
      "call-denied-backend-cwd",
      {
        command: "echo denied",
        workdir: "/remote/workspace/generated",
      },
      undefined,
      undefined,
      extensionContext,
    );

    expect(result.details).toMatchObject({
      status: "error",
      error: "exec denied: host=sandbox security=deny",
    });
    expect(validateWorkdir).not.toHaveBeenCalled();
  });

  it("does not throw WeakMap errors when preparing malformed exec params", async () => {
    const tool = createExecTool({
      security: "full",
      ask: "off",
    });
    const [definition] = toToolDefinitions([tool]);

    const result = await definition.execute(
      "call-malformed-exec-params",
      "not-an-object",
      undefined,
      undefined,
      extensionContext,
    );

    expect(result.details).toMatchObject({
      status: "error",
      error: "Provide a command to start.",
    });
  });

  it("does not throw WeakMap errors when preparing malformed backend sandbox exec params", async () => {
    const validateWorkdir = vi.fn(async (workdir: string) => workdir);
    const tool = createExecTool({
      host: "sandbox",
      security: "full",
      ask: "off",
      sandbox: {
        containerName: "remote-sandbox-workdir-test",
        workspaceDir: process.cwd(),
        containerWorkdir: "/remote/workspace",
        workdirValidation: "backend",
        validateWorkdir,
      },
    });
    const [definition] = toToolDefinitions([tool]);

    const result = await definition.execute(
      "call-malformed-backend-sandbox-exec-params",
      "not-an-object",
      undefined,
      undefined,
      extensionContext,
    );

    expect(result.details).toMatchObject({
      status: "error",
      error: "Provide a command to start.",
    });
    expect(JSON.stringify(result)).not.toContain("WeakMap");
    expect(validateWorkdir).not.toHaveBeenCalled();
  });

  it("reports malformed exec params when elevated logging is enabled", async () => {
    const tool = createExecTool({
      security: "full",
      ask: "off",
      elevated: { enabled: true, allowed: true, defaultLevel: "on" },
    });
    const [definition] = toToolDefinitions([tool]);

    const result = await definition.execute(
      "call-malformed-elevated-exec-params",
      {},
      undefined,
      undefined,
      extensionContext,
    );

    expect(result.details).toMatchObject({
      status: "error",
      error: "Provide a command to start.",
    });
  });

  it("does not validate backend sandbox workdirs before malformed exec params fail", async () => {
    const validateWorkdir = vi.fn(async (workdir: string) => workdir);
    const tool = createExecTool({
      host: "sandbox",
      security: "full",
      ask: "off",
      sandbox: {
        containerName: "remote-sandbox-workdir-test",
        workspaceDir: process.cwd(),
        containerWorkdir: "/remote/workspace",
        workdirValidation: "backend",
        validateWorkdir,
      },
    });
    const [definition] = toToolDefinitions([tool]);

    const result = await definition.execute(
      "call-malformed-backend-sandbox-exec-params",
      {
        workdir: "/remote/workspace/generated",
      },
      undefined,
      undefined,
      extensionContext,
    );

    expect(result.details).toMatchObject({
      status: "error",
      error: "Provide a command to start.",
    });
    expect(validateWorkdir).not.toHaveBeenCalled();
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
    expect(result.content[0]?.type).toBe("text");
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
    expect(result.content[0]?.type).toBe("text");
    expect((result.content[0] as { text?: string }).text).toContain('"count"');
  });

  it("does not re-run hook preparation for an already wrapped tool", async () => {
    const prepareBeforeToolCallParams = vi.fn((params: unknown) => params);
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "done" }],
      details: {},
    }));
    const tool = {
      name: "wrapped_tool",
      label: "Wrapped Tool",
      description: "already owns hook execution",
      parameters: Type.Object({}),
      prepareBeforeToolCallParams,
      execute,
    } as AgentTool & {
      prepareBeforeToolCallParams: typeof prepareBeforeToolCallParams;
    };
    const hookContext = { agentId: "agent-main", sessionId: "session-wrapped-tool" };
    const wrappedTool = wrapToolWithBeforeToolCallHook(tool, hookContext);
    const [definition] = toToolDefinitions([wrappedTool], hookContext);
    if (!definition) {
      throw new Error("missing wrapped tool definition");
    }

    await definition.execute("call-wrapped", {}, undefined, undefined, extensionContext);

    expect(prepareBeforeToolCallParams).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("evaluates finalized params without replacing trusted execution state", async () => {
    const trustedState = Symbol("trusted-state");
    const seenByPolicy: unknown[] = [];
    const execute = vi.fn(async (_toolCallId: string, params: unknown) => ({
      content: [{ type: "text" as const, text: "done" }],
      details: {
        stage: (params as { stage?: unknown }).stage,
        trusted: (params as Record<symbol, unknown>)[trustedState],
      },
    }));
    installFinalToolInputPolicy({
      id: "final-params",
      description: "inspect finalized params",
      evaluate(event) {
        seenByPolicy.push(event.params);
        expect((event.params as Record<symbol, unknown>)[trustedState]).toBeUndefined();
        (event.params as { stage?: string }).stage = "mutated-policy-snapshot";
        return { outcome: "pass" };
      },
    });
    const tool = {
      name: "prepared_tool",
      label: "Prepared Tool",
      description: "carries trusted finalizer state",
      parameters: Type.Object({ stage: Type.String() }),
      prepareBeforeToolCallParams: (params: unknown) => ({
        ...(params as Record<string, unknown>),
        stage: "prepared",
      }),
      finalizeBeforeToolCallParams: (params: unknown) => {
        const finalParams = params as Record<string | symbol, unknown>;
        finalParams.stage = "finalized";
        Object.defineProperty(finalParams, trustedState, {
          configurable: false,
          enumerable: false,
          value: "trusted",
        });
        return finalParams;
      },
      execute,
    } as unknown as AgentTool;
    const [definition] = toToolDefinitions([tool]);
    if (!definition) {
      throw new Error("missing prepared tool definition");
    }

    const result = await definition.execute(
      "call-finalized",
      { stage: "raw" },
      undefined,
      undefined,
      extensionContext,
    );

    expect(seenByPolicy).toEqual([{ stage: "mutated-policy-snapshot" }]);
    expect(execute).toHaveBeenCalledTimes(1);
    const executedParams = execute.mock.calls[0]?.[1];
    if (!executedParams || typeof executedParams !== "object") {
      throw new Error("missing finalized execution params");
    }
    expect(executedParams).toMatchObject({ stage: "finalized" });
    expect((executedParams as Record<symbol, unknown>)[trustedState]).toBe("trusted");
    expect(result.details).toEqual({ stage: "finalized", trusted: "trusted" });
  });

  it("applies an outer workspace guard after an inner finalizer rewrite", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "openclaw-final-input-guard-"),
    );
    try {
      const seenByPolicy: unknown[] = [];
      const execute = vi.fn(async (_toolCallId: string, _params: unknown) => ({
        content: [{ type: "text" as const, text: "done" }],
        details: {},
      }));
      installFinalToolInputPolicy({
        id: "outer-workspace-guard",
        description: "inspect outer-guarded input",
        evaluate(event) {
          seenByPolicy.push(event.params);
          return { outcome: "pass" };
        },
      });
      const innerTool = {
        name: "nodes",
        label: "Nodes",
        description: "rewrites an output path",
        parameters: Type.Object({}),
        finalizeBeforeToolCallParams: async (params: unknown) => ({
          ...(params as Record<string, unknown>),
          outPath:
            (params as { escape?: unknown }).escape === true ? "/etc/passwd" : "videos/final.mp4",
        }),
        execute,
      } as unknown as Parameters<typeof applyNodesToolWorkspaceGuard>[0];
      const guardedTool = applyNodesToolWorkspaceGuard(innerTool, {
        workspaceDir: tempRoot,
        fsPolicy: { workspaceOnly: true },
      });
      const [definition] = toToolDefinitions([guardedTool]);
      if (!definition) {
        throw new Error("missing guarded nodes tool definition");
      }

      await definition.execute(
        "call-guarded-safe",
        { action: "screen_record" },
        undefined,
        undefined,
        extensionContext,
      );
      const blocked = await definition.execute(
        "call-guarded-escape",
        { action: "screen_record", escape: true },
        undefined,
        undefined,
        extensionContext,
      );

      const expectedParams = {
        action: "screen_record",
        outPath: path.join(tempRoot, "videos/final.mp4"),
      };
      expect(seenByPolicy).toEqual([expectedParams]);
      expect(execute).toHaveBeenCalledOnce();
      expect(Object.isFrozen(execute.mock.calls[0]?.[1])).toBe(true);
      expect(execute).toHaveBeenCalledWith(
        "call-guarded-safe",
        expectedParams,
        undefined,
        undefined,
      );
      expect(blocked.details).toMatchObject({
        status: "error",
        tool: "nodes",
        error: expect.stringMatching(/Path escapes sandbox root/),
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("seals retained hook aliases before awaiting final policy evaluation", async () => {
    const trustedState = Symbol("trusted-state");
    const retainedNested = { value: "canonical" };
    const hookParams = { nested: retainedNested };
    let finalizedParams: Record<string | symbol, unknown> | undefined;
    let mutationAttempted = false;
    const execute = vi.fn(async (_toolCallId: string, params: unknown) => ({
      content: [{ type: "text" as const, text: "done" }],
      details: {
        nested: (params as { nested: { value: string } }).nested.value,
        trusted: (params as Record<symbol, unknown>)[trustedState],
      },
    }));
    installFinalToolInputPolicy(
      {
        id: "retained-alias",
        description: "await after snapshotting retained input",
        async evaluate(event) {
          expect(event.params).toEqual({ nested: { value: "canonical" } });
          queueMicrotask(() => {
            mutationAttempted = true;
            retainedNested.value = "mutated-after-snapshot";
          });
          await Promise.resolve();
          return { outcome: "pass" };
        },
      },
      () => ({ params: hookParams }),
    );
    const tool = {
      name: "retained_alias_tool",
      label: "Retained Alias Tool",
      description: "preserves final host input identity",
      parameters: Type.Object({}),
      finalizeBeforeToolCallParams: (params: unknown) => {
        finalizedParams = params as Record<string | symbol, unknown>;
        Object.defineProperty(finalizedParams, trustedState, {
          configurable: false,
          enumerable: false,
          value: "trusted",
        });
        return finalizedParams;
      },
      execute,
    } as unknown as AgentTool;
    const [definition] = toToolDefinitions([tool]);
    if (!definition) {
      throw new Error("missing retained alias tool definition");
    }

    const result = await definition.execute(
      "call-retained-alias",
      { nested: { value: "raw" } },
      undefined,
      undefined,
      extensionContext,
    );

    const executedParams = execute.mock.calls[0]?.[1] as
      | Record<string | symbol, unknown>
      | undefined;
    expect(mutationAttempted).toBe(true);
    expect(retainedNested.value).toBe("mutated-after-snapshot");
    expect(executedParams).toBe(finalizedParams);
    expect(executedParams?.[trustedState]).toBe("trusted");
    expect(executedParams?.nested as object | undefined).not.toBe(retainedNested);
    expect(Object.isFrozen(executedParams)).toBe(true);
    expect(Object.isFrozen(executedParams?.nested)).toBe(true);
    expect(Object.isFrozen(retainedNested)).toBe(false);
    expect(result.details).toEqual({ nested: "canonical", trusted: "trusted" });
  });

  it("does not execute an unwrapped runtime tool denied by final input policy", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "executed" }],
      details: {},
    }));
    installFinalToolInputPolicy({
      id: "deny-runtime-tool",
      description: "deny runtime tool",
      evaluate: () => ({ outcome: "deny", reasonCode: "runtime_tool.denied" }),
    });
    const tool = {
      name: "runtime_tool",
      label: "Runtime Tool",
      description: "must not execute",
      parameters: Type.Object({}),
      execute,
    } satisfies AgentTool;
    const [definition] = toToolDefinitions([tool]);
    if (!definition) {
      throw new Error("missing runtime tool definition");
    }

    const result = await definition.execute(
      "call-denied",
      {},
      undefined,
      undefined,
      extensionContext,
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      status: "blocked",
      deniedReason: "final-tool-input-policy",
      reason: "Tool call blocked by final input policy",
    });
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

async function executeClientTool(params: unknown): Promise<{
  calledWith: Record<string, unknown> | undefined;
  result: Awaited<ReturnType<ToolExecute>>;
}> {
  let captured: Record<string, unknown> | undefined;
  const [def] = toClientToolDefinitions([makeClientTool("search")], (_name, p) => {
    captured = p;
  });
  if (!def) {
    throw new Error("missing client tool definition");
  }
  const result = await def.execute("call-c1", params, undefined, undefined, extensionContext);
  return { calledWith: captured, result };
}

describe("toClientToolDefinitions – param coercion", () => {
  it("returns terminal pending results for each client tool in a batch", async () => {
    const completed: Array<{ id: string; name: string; params: Record<string, unknown> }> = [];
    const defs = toClientToolDefinitions([makeClientTool("search"), makeClientTool("lookup")], {
      complete: (id, name, params) => {
        completed.push({ id, name, params });
      },
    });
    const [search, lookup] = defs;
    if (!search || !lookup) {
      throw new Error("missing client tool definition");
    }

    const [searchResult, lookupResult] = await Promise.all([
      search.execute("call-search", { query: "first" }, undefined, undefined, extensionContext),
      lookup.execute("call-lookup", { query: "second" }, undefined, undefined, extensionContext),
    ]);

    expect(searchResult.terminate).toBe(true);
    expect(lookupResult.terminate).toBe(true);
    expect(completed).toEqual([
      { id: "call-search", name: "search", params: { query: "first" } },
      { id: "call-lookup", name: "lookup", params: { query: "second" } },
    ]);
  });

  it("passes plain object params through unchanged", async () => {
    const { calledWith, result } = await executeClientTool({ query: "hello" });
    expect(calledWith).toEqual({ query: "hello" });
    expect(result.terminate).toBe(true);
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
    expect(calledWith).toStrictEqual({});
  });

  it("falls back to empty object for empty string", async () => {
    const { calledWith } = await executeClientTool("");
    expect(calledWith).toStrictEqual({});
  });

  it("falls back to empty object for null", async () => {
    const { calledWith } = await executeClientTool(null);
    expect(calledWith).toStrictEqual({});
  });

  it("falls back to empty object for undefined", async () => {
    const { calledWith } = await executeClientTool(undefined);
    expect(calledWith).toStrictEqual({});
  });

  it("falls back to empty object for a JSON array string", async () => {
    const { calledWith } = await executeClientTool("[1,2,3]");
    expect(calledWith).toStrictEqual({});
  });

  it("handles nested JSON string correctly", async () => {
    const { calledWith } = await executeClientTool(
      '{"action":"search","params":{"q":"test","page":1}}',
    );
    expect(calledWith).toEqual({ action: "search", params: { q: "test", page: 1 } });
  });

  it("isolates and deeply freezes final-policy client delegation input", async () => {
    installFinalToolInputPolicy({
      id: "pass-client-tool",
      description: "pass client delegation",
      evaluate: () => ({ outcome: "pass" }),
    });
    const original = {
      query: "private",
      options: { limit: 10 },
    };
    const retainedOptions = original.options;
    let delegated: Record<string, unknown> | undefined;
    const [definition] = toClientToolDefinitions([makeClientTool("search")], (_name, params) => {
      delegated = params;
    });
    if (!definition) {
      throw new Error("missing client tool definition");
    }

    const result = await definition.execute(
      "call-client-allowed",
      original,
      undefined,
      undefined,
      extensionContext,
    );

    expect(result.terminate).toBe(true);
    expect(delegated).toBe(original);
    if (!delegated) {
      throw new Error("missing delegated params");
    }
    const delegatedOptions = delegated.options;
    if (!delegatedOptions || typeof delegatedOptions !== "object") {
      throw new Error("missing delegated options");
    }
    expect(delegatedOptions).not.toBe(retainedOptions);
    expect(Object.isFrozen(delegated)).toBe(true);
    expect(Object.isFrozen(delegatedOptions)).toBe(true);
    expect(() => {
      (delegatedOptions as { limit: number }).limit = 99;
    }).toThrow(TypeError);
    retainedOptions.limit = 99;
    expect(delegated).toEqual({ query: "private", options: { limit: 10 } });
    expect(original).toEqual({ query: "private", options: { limit: 10 } });
    expect(retainedOptions).toEqual({ limit: 99 });
    expect(Object.isFrozen(original)).toBe(true);
    expect(Object.isFrozen(original.options)).toBe(true);
  });

  it("does not delegate when cancellation races with a passing final policy", async () => {
    const controller = new AbortController();
    const delegate = vi.fn();
    installFinalToolInputPolicy({
      id: "race-client-cancel",
      description: "abort while passing client delegation",
      evaluate: () =>
        new Promise<{ outcome: "pass" }>((resolve) => {
          controller.abort(new Error("cancelled during policy resolution"));
          resolve({ outcome: "pass" });
        }),
    });
    const [definition] = toClientToolDefinitions([makeClientTool("search")], delegate);
    if (!definition) {
      throw new Error("missing client tool definition");
    }

    await expect(
      definition.execute(
        "call-client-racing-cancel",
        { query: "private" },
        controller.signal,
        undefined,
        extensionContext,
      ),
    ).rejects.toThrow("cancelled during policy resolution");
    expect(delegate).not.toHaveBeenCalled();
  });

  it("discards a reserved client delegation denied by final input policy", async () => {
    const reserve = vi.fn();
    const complete = vi.fn();
    const discard = vi.fn();
    const seenByPolicy: unknown[] = [];
    installFinalToolInputPolicy({
      id: "deny-client-tool",
      description: "deny client delegation",
      evaluate(event) {
        seenByPolicy.push(event.params);
        return { outcome: "deny", reasonCode: "client_tool.denied" };
      },
    });
    const [definition] = toClientToolDefinitions([makeClientTool("search")], {
      reserve,
      complete,
      discard,
    });
    if (!definition) {
      throw new Error("missing client tool definition");
    }

    const result = await definition.execute(
      "call-client-denied",
      '{"query":"private"}',
      undefined,
      undefined,
      extensionContext,
    );

    expect(seenByPolicy).toEqual([{ query: "private" }]);
    expect(reserve).toHaveBeenCalledWith("call-client-denied", "search");
    expect(discard).toHaveBeenCalledWith("call-client-denied", "search");
    expect(complete).not.toHaveBeenCalled();
    expect(result.terminate).not.toBe(true);
    expect(result.details).toMatchObject({
      status: "blocked",
      deniedReason: "final-tool-input-policy",
      reason: "Tool call blocked by final input policy",
    });
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

  it("detects collisions with reserved OpenClaw built-in tool names", () => {
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
