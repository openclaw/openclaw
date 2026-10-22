import "./session-authority.test-support.js";
import type { OpenClawPluginApi, PluginRuntime } from "openclaw/plugin-sdk/core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createSessionVisibilityChecker } from "openclaw/plugin-sdk/session-visibility";
import { afterEach, vi } from "vitest";
import { registerClickClackDiscussions } from "./register.js";

vi.mock("openclaw/plugin-sdk/session-discussion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/session-discussion")>()),
  registerSessionDiscussionProvider: vi.fn(),
}));

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

export function captureDiscussionRegistration(runtime: PluginRuntime) {
  const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
  const registerRuntimeLifecycle =
    vi.fn<OpenClawPluginApi["lifecycle"]["registerRuntimeLifecycle"]>();
  const registerAccess = vi
    .spyOn(createSessionVisibilityChecker, "registerScopedAccessProvider")
    .mockReturnValue(() => undefined);
  const api = createTestPluginApi({ runtime, registerTool, registerRuntimeLifecycle });
  const on = vi.spyOn(api, "on");
  try {
    registerClickClackDiscussions(api);
    const hook = vi.mocked(api.on<"before_tool_call">).mock.calls[0]?.[1];
    const access = registerAccess.mock.calls[0]?.[0];
    const tool = registerTool.mock.calls[0]?.[0];
    const cleanup = registerRuntimeLifecycle.mock.calls[0]?.[0].cleanup;
    if (!hook || !access || typeof tool !== "function" || !cleanup) {
      throw new Error("Expected ClickClack discussion registrations");
    }
    cleanups.push(() => cleanup({ reason: "disable" }));
    return {
      run: hook,
      target: (requesterSessionKey: string, targetSessionKey: string) =>
        access({ action: "history", requesterSessionKey, targetSessionKey }),
      tool(sessionKey?: string) {
        const result = tool({ sessionKey });
        if (!result || Array.isArray(result)) {
          throw new Error("Expected one registered discussion tool");
        }
        return result;
      },
    };
  } finally {
    on.mockRestore();
    registerAccess.mockRestore();
  }
}
