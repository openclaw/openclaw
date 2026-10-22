import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import {
  flattenCodexDynamicToolFunctions,
  type CodexDynamicToolSpec,
  type JsonValue,
} from "./protocol.js";

export function registerCodexAutomationToolReferenceTests() {
  describe("Codex automation tool references", () => {
    function tool(name: string, overrides: Partial<AnyAgentTool> = {}): AnyAgentTool {
      return {
        name,
        label: name,
        description: `Test ${name}`,
        parameters: Type.Object({}, { additionalProperties: true }),
        execute: async () => ({ content: [], details: {} }),
        ...overrides,
      };
    }

    function setup(options: { registeredSpecs?: CodexDynamicToolSpec[] } = {}) {
      const execute = vi.fn(async (_id: string, args: unknown) => ({
        content: [{ type: "text" as const, text: "observed" }],
        details: args,
      }));
      const tools = [
        tool("automations", { execute }),
        tool("read"),
        tool("sandbox_exec", { catalogMode: "direct-only" }),
        tool("fixture__lookup_note"),
        tool("openclaw__read"),
        tool("openclaw_direct__read"),
        tool("_probe"),
      ];
      const bridge = createCodexDynamicToolBridge({
        tools,
        registeredSpecs: options.registeredSpecs,
        signal: new AbortController().signal,
        loading: "searchable",
      });
      async function call(args: JsonValue) {
        return bridge.handleToolCall({
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-1",
          namespace: "openclaw",
          tool: "automations",
          arguments: args,
        });
      }
      return { call, execute };
    }

    function automationArgs(toolsAllow: JsonValue): JsonValue {
      return {
        action: "add",
        job: {
          name: "reminder",
          payload: { kind: "agentTurn", message: "Read the note.", toolsAllow },
        },
      };
    }

    function received(execute: ReturnType<typeof setup>["execute"]) {
      expect(execute).toHaveBeenCalledTimes(1);
      return execute.mock.calls[0]?.[1];
    }

    it.each([
      {
        label: "unknown, wrong-namespace and non-string entries",
        toolsAllow: [
          "openclaw__missing",
          "openclaw__sandbox_exec",
          "openclaw_direct__fixture__lookup_note",
          7,
          "read",
        ],
      },
      { label: "a non-array allowlist", toolsAllow: null },
    ])("leaves $label unchanged for the automation validator", async ({ toolsAllow }) => {
      const { call, execute } = setup();
      const input = automationArgs(toolsAllow);
      await call(input);
      expect(received(execute)).toEqual(input);
    });

    it("uses inherited native declarations instead of guessing namespaces from executable metadata", async () => {
      const { call, execute } = setup({
        registeredSpecs: [
          {
            type: "namespace",
            name: "openclaw_direct",
            description: "Inherited declaration",
            tools: flattenCodexDynamicToolFunctions(
              createCodexDynamicToolBridge({
                tools: [tool("automations"), tool("read")],
                loading: "direct",
                signal: new AbortController().signal,
              }).specs,
            ),
          },
        ],
      });
      await call(automationArgs(["openclaw_direct__read", "openclaw__read"]));
      expect(received(execute)).toEqual(automationArgs(["read", "openclaw__read"]));
    });

    it.each<{ label: string; wrap: (toolsAllow: string[]) => JsonValue }>([
      {
        label: "data-wrapped job",
        wrap: (toolsAllow) => ({ action: "add", job: { data: { payload: { toolsAllow } } } }),
      },
      {
        label: "job-wrapped patch",
        wrap: (toolsAllow) => ({ action: "update", job: { job: { toolsAllow } } }),
      },
      {
        label: "recoverable padded field",
        wrap: (toolsAllow) => ({ action: "add", job: { "toolsAllow ": toolsAllow } }),
      },
      {
        label: "recoverable concatenated payload",
        wrap: (toolsAllow) => ({ action: "add", namePayload: { toolsAllow } }),
      },
    ])("resolves references without rewriting the supported $label shape", async ({ wrap }) => {
      const { call, execute } = setup();
      const input = wrap(["openclaw__fixture__lookup_note"]);
      const original = structuredClone(input);
      await call(input);
      expect(received(execute)).toEqual(wrap(["fixture__lookup_note"]));
      expect(input).toEqual(original);
    });
  });
}
