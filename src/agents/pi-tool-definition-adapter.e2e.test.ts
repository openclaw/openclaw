import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { toToolDefinitions } from "./pi-tool-definition-adapter.js";

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

  describe("splitToolExecuteArgs — arg format handling", () => {
    function createCaptureTool() {
      let captured:
        | {
            toolCallId: string;
            params: unknown;
            hasSignal: boolean;
            hasOnUpdate: boolean;
          }
        | undefined;
      const tool: AgentTool = {
        name: "capture",
        label: "Capture",
        description: "captures args",
        parameters: Type.Object({ foo: Type.String() }),
        execute: async (toolCallId, params, signal, onUpdate) => {
          captured = {
            toolCallId,
            params,
            hasSignal: signal !== undefined,
            hasOnUpdate: onUpdate !== undefined,
          };
          return { content: [{ type: "text" as const, text: "ok" }], details: {} };
        },
      };
      return { tool, getCaptured: () => captured };
    }

    it("handles current format: [id, params, signal, onUpdate, extensionCtx]", async () => {
      const { tool, getCaptured } = createCaptureTool();
      const defs = toToolDefinitions([tool]);
      const signal = new AbortController().signal;
      const onUpdate = () => {};
      await defs[0].execute("call-1", { foo: "bar" }, signal, onUpdate, extensionContext);
      expect(getCaptured()).toMatchObject({
        toolCallId: "call-1",
        params: { foo: "bar" },
        hasSignal: true,
        hasOnUpdate: true,
      });
    });

    it("handles current format with undefined signal/onUpdate", async () => {
      const { tool, getCaptured } = createCaptureTool();
      const defs = toToolDefinitions([tool]);
      await defs[0].execute("call-2", { foo: "baz" }, undefined, undefined, extensionContext);
      expect(getCaptured()).toMatchObject({
        toolCallId: "call-2",
        params: { foo: "baz" },
        hasSignal: false,
        hasOnUpdate: false,
      });
    });

    it("handles empty params {}", async () => {
      const { tool, getCaptured } = createCaptureTool();
      const defs = toToolDefinitions([tool]);
      await defs[0].execute("call-3", {}, undefined, undefined, extensionContext);
      expect(getCaptured()).toMatchObject({
        toolCallId: "call-3",
        params: {},
      });
    });

    it("handles legacy format: [id, params, onUpdate, ctx, signal]", async () => {
      const { tool, getCaptured } = createCaptureTool();
      const defs = toToolDefinitions([tool]);
      const signal = new AbortController().signal;
      const onUpdate = () => {};
      // Legacy format: 3rd arg is function (onUpdate), 5th is AbortSignal
      await (defs[0].execute as Function)("call-4", { foo: "legacy" }, onUpdate, {}, signal);
      expect(getCaptured()).toMatchObject({
        toolCallId: "call-4",
        params: { foo: "legacy" },
        hasSignal: true,
        hasOnUpdate: true,
      });
    });
  });
});
