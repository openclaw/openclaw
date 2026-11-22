import { afterEach, expect, it, vi } from "vitest";
import { createCopilotTestHostCapabilities } from "./host-capability.test-support.js";
import { createCopilotToolBridge } from "./tool-bridge.test-support.js";

const mocks = vi.hoisted(() => ({ createRuntime: vi.fn() }));
vi.mock("openclaw/plugin-sdk/agent-harness-tool-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-tool-runtime")>()),
  createAgentHarnessToolSurfaceRuntimeAsync: mocks.createRuntime,
}));

afterEach(() => vi.clearAllMocks());

it.each([{ disableTools: true }, { modelRun: true }])(
  "builds no tool surface runtime for a run that constructs no tools: %j",
  async (attemptParams) => {
    const bridge = await createCopilotToolBridge({
      attemptParams: { hostCapabilities: createCopilotTestHostCapabilities(), ...attemptParams },
    });

    expect(mocks.createRuntime).not.toHaveBeenCalled();
    expect(bridge.sourceTools).toEqual([]);
    expect(bridge.codeModeEngaged).toBe(false);
  },
);
