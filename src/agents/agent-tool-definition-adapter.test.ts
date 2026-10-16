/** Runtime/client tool coercion, delegation, and conflicts at the definition boundary. */
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { AgentTool } from "openclaw/plugin-sdk/agent-core";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { withTestTimeout } from "../../test/helpers/promise.js";
import {
  createClientToolNameConflictError,
  findClientToolNameConflicts,
  isClientToolNameConflictError,
  toClientToolDefinitions,
  toToolDefinitions,
} from "./agent-tool-definition-adapter.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { validateScriptFileForShellBleed } from "./bash-tools.exec-script-preflight.js";
import type { ClientToolDefinition } from "./embedded-agent-runner/run/params.js";
import { wrapToolDefinition } from "./sessions/tools/tool-definition-wrapper.js";
import { createToolTerminalObserver } from "./tool-terminal-outcome.js";

type ToolExecute = ReturnType<typeof toToolDefinitions>[number]["execute"];
const extensionContext = {} as Parameters<ToolExecute>[4];
const CLIENT_TOOL_NAME_CONFLICT_PREFIX = "client tool name conflict:";
const querySchema = () => ({ type: "object", properties: { query: { type: "string" } } });
const receipt = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

function executeDefinition(
  def: ReturnType<typeof toToolDefinitions>[number] | undefined,
  callId: string,
  params?: unknown,
) {
  return expectDefined(def, "tool definition").execute(
    callId,
    params,
    undefined,
    undefined,
    extensionContext,
  );
}

function executeTool(tool: AgentTool, callId: string, params: unknown = {}) {
  return executeDefinition(toToolDefinitions([tool])[0], callId, params);
}
function toolFixture(name: string, execute: AgentTool["execute"]): AgentTool {
  return { name, label: name, description: name, parameters: Type.Object({}), execute };
}
function executeExec(
  options: Parameters<typeof createExecTool>[0],
  callId: string,
  params: unknown = {},
) {
  return executeTool(createExecTool(options), callId, params);
}

function sandboxOptions(validateWorkdir: (workdir: string) => Promise<string>) {
  return {
    containerName: "remote-sandbox-workdir-test",
    workspaceDir: process.cwd(),
    containerWorkdir: "/remote/workspace",
    workdirValidation: "backend" as const,
    validateWorkdir,
  };
}

