/** Failures retain useful errors without logging tool payloads. */
import type { AgentTool } from "openclaw/plugin-sdk/agent-core";
import { Type } from "typebox";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { toToolDefinitions } from "./agent-tool-definition-adapter.js";

const mocks = vi.hoisted(() => ({
  logDebug: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  logDebug: mocks.logDebug,
  logError: mocks.logError,
}));

let wrapToolParamValidation: typeof import("./agent-tools.params.js").wrapToolParamValidation;
let REQUIRED_PARAM_GROUPS: typeof import("./agent-tools.params.js").REQUIRED_PARAM_GROUPS;
let withToolOperatorHint: typeof import("./tool-operator-hint.js").withToolOperatorHint;

type ToolExecute = ReturnType<typeof toToolDefinitions>[number]["execute"];
const extensionContext = {} as Parameters<ToolExecute>[4];
const editParameters = Type.Object({
  path: Type.String(),
  edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
});

function invoke(def: { execute: ToolExecute }, id: string, params: unknown, signal?: AbortSignal) {
  return def.execute(id, params, signal, undefined, extensionContext);
}

function definitionFor(
  name: string,
  parameters: AgentTool["parameters"],
  execute: AgentTool["execute"],
  validate = false,
) {
  const tool = { name, label: name, description: name, parameters, execute };
  const [definition] = toToolDefinitions([
    validate ? wrapToolParamValidation(tool, REQUIRED_PARAM_GROUPS.edit) : tool,
  ]);
  if (!definition) {
    throw new Error("missing tool definition");
  }
  return definition;
}

function failingExecDefinition(name: string, parameters: AgentTool["parameters"]) {
  return definitionFor(name, parameters, async () => {
    throw new Error("exec denied: allowlist miss");
  });
}

function firstLogErrorMessage(): unknown {
  return mocks.logError.mock.calls[0]?.[0];
}
function expectPrivateExecLog(...secrets: string[]) {
  const message = String(firstLogErrorMessage());
  expect(message).toBe("[tools] exec failed:");
  for (const secret of [...secrets, "export XAI_API_KEY"]) {
    expect(message).not.toContain(secret);
  }
}
function editDefinition(execute: AgentTool["execute"]) {
  return definitionFor("edit", editParameters, execute, true);
}

describe("agent tool definition adapter logging", () => {
  beforeAll(async () => {
    ({ wrapToolParamValidation, REQUIRED_PARAM_GROUPS } = await import("./agent-tools.params.js"));
    ({ withToolOperatorHint } = await import("./tool-operator-hint.js"));
  });

  beforeEach(() => {
    mocks.logError.mockReset();
    mocks.logDebug.mockReset();
  });

  it("logs parameter errors without malformed edit payloads", async () => {
    const def = editDefinition(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      details: { ok: true },
    }));

    const result = await invoke(def, "call-edit-1", { path: "private-notes.txt" });

    expect(firstLogErrorMessage()).toBe("[tools] edit failed:");
    expect(result.details).toEqual({
      status: "error",
      tool: "edit",
      error:
        "Missing required parameter: edits (received: path). Supply correct parameters before retrying.",
    });
    expect(
      JSON.stringify([...mocks.logError.mock.calls, ...mocks.logDebug.mock.calls]),
    ).not.toContain("private-notes.txt");
  });

  it("logs the operator hint for a contained tool failure without exposing it to the model", async () => {
    const message = "Path escapes sandbox root (~/workspace): /outside/private-tool-message.md";
    const failure = new Error(message);
    failure.stack = "Error: private-tool-stack-sentinel";
    const operatorHint =
      "apply_patch is restricted to the workspace by default. Set tools.exec.applyPatch.workspaceOnly to false.";
    const def = definitionFor("apply_patch", Type.Object({ input: Type.String() }), async () => {
      throw withToolOperatorHint(failure, operatorHint);
    });
    const result = await invoke(def, "call-hint-1", {
      input: "*** Begin Patch",
    });

    expect(firstLogErrorMessage()).toBe(`[tools] apply_patch failed: ${operatorHint}`);
    const logs = JSON.stringify([...mocks.logError.mock.calls, ...mocks.logDebug.mock.calls]);
    expect(logs).not.toContain("private-tool-message");
    expect(logs).not.toContain("private-tool-stack-sentinel");

    // The model-visible result carries the rejection but never the way to lift it.
    expect(result.details).toEqual({ status: "error", tool: "apply_patch", error: message });
    const modelText = JSON.stringify(result);
    expect(modelText).toContain(message);
    expect(modelText).not.toContain("workspaceOnly");
  });

  it("omits raw exec commands and env values from failure logs", async () => {
    const commandSecret = "issue85049-xai-cleartext-token-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    const envSecret = "issue85049-env-cleartext-token-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    const def = failingExecDefinition(
      "bash",
      Type.Object({
        command: Type.String(),
        cmd: Type.Optional(Type.String()),
        env: Type.Optional(Type.Record(Type.String(), Type.String())),
        timeout: Type.Optional(Type.Number()),
      }),
    );

    const result = await invoke(def, "call-exec-denied", {
      command: `export XAI_API_KEY=\\"${commandSecret}\\" && echo blocked`,
      cmd: `echo ${commandSecret}`,
      env: { OPENAI_API_KEY: envSecret },
      timeout: 5,
    });

    expectPrivateExecLog(commandSecret, envSecret);
    expect(result.details).toEqual({
      status: "error",
      tool: "exec",
      error: "exec denied: allowlist miss",
    });
  });

  it.each(["JSON-string", "malformed"])(
    "omits private values from %s exec failure params",
    async (kind) => {
      const commandSecret = "issue85049-private-command-token";
      const envSecret = "issue85049-private-env-token";
      const command = `export XAI_API_KEY=\\"${commandSecret}\\" && echo blocked`;
      const def = failingExecDefinition("exec", Type.Any());
      await invoke(
        def,
        `call-exec-denied-${kind}`,
        kind === "JSON-string"
          ? JSON.stringify({ command, timeout: 5 })
          : { command: [command], env: `OPENAI_API_KEY=${envSecret}` },
      );
      expectPrivateExecLog(commandSecret, envSecret);
    },
  );

  it("rethrows AbortError failures when the agent run signal was aborted", async () => {
    const def = definitionFor("web_search", Type.Object({ query: Type.String() }), async () => {
      const error = new Error("This operation was aborted");
      error.name = "AbortError";
      throw error;
    });
    const controller = new AbortController();
    controller.abort();

    const pending = invoke(def, "call-agent-abort", { query: "OpenClaw" }, controller.signal);
    await expect(pending).rejects.toBeInstanceOf(Error);
    await expect(pending).rejects.toBe(controller.signal.reason);
    await expect(pending).rejects.toHaveProperty("name", "AbortError");
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it("accepts nested edits arrays for the current edit schema", async () => {
    const execute = vi.fn(async (_toolCallId: string, params: unknown) => ({
      content: [{ type: "text" as const, text: JSON.stringify(params) }],
      details: { ok: true },
    }));
    const def = editDefinition(execute);

    const payload = {
      path: "notes.txt",
      edits: [
        { oldText: "alpha", newText: "beta" },
        { oldText: "gamma", newText: "" },
      ],
    };

    await invoke(def, "call-edit-batch", payload);

    expect(execute).toHaveBeenCalledWith("call-edit-batch", payload, undefined, undefined);
    expect(mocks.logError).not.toHaveBeenCalled();
  });
});
