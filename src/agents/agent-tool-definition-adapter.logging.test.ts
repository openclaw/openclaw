import type { AgentTool } from "openclaw/plugin-sdk/agent-core";
import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toToolDefinitions } from "./agent-tool-definition-adapter.js";
import { REQUIRED_PARAM_GROUPS, wrapToolParamValidation } from "./agent-tools.params.js";
import { withToolOperatorHint } from "./tool-operator-hint.js";

const mocks = vi.hoisted(() => ({ logDebug: vi.fn(), logError: vi.fn() }));
vi.mock("../logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logger.js")>()),
  ...mocks,
}));

type Execute = AgentTool["execute"];
type ToolExecute = ReturnType<typeof toToolDefinitions>[number]["execute"];
const extensionContext = {} as Parameters<ToolExecute>[4];
const ok = { content: [{ type: "text" as const, text: "ok" }], details: { ok: true } };
function invoke(name: string, params: unknown, execute: Execute, signal?: AbortSignal) {
  const tool = { name, label: name, description: name, parameters: Type.Any(), execute };
  const [definition] = toToolDefinitions([
    name === "edit" ? wrapToolParamValidation(tool, REQUIRED_PARAM_GROUPS.edit) : tool,
  ]);
  if (!definition) {
    throw new Error("missing tool definition");
  }
  return definition.execute("call-1", params, signal, undefined, extensionContext);
}
const firstLog = () => mocks.logError.mock.calls[0]?.[0];
const logs = () => JSON.stringify([...mocks.logError.mock.calls, ...mocks.logDebug.mock.calls]);

describe("agent tool definition adapter logging", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([false, true])(
    "validates nested edits without logging payloads (valid=%s)",
    async (valid) => {
      const edits = [
        { oldText: "alpha", newText: "beta" },
        { oldText: "gamma", newText: "" },
      ];
      const params = { path: "private-notes.txt", ...(valid ? { edits } : {}) };
      const execute = vi.fn(async () => ok);
      const result = await invoke("edit", params, execute);
      if (valid) {
        expect(execute).toHaveBeenCalledWith("call-1", params, undefined, undefined);
        expect(result).toEqual(ok);
        expect(mocks.logError).not.toHaveBeenCalled();
      } else {
        const error =
          "Missing required parameter: edits (received: path). Supply correct parameters before retrying.";
        expect(firstLog()).toBe(`[tools] edit failed: Error: ${error}`);
        expect(result.details).toEqual({ status: "error", tool: "edit", error });
        expect(execute).not.toHaveBeenCalled();
      }
      expect(logs()).not.toContain("private-notes.txt");
    },
  );

  it("logs operator remediation without exposing it to the model", async () => {
    const message = "Path escapes sandbox root (~/workspace): /outside/private-tool-message.md";
    const operatorHint =
      "apply_patch is restricted to the workspace by default. Set tools.exec.applyPatch.workspaceOnly to false.";
    const failure = new Error(message);
    failure.stack = "Error: private-tool-stack-sentinel";
    const result = await invoke("apply_patch", { input: "*** Begin Patch" }, async () => {
      throw withToolOperatorHint(failure, operatorHint);
    });
    expect(firstLog()).toBe(`[tools] apply_patch failed: Error: ${message} ${operatorHint}`);
    expect(logs()).not.toContain("private-tool-stack-sentinel");
    expect(result.details).toEqual({ status: "error", tool: "apply_patch", error: message });
    expect(JSON.stringify(result)).not.toContain("workspaceOnly");
  });

  it("logs publication error diagnostics without tool arguments or stack", async () => {
    const failure = Object.assign(new Error("Workspace capture stalled; retry publication."), {
      name: "SnapshotTimeoutError",
      code: "SNAPSHOT_TIMEOUT",
      stack: "private-stack-sentinel",
    });
    const result = await invoke("github_publish", { body: "private-pr-body" }, async () => {
      throw failure;
    });
    expect(firstLog()).toBe(
      "[tools] github_publish failed: SnapshotTimeoutError: Workspace capture stalled; retry publication. | SNAPSHOT_TIMEOUT",
    );
    expect(result.details).toMatchObject({ error: failure.message });
    expect(logs()).not.toContain("private-pr-body");
    expect(logs()).not.toContain(failure.stack);
  });

  it.each(["object", "JSON-string", "malformed"])(
    "omits private values from %s exec failure params",
    async (kind) => {
      const commandSecret = "issue85049-private-command-token";
      const envSecret = "issue85049-private-env-token";
      const command = `export XAI_API_KEY=${commandSecret} && echo blocked`;
      const params = { command, cmd: command, env: { OPENAI_API_KEY: envSecret }, timeout: 5 };
      await invoke(
        kind === "object" ? "bash" : "exec",
        kind === "object"
          ? params
          : kind === "JSON-string"
            ? JSON.stringify(params)
            : { command: [command], env: `OPENAI_API_KEY=${envSecret}` },
        async () => {
          throw new Error("exec denied: allowlist miss");
        },
      );
      expect(firstLog()).toBe("[tools] exec failed: Error: exec denied: allowlist miss");
      for (const secret of [commandSecret, envSecret, "export XAI_API_KEY"]) {
        expect(logs()).not.toContain(secret);
      }
    },
  );

  it("rethrows aborted runs without failure logs", async () => {
    const controller = new AbortController();
    controller.abort();
    const execute = vi.fn(async () => ok);
    await expect(
      invoke("web_search", { query: "OpenClaw" }, execute, controller.signal),
    ).rejects.toBe(controller.signal.reason);
    expect(execute).not.toHaveBeenCalled();
    expect(mocks.logError).not.toHaveBeenCalled();
  });
});