describe("agent tool definition adapter", () => {
  it("retains a wrapped native permission refusal for the transcript Grant card", async () => {
    const permissionMissing = {
      nodeId: "mac-node",
      nodeName: "Test Mac",
      command: "computer.act",
      capabilities: ["accessibility", "screenRecording"],
      state: "denied",
    };
    const message =
      "Accessibility and Screen Recording required. Do not retry until the user confirms.";
    const cause = Object.assign(new Error(message), { details: { permissionMissing } });
    const result = await executeTool(
      toolFixture("nodes", async () => {
        throw new Error(message, { cause });
      }),
      "permission-call",
    );
    expect(result.details).toEqual({
      status: "error",
      tool: "nodes",
      error: message,
      permissionMissing,
    });
  });
  it.each(["wrapped", "composed"] as const)(
    "preserves signal and update identity through %s execution",
    async (route) => {
      const caller = new AbortController();
      const run = new AbortController();
      const partial = receipt("partial receipt");
      const result = receipt("final receipt");
      const onUpdate = vi.fn();
      const execute = vi.fn<AgentTool["execute"]>(async (_id, _args, _signal, update) => {
        update?.(partial);
        return result;
      });
      const [definition] = toToolDefinitions(
        [toolFixture("receipt", execute)],
        undefined,
        route === "composed" ? run.signal : undefined,
      );
      const def = expectDefined(definition, "receipt definition");
      const invoke = (id: string) =>
        route === "wrapped"
          ? wrapToolDefinition(def).execute(id, {}, caller.signal, onUpdate)
          : def.execute(id, {}, caller.signal, onUpdate, extensionContext);

      try {
        expect(await withTestTimeout(invoke("receipt-call"), 2_000, "receipt did not settle")).toBe(
          result,
        );
        expect(execute).toHaveBeenCalledOnce();
        const call = expectDefined(execute.mock.calls[0], "receipt invocation");
        expect(call.slice(0, 2)).toEqual(["receipt-call", {}]);
        expect(call[3]).toBe(onUpdate);
        expect(onUpdate).toHaveBeenCalledExactlyOnceWith(partial);
        expect(onUpdate.mock.calls[0]?.[0]).toBe(partial);
        if (route === "composed") {
          expect(call[2]).not.toBe(caller.signal);
          expect(call[2]).not.toBe(run.signal);
        } else {
          expect(call[2]).toBe(caller.signal);
        }

        const reason = new Error("operator cancelled receipt");
        (route === "composed" ? run : caller).abort(reason);
        expect(call[2]).toMatchObject({ aborted: true, reason });
        expect(call[2]?.reason).toBe(reason);
        await expect(
          withTestTimeout(invoke("cancelled-receipt"), 2_000, "cancelled receipt did not settle"),
        ).rejects.toBe(reason);
        expect(execute).toHaveBeenCalledOnce();
      } finally {
        caller.abort();
        run.abort();
      }
    },
    10_000,
  );

  it("preserves exec deny before prepared workdir failures", async () => {
    const tool = createExecTool({
      security: "deny",
      ask: "off",
    });
    const missingWorkdir = path.join(os.tmpdir(), `openclaw-missing-denied-cwd-${Date.now()}`);
    const [definition] = toToolDefinitions([tool]);
    const existing = await executeDefinition(definition, "call-denied-existing-cwd", {
      command: "echo denied",
      workdir: process.cwd(),
    });
    const missing = await executeDefinition(definition, "call-denied-missing-cwd", {
      command: "echo denied",
      workdir: missingWorkdir,
    });

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
    const result = await executeExec(
      {
        host: "sandbox",
        security: "deny",
        ask: "off",
        sandbox: sandboxOptions(validateWorkdir),
      },
      "call-denied-backend-cwd",
      {
        command: "echo denied",
        workdir: "/remote/workspace/generated",
      },
    );

    expect(result.details).toMatchObject({
      status: "error",
      error: "exec denied: host=sandbox security=deny",
    });
    expect(validateWorkdir).not.toHaveBeenCalled();
  });

  it("preserves no-start evidence when presenting a script-preflight refusal", async () => {
    const parameters = Type.Object({ command: Type.String(), workdir: Type.String() });
    const tool: AgentTool<typeof parameters> = {
      name: "exec",
      label: "Exec",
      description: "Validate the script before execution",
      parameters,
      execute: async (_id, params) => {
        await validateScriptFileForShellBleed(params);
        return { content: [], details: {} };
      },
    };
    const args = { command: "cat bad.py | python", workdir: process.cwd() };
    const result = await executeTool(tool, "call-preflight-refused", args);

    expect(result.details).toMatchObject({
      status: "error",
      error: expect.stringContaining("exec preflight: complex interpreter invocation"),
    });
    const terminal = createToolTerminalObserver("run-preflight-refused")({
      toolName: "exec",
      arguments: args,
      result,
      executionStarted: true,
      outcome: "failure",
    });
    expect(terminal.lastToolError).toMatchObject({
      executionStarted: false,
      mutatingAction: false,
    });
  });

  it.each([
    { kind: "non-object", params: "not-an-object" },
    { kind: "elevated", params: {} },
    { kind: "backend-workdir", params: { workdir: "/remote/workspace/generated" } },
  ] as const)(
    "rejects malformed $kind exec params before workdir validation",
    async ({ kind, params }) => {
      const validateWorkdir = vi.fn(async (workdir: string) => workdir);
      const result = await executeExec(
        {
          security: "full",
          ask: "off",
          ...(kind === "backend-workdir"
            ? ({ host: "sandbox", sandbox: sandboxOptions(validateWorkdir) } as const)
            : {}),
          ...(kind === "elevated"
            ? ({ elevated: { enabled: true, allowed: true, defaultLevel: "on" } } as const)
            : {}),
        },
        `call-malformed-${kind}`,
        params,
      );
      expect(result.details).toMatchObject({
        status: "error",
        error: "Provide a command to start.",
      });
      if (kind === "backend-workdir") {
        expect(validateWorkdir).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    { name: "details-only", details: { hits: [{ id: "a1", score: 0.9 }] }, key: '"hits"' },
    { name: "plain object", details: { count: 2, ids: ["m1", "m2"] }, key: '"count"' },
  ])("coerces $name results to text content", async ({ name, details, key }) => {
    const value = structuredClone(name === "details-only" ? { details } : details);
    const tool = toolFixture(
      "memory_query",
      (async () => value) as unknown as AgentTool["execute"],
    );
    const result = await executeTool(tool, "coerce-result");
    expect(result.details).toEqual(details);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining(key) });
  });

  it("does not re-run hook preparation for an already wrapped tool", async () => {
    const prepareBeforeToolCallParams = vi.fn((params: unknown) => params);
    const execute = vi.fn(async () => receipt("done"));
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
    await executeDefinition(toToolDefinitions([wrappedTool], hookContext)[0], "call-wrapped", {});

    expect(prepareBeforeToolCallParams).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });
});

