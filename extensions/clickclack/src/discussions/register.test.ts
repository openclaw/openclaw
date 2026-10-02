import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawPluginApi, PluginRuntime } from "openclaw/plugin-sdk/core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { registerSessionDiscussionProvider } from "openclaw/plugin-sdk/session-discussion";
import { createSessionVisibilityChecker } from "openclaw/plugin-sdk/session-visibility";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerClickClackDiscussions } from "./register.js";
import {
  asyncDiscussionTestStore,
  createDiscussionMemoryStore,
  discussionConfig,
} from "./service-test-support.js";

vi.mock("openclaw/plugin-sdk/session-discussion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/session-discussion")>()),
  registerSessionDiscussionProvider: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(registerSessionDiscussionProvider).mockClear();
});

describe("ClickClack discussion registration lifecycle", () => {
  it.each([
    { sessionReason: "reset", reason: "restart" },
    { sessionReason: "delete", reason: "disable" },
  ] as const)(
    "keeps discussions available through $sessionReason and stops on whole-plugin $reason",
    async ({ sessionReason, reason }) => {
      const config = discussionConfig();
      const openSyncKeyedStore = <T>() => createDiscussionMemoryStore<T>();
      const runtime = createPluginRuntimeMock({
        config: { current: () => config },
        state: {
          openSyncKeyedStore,
          openKeyedStore: <T>(options: Parameters<PluginRuntime["state"]["openKeyedStore"]>[0]) =>
            asyncDiscussionTestStore<T>(openSyncKeyedStore, options),
        },
      });
      const registerService = vi.fn<OpenClawPluginApi["registerService"]>();
      const registerRuntimeLifecycle =
        vi.fn<OpenClawPluginApi["lifecycle"]["registerRuntimeLifecycle"]>();
      const unregisterSessionAccess = vi.fn();
      vi.spyOn(createSessionVisibilityChecker, "registerScopedAccessProvider").mockReturnValue(
        unregisterSessionAccess,
      );
      const api = createTestPluginApi({ runtime, registerService, registerRuntimeLifecycle });
      registerClickClackDiscussions(api);

      const service = registerService.mock.calls.find(
        ([entry]) => entry.id === "clickclack-discussion-session-events",
      )?.[0];
      const cleanup = registerRuntimeLifecycle.mock.calls.find(
        ([entry]) => entry.id === "clickclack-discussions",
      )?.[0].cleanup;
      const provider = vi
        .mocked(registerSessionDiscussionProvider)
        .mock.calls.find(([entry]) => entry.id === "clickclack")?.[0];
      if (!service || !cleanup || !provider) {
        throw new Error("Expected the registered ClickClack discussion lifecycle");
      }
      const context = { config, stateDir: "/unused", logger: api.logger };
      const request = { sessionKey: "agent:main:discussion", agentId: "main" };
      try {
        await service.start(context);
        await expect(provider.info(request)).resolves.toEqual({ state: "available" });

        for (const scope of [
          { reason: sessionReason, sessionKey: "agent:main:unrelated" },
          { reason: sessionReason },
          { reason, sessionKey: "agent:main:unrelated" },
          { reason, runId: "synthetic-run" },
        ] as const) {
          await cleanup(scope);
          await expect(provider.info(request)).resolves.toEqual({ state: "available" });
          expect(unregisterSessionAccess).not.toHaveBeenCalled();
        }

        await cleanup({ reason });
        await expect(provider.info(request)).rejects.toThrow("discussion service is stopped");
        expect(unregisterSessionAccess).toHaveBeenCalledOnce();
      } finally {
        await service.stop?.(context);
      }
    },
  );
});
