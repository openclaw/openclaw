import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { splitSdkTools } from "./pi-embedded-runner.js";
import { toToolDefinitions } from "./pi-tool-definition-adapter.js";
import * as beforeToolCallMod from "./pi-tools.before-tool-call.js";

function createReadTool() {
  return {
    name: "read",
    label: "Read",
    description: "reads",
    parameters: Type.Object({}),
    execute: vi.fn(async () => ({ content: [], details: { ok: true } })),
  } satisfies AgentTool;
}

type ToolExecute = ReturnType<typeof toToolDefinitions>[number]["execute"];
const extensionContext = {} as Parameters<ToolExecute>[4];

describe("hookContext threading", () => {
  const runBeforeSpy = vi.spyOn(beforeToolCallMod, "runBeforeToolCallHook");
  const isWrappedSpy = vi.spyOn(beforeToolCallMod, "isToolWrappedWithBeforeToolCallHook");

  beforeEach(() => {
    runBeforeSpy.mockClear();
    runBeforeSpy.mockImplementation(async ({ params }) => ({
      blocked: false,
      params,
    }));
    isWrappedSpy.mockClear();
    isWrappedSpy.mockReturnValue(false);
  });

  const hookContext = {
    agentId: "test-agent",
    sessionKey: "test-session",
    sessionId: "test-session-id",
    runId: "test-run-id",
  };

  describe("toToolDefinitions", () => {
    it("passes hookContext as ctx to runBeforeToolCallHook", async () => {
      const defs = toToolDefinitions([createReadTool()], hookContext);
      const def = defs[0];
      if (!def) {
        throw new Error("missing tool definition");
      }
      await def.execute("call-ctx", { path: "/tmp/file" }, undefined, undefined, extensionContext);

      expect(runBeforeSpy).toHaveBeenCalledOnce();
      expect(runBeforeSpy).toHaveBeenCalledWith(expect.objectContaining({ ctx: hookContext }));
    });

    it("passes ctx as undefined when hookContext is omitted", async () => {
      const defs = toToolDefinitions([createReadTool()]);
      const def = defs[0];
      if (!def) {
        throw new Error("missing tool definition");
      }
      await def.execute(
        "call-no-ctx",
        { path: "/tmp/file" },
        undefined,
        undefined,
        extensionContext,
      );

      expect(runBeforeSpy).toHaveBeenCalledOnce();
      expect(runBeforeSpy).toHaveBeenCalledWith(expect.objectContaining({ ctx: undefined }));
    });
  });

  describe("splitSdkTools", () => {
    it("threads hookContext through to runBeforeToolCallHook", async () => {
      const { customTools } = splitSdkTools({
        tools: [createReadTool()],
        sandboxEnabled: false,
        hookContext,
      });
      const def = customTools[0];
      if (!def) {
        throw new Error("missing tool definition");
      }
      await def.execute(
        "call-split",
        { path: "/tmp/file" },
        undefined,
        undefined,
        extensionContext,
      );

      expect(runBeforeSpy).toHaveBeenCalledOnce();
      expect(runBeforeSpy).toHaveBeenCalledWith(expect.objectContaining({ ctx: hookContext }));
    });
  });
});
