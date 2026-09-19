import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexTestBindingStore } from "./app-server/session-binding.test-helpers.js";
import { handleCodexConversationInboundClaim } from "./conversation-binding-hooks.js";

const publicBindingMocks = vi.hoisted(() => ({
  resolveByConversation: vi.fn<() => { bindingId: string } | null>(),
}));

vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", () => ({
  getSessionBindingService: () => ({
    resolveByConversation: publicBindingMocks.resolveByConversation,
  }),
}));

describe("Codex node conversation bindings", () => {
  beforeEach(() => {
    publicBindingMocks.resolveByConversation
      .mockReset()
      .mockReturnValue({ bindingId: "binding-1" });
  });

  it.each(["unchanged", "detached", "replaced"])(
    "revalidates a queued node binding that is %s",
    async (bindingState) => {
      const firstTurn = createDeferred<void>();
      const resumeCodexCliSessionOnNode = vi.fn(async () => {
        await firstTurn.promise;
        return {
          ok: true as const,
          sessionId: "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd",
          text: "done",
        };
      });

      const claim = () =>
        handleCodexConversationInboundClaim(
          {
            content: "continue the task",
            senderIsOwner: true,
            channel: "webchat",
            isGroup: false,
            commandAuthorized: true,
            sessionKey: "node-session",
          },
          {
            channelId: "webchat",
            sessionKey: "node-session",
            pluginBinding: {
              bindingId: "binding-1",
              pluginId: "codex",
              pluginRoot: "/synthetic/codex",
              channel: "webchat",
              accountId: "default",
              conversationId: "node-session",
              boundAt: Date.now(),
              data: {
                kind: "codex-cli-node-session",
                version: 1,
                nodeId: "mb-m5",
                sessionId: "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd",
                agentId: "main",
                cwd: "/repo",
              },
            },
          },
          {
            bindingStore: createCodexTestBindingStore(),
            config: { tools: { exec: { host: "node", node: "mb-m5" } } },
            resumeCodexCliSessionOnNode,
            timeoutMs: 1234,
          },
        );

      const running = claim();
      await vi.waitFor(() => expect(resumeCodexCliSessionOnNode).toHaveBeenCalledOnce());
      const queued = claim();
      if (bindingState !== "unchanged") {
        publicBindingMocks.resolveByConversation.mockReturnValue(
          bindingState === "detached" ? null : { bindingId: "replacement-binding" },
        );
      }
      firstTurn.resolve();
      await expect(running).resolves.toEqual({ handled: true, reply: { text: "done" } });
      await expect(queued).resolves.toEqual({
        handled: true,
        reply: {
          text:
            bindingState === "unchanged"
              ? "done"
              : "This Codex conversation was detached or changed before its message could run.",
        },
      });
      expect(resumeCodexCliSessionOnNode).toHaveBeenCalledTimes(
        bindingState === "unchanged" ? 2 : 1,
      );
      expect(resumeCodexCliSessionOnNode).toHaveBeenCalledWith({
        nodeId: "mb-m5",
        sessionId: "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd",
        agentId: "main",
        sessionKey: "node-session",
        prompt: "continue the task",
        cwd: "/repo",
        timeoutMs: 1234,
      });
    },
  );
});
