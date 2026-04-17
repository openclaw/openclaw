import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DelegatedTaskHook } from "./tools/sessions-send-delegated-task.js";

const createSessionsSendToolMock = vi.fn((_options?: unknown) => ({
  name: "sessions_send",
  description: "sessions_send test tool",
  parameters: {
    type: "object",
    properties: {},
  },
  async execute() {
    return { content: [] };
  },
}));

vi.mock("./tools/sessions-send-tool.js", () => ({
  createSessionsSendTool: (options?: unknown) => createSessionsSendToolMock(options),
}));

import { __testing, createOpenClawTools } from "./openclaw-tools.js";

function createDelegatedTaskHookStub(): DelegatedTaskHook {
  return {
    buildContext: () => "delegated task context",
    start: () => {},
  };
}

describe("createOpenClawTools A2A registration", () => {
  beforeEach(() => {
    createSessionsSendToolMock.mockClear();
    __testing.setDepsForTest();
  });

  it("threads a caller-provided delegated task hook into sessions_send", () => {
    const delegatedTaskHook = createDelegatedTaskHookStub();

    createOpenClawTools({
      delegatedTaskHook,
      disablePluginTools: true,
    });

    expect(createSessionsSendToolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        delegatedTaskHook,
      }),
    );
  }, 240_000);

  it("falls back to the shared delegated task hook factory", () => {
    const delegatedTaskHook = createDelegatedTaskHookStub();
    __testing.setDepsForTest({
      createDelegatedTaskHook: () => delegatedTaskHook,
    });

    createOpenClawTools({
      disablePluginTools: true,
    });

    expect(createSessionsSendToolMock).toHaveBeenCalledWith(
      expect.objectContaining({
        delegatedTaskHook,
      }),
    );
  });
});
