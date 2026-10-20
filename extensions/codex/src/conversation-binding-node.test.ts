import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, expect, it, vi } from "vitest";
import {
  createCodexTestBindingStore,
  createConversationInspection,
} from "./app-server/session-binding.test-helpers.js";
import { handleCodexConversationInboundClaim } from "./conversation-binding-hooks.js";
import {
  conversationMessage,
  createConversationClaimFixtures,
} from "./conversation-binding.test-helpers.js";

const { readBinding, assertCurrent } = vi.hoisted(() => ({
  readBinding: vi.fn<() => { bindingId: string } | null>(),
  assertCurrent: vi.fn<() => Promise<void>>(),
}));

vi.mock("openclaw/plugin-sdk/conversation-binding-inspection-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("openclaw/plugin-sdk/conversation-binding-inspection-runtime")
    >();
  return {
    ...actual,
    inspectConversationBinding: (conversation) =>
      createConversationInspection(conversation, readBinding()?.bindingId),
  } satisfies typeof actual;
});

// This boundary consumes prepared policy; policy selection has its own owner tests.
vi.mock("./app-server/sandbox-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./app-server/sandbox-guard.js")>()),
  prepareCodexNativeSandboxBlock: async () => ({
    block: undefined,
    assertCurrent,
    release() {},
  }),
}));

beforeEach(() => {
  readBinding.mockReset().mockReturnValue({ bindingId: "binding-1" });
  assertCurrent.mockReset().mockResolvedValue();
});

it.each(["unchanged", "detached", "replaced", "policy-refused"])(
  "revalidates a queued node binding that is %s",
  async (bindingState) => {
    const bindingStore = createCodexTestBindingStore();
    const claims = createConversationClaimFixtures(() => "/codex", bindingStore);
    const nodeSession = { nodeId: "mb-m5", sessionId: "node-1", agentId: "main", cwd: "/repo" };
    const firstTurn = createDeferred<{ ok: true; sessionId: string; text: string }>();
    const resumeCodexCliSessionOnNode = vi.fn(() => firstTurn.promise);

    const claim = () =>
      handleCodexConversationInboundClaim(
        conversationMessage("continue the task", {
          senderIsOwner: true,
          channel: "webchat",
          sessionKey: "node-session",
        }),
        claims.conversationClaimContext(
          { kind: "codex-cli-node-session", version: 1, ...nodeSession },
          "node-session",
          { channel: "webchat", conversationId: "node-session" },
        ),
        {
          bindingStore,
          config: { tools: { exec: { host: "node", node: "mb-m5" } } },
          resumeCodexCliSessionOnNode,
          timeoutMs: 1234,
        },
      );

    const running = claim();
    await vi.waitFor(() => expect(resumeCodexCliSessionOnNode).toHaveBeenCalledOnce());
    const queued = claim();
    if (bindingState === "policy-refused") {
      assertCurrent.mockRejectedValueOnce(new Error("Native execution policy changed"));
    } else if (bindingState !== "unchanged") {
      readBinding.mockReturnValue(
        bindingState === "detached" ? null : { bindingId: "replacement-binding" },
      );
    }
    firstTurn.resolve({ ok: true, sessionId: nodeSession.sessionId, text: "done" });
    await expect(running).resolves.toEqual({ handled: true, reply: { text: "done" } });
    const failure =
      bindingState === "policy-refused"
        ? "Codex CLI node turn failed: Native execution policy changed"
        : "This Codex conversation was detached or changed before its message could run.";
    await expect(queued).resolves.toEqual({
      handled: true,
      reply: { text: bindingState === "unchanged" ? "done" : failure },
    });
    expect(resumeCodexCliSessionOnNode).toHaveBeenCalledTimes(bindingState === "unchanged" ? 2 : 1);
    expect(resumeCodexCliSessionOnNode).toHaveBeenCalledWith({
      ...nodeSession,
      sessionKey: "node-session",
      prompt: "continue the task",
      timeoutMs: 1234,
    });
  },
);