function makeClientTool(name: string, parameters = querySchema()): ClientToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description: `${name} tool`,
      parameters,
    },
  };
}

async function executeClientTool(params: unknown) {
  let captured: Record<string, unknown> | undefined;
  const [def] = toClientToolDefinitions([makeClientTool("search")], (_name, p) => {
    captured = p;
  });
  const result = await executeDefinition(def, "call-c1", params);
  return { calledWith: captured, result };
}

describe("toClientToolDefinitions – param coercion", () => {
  it.each(["not-json", "42"])(
    "returns a visible error instead of dispatching malformed client arguments: %s",
    async (params) => {
      const { calledWith, result } = await executeClientTool(params);
      expect(calledWith).toBeUndefined();
      expect(result.details).toMatchObject({
        status: "error",
        tool: "search",
        error: expect.stringContaining("client tool arguments"),
      });
      expect(result.terminate).not.toBe(true);
    },
  );

  it("falls back to empty object for empty string", async () => {
    const { calledWith } = await executeClientTool("");
    expect(calledWith).toStrictEqual({});
  });

  it("rejects missing required client arguments without completing the call", async () => {
    const clientTool = makeClientTool("search");
    clientTool.function.parameters = { ...querySchema(), required: ["query"] };
    const reserve = vi.fn();
    const complete = vi.fn();
    const discard = vi.fn();
    const [definition] = toClientToolDefinitions([clientTool], { reserve, complete, discard });
    const result = await executeDefinition(definition, "call-required-client-args", "");

    expect(result.details).toMatchObject({
      status: "error",
      error: expect.stringContaining("query"),
    });
    expect(result.terminate).not.toBe(true);
    expect(complete).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledWith("call-required-client-args", "search");
  });

  it("keeps absent arguments valid for a parameterless client tool", async () => {
    const clientTool = makeClientTool("ping");
    clientTool.function.parameters = { type: "object", properties: {} };
    const complete = vi.fn();
    const [definition] = toClientToolDefinitions([clientTool], { complete });
    const result = await executeDefinition(definition, "call-parameterless-client-tool");

    expect(complete).toHaveBeenCalledWith("call-parameterless-client-tool", "ping", {});
    expect(result.terminate).toBe(true);
  });
});

describe("client tool name conflict checks", () => {
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
