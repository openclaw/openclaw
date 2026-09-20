import type { Tool as SdkTool, ToolInvocation } from "@github/copilot-sdk";
/**
 * Turn-taint wiring through the Copilot tool bridge: the attemptParams
 * `isTurnTainted` gate reaches the coding-tools factory, and per-invocation
 * result provenance survives the SDK tool lifecycle completion.
 */
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  convertOpenClawToolToSdkToolForTest,
  createCopilotToolBridge,
} from "./tool-bridge.test-support.js";

type FakeTool = AnyAgentTool & { execute: ReturnType<typeof vi.fn> };

function flushAsync() {
  return Promise.resolve().then(() => {});
}

function makeInvocation(overrides: Partial<ToolInvocation> = {}): ToolInvocation {
  return {
    arguments: { value: "input" },
    sessionId: "session-1",
    toolCallId: "call-1",
    toolName: "tool-a",
    ...overrides,
  };
}

function makeTool(
  overrides: Partial<FakeTool> = {},
  result: { content?: unknown; details: unknown } = {
    content: [{ text: "done", type: "text" }],
    details: null,
  },
): FakeTool {
  return {
    description: "A fake tool",
    execute: vi.fn(async () => result),
    label: "Fake Tool",
    name: "tool-a",
    parameters: {
      properties: { value: { type: "string" } },
      type: "object",
    } as never,
    ...overrides,
  } as unknown as FakeTool;
}

function runSdkTool(tool: SdkTool, args: unknown, invocation = makeInvocation()) {
  if (!tool.handler) {
    throw new Error(`SDK tool '${tool.name}' has no handler`);
  }
  return tool.handler(args, invocation);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Copilot tool bridge taint wiring", () => {
  it("forwards the attemptParams isTurnTainted gate to the coding-tools factory", async () => {
    const createOpenClawCodingTools = vi.fn(() => [makeTool()]);
    const isTurnTainted = vi.fn(() => true);

    await createCopilotToolBridge({
      attemptParams: {
        runId: "run-1",
        config: { agents: {} },
        onToolOutcome: vi.fn(),
        isTurnTainted,
      } as never,
      createOpenClawCodingTools,
    });

    const opts = (createOpenClawCodingTools.mock.calls[0] as unknown[] | undefined)?.[0] as Record<
      string,
      unknown
    >;
    expect(opts.isTurnTainted).toBe(isTurnTainted);
    expect((opts.isTurnTainted as () => boolean)()).toBe(true);
  });

  it("keeps per-invocation provenance in the lifecycle completion", async () => {
    const onToolCompleted = vi.fn();
    const sourceResult = {
      content: [{ text: "remote PDF text", type: "text" }],
      details: {},
      resultContentSource: "network" as const,
    };
    const sdkTool = await convertOpenClawToolToSdkToolForTest(makeTool({}, sourceResult), {
      onToolCompleted,
    });

    await runSdkTool(sdkTool, { value: "input" }, makeInvocation({ toolCallId: "call-remote" }));
    await flushAsync();

    expect(onToolCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ result: sourceResult, toolCallId: "call-remote" }),
    );
  });
});
