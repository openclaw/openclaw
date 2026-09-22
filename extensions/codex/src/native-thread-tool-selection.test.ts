import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { createCodexTestBindingStore } from "./app-server/session-binding.test-helpers.js";
import type { codexControlRequest } from "./command-rpc.js";
import { createCodexThreadsTool } from "./native-thread-tool.js";

describe("native Codex thread selection", () => {
  it.each(["metadata", "thread", "connection", "session", "model-lock", "config"] as const)(
    "revalidates a native request after a %s change",
    async (change) => {
      const bindingStore = createCodexTestBindingStore();
      const identity = {
        kind: "session" as const,
        agentId: "main",
        sessionId: "session-id",
        sessionKey: "agent:main:selection",
      };
      const binding = { threadId: "bound-thread", cwd: "/synthetic/workspace" };
      await bindingStore.mutate(identity, { kind: "set", binding });
      let config: OpenClawConfig = {};
      const session = {
        sessionId: identity.sessionId,
        modelSelectionLocked: false,
        inputTokens: 0,
      };
      const runtime = createPluginRuntimeMock({
        agent: {
          session: {
            getSessionEntry: () => ({ ...session, updatedAt: Date.now() }),
          },
        },
      });
      const dispatch = vi.fn(() => ({ data: [] }));
      const request = vi.fn<typeof codexControlRequest>();
      request.mockImplementation(async (_config, _method, _params, options = {}) => {
        await bindingStore.mutate(identity, {
          kind: "set",
          binding: {
            ...binding,
            threadId: change === "thread" ? "replacement-thread" : binding.threadId,
            ...(change === "connection" ? { appServerRuntimeFingerprint: "replacement" } : {}),
            historyCoveredThrough: "2026-09-16T12:00:00Z",
            continuityCalibration: { promptChars: 2000, inputTokens: 200 },
          },
        });
        session.inputTokens = 200;
        if (change === "session") {
          session.sessionId = "replacement-session";
        } else if (change === "model-lock") {
          session.modelSelectionLocked = true;
        } else if (change === "config") {
          config = { ...config };
        }
        expect(options.assertCurrent).toBeTypeOf("function");
        options.assertCurrent!();
        return dispatch();
      });
      const tool = createCodexThreadsTool({
        bindingStore,
        runtime,
        context: {
          ...identity,
          agentDir: "/synthetic/agent",
          workspaceDir: binding.cwd,
          senderIsOwner: true,
          getRuntimeConfig: () => config,
        },
        getPluginConfig: () => ({ appServer: { homeScope: "user" } }),
        request,
      });

      const pending = tool!.execute("selection-change", { action: "list" });
      if (change === "metadata") {
        await expect(pending).resolves.toMatchObject({ details: { data: [] } });
        expect(dispatch).toHaveBeenCalledOnce();
      } else {
        await expect(pending).rejects.toThrow("native thread ownership changed");
        expect(dispatch).not.toHaveBeenCalled();
      }
    },
  );
});
