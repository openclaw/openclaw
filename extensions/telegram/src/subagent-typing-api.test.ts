// Telegram tests cover detached-subagent hook wiring behavior.
import type {
  OpenClawPluginApi,
  PluginRuntimeLifecycleRegistration,
} from "openclaw/plugin-sdk/core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerTelegramSubagentTyping } from "../subagent-typing-api.js";

const controllerMocks = vi.hoisted(() => ({
  handle: vi.fn(),
  dispose: vi.fn(),
  create: vi.fn(),
}));

vi.mock("./subagent-typing.js", () => ({
  createTelegramSubagentTyping: controllerMocks.create,
}));

describe("Telegram detached-subagent hook wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    controllerMocks.create.mockReturnValue({
      handle: controllerMocks.handle,
      dispose: controllerMocks.dispose,
    });
  });

  it("preserves typing across session cleanup and disposes on plugin retirement", async () => {
    let progressHandler: ((event: unknown, context: unknown) => unknown) | undefined;
    const registerRuntimeLifecycle = vi.fn();
    const api = createTestPluginApi({
      id: "telegram",
      on: ((hookName, handler) => {
        if (hookName === "subagent_progress") {
          progressHandler = handler as (event: unknown, context: unknown) => unknown;
        }
      }) as OpenClawPluginApi["on"],
      registerRuntimeLifecycle,
    });
    registerTelegramSubagentTyping(api);
    const event = startEventForTest();

    expect(progressHandler?.(event, {})).toBeUndefined();
    await vi.waitFor(() => expect(controllerMocks.handle).toHaveBeenCalledWith(event));

    const lifecycle = registerRuntimeLifecycle.mock
      .calls[0]?.[0] as PluginRuntimeLifecycleRegistration;
    await lifecycle.cleanup?.({ reason: "reset", sessionKey: "agent:main:root" });
    await lifecycle.cleanup?.({ reason: "delete", sessionKey: "agent:main:root" });
    expect(controllerMocks.dispose).not.toHaveBeenCalled();

    progressHandler?.({ ...event, runId: "run-2" }, {});
    await vi.waitFor(() => expect(controllerMocks.handle).toHaveBeenCalledTimes(2));

    await lifecycle.cleanup?.({ reason: "restart" });
    expect(controllerMocks.dispose).toHaveBeenCalledOnce();
  });
});

function startEventForTest() {
  return {
    phase: "started" as const,
    runId: "run-1",
    childSessionKey: "agent:main:subagent:child",
    requester: { channel: "telegram", to: "42" },
  };
}
