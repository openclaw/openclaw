import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
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
  readBinding: vi.fn<() => string | undefined>(),
  assertCurrent: vi.fn<() => Promise<void>>(),
}));

vi.mock(
  import("openclaw/plugin-sdk/conversation-binding-inspection-runtime"),
  async (original) => ({
    ...(await original()),
    inspectConversationBinding: (conversation) =>
      createConversationInspection(conversation, readBinding()),
  }),
);

// This boundary consumes prepared policy; policy selection has its own owner tests.
vi.mock(import("./app-server/sandbox-guard.js"), async (original) => ({
  ...(await original()),
  prepareCodexNativeSandboxBlock: async () => ({ block: undefined, assertCurrent, release() {} }),
}));

const reply = (text: string) => ({ handled: true, reply: { text } });

it.each(["unchanged", "detached", "replaced", "policy-refused"])(
  "revalidates a queued node binding that is %s",
  async (bindingState) => {
    readBinding.mockReset().mockReturnValue("binding-1");
    assertCurrent.mockReset().mockResolvedValue();
    const bindingStore = createCodexTestBindingStore();
    const claims = createConversationClaimFixtures(() => "/codex", bindingStore);
    const nodeSession = { nodeId: "mb-m5", sessionId: "node-1", agentId: "main", cwd: "/repo" };
    const firstTurn = createDeferred<{ ok: true; sessionId: string; text: string }>();
    const resume = vi.fn(() => firstTurn.promise);

    const claim = () =>
      handleCodexConversationInboundClaim(
        conversationMessage("continue", { senderIsOwner: true, sessionKey: "node-session" }),
        claims.conversationClaimContext(
          { kind: "codex-cli-node-session", version: 1, ...nodeSession },
          "node-session",
        ),
        {
          bindingStore,
          resumeCodexCliSessionOnNode: resume,
        },
      );

    const running = claim();
    await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());
    const queued = claim();
    if (bindingState === "policy-refused") {
      assertCurrent.mockRejectedValueOnce(new Error("Native execution policy changed"));
    } else if (bindingState !== "unchanged") {
      readBinding.mockReturnValue(bindingState === "detached" ? undefined : "replacement-binding");
    }
    firstTurn.resolve({ ok: true, sessionId: nodeSession.sessionId, text: "done" });
    await expect(running).resolves.toEqual(reply("done"));
    const failure =
      bindingState === "policy-refused"
        ? "Codex CLI node turn failed: Native execution policy changed"
        : "This Codex conversation was detached or changed before its message could run.";
    await expect(queued).resolves.toEqual(reply(bindingState === "unchanged" ? "done" : failure));
    expect(resume).toHaveBeenCalledTimes(bindingState === "unchanged" ? 2 : 1);
    expect(resume).toHaveBeenCalledWith({
      ...nodeSession,
      sessionKey: "node-session",
      prompt: "continue",
    });
  },
);
