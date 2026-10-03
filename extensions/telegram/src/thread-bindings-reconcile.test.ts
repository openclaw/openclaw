import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { describe, expect, it } from "vitest";
import { acpHost, useTelegramThreadBindingsFixture } from "./thread-bindings.test-support.js";

describe("telegram thread binding startup reconciliation", () => {
  const { createManager, storedBindings } = useTelegramThreadBindingsFixture();

  it.each([
    { target: "agent:main:acp:stale", storeReadFailed: false, retained: false },
    { target: "agent:main:acp:read-failed", storeReadFailed: true, retained: true },
    { target: "plugin-binding:openclaw-codex-app-server:valid", retained: true },
  ])("reconciles $target on restart", async ({ target, storeReadFailed, retained }) => {
    const options = { accountId: "default", persist: true, enableSweeper: false };
    const manager = await createManager(options);
    await getSessionBindingService().bind({
      targetSessionKey: target,
      targetKind: "session",
      conversation: { channel: "telegram", accountId: "default", conversationId: "thread" },
    });
    await manager.stop();
    if (storeReadFailed !== undefined) {
      acpHost.read.mockReturnValue({
        cfg: {},
        storePath: "/tmp/acp-store.json",
        sessionKey: target,
        storeSessionKey: target,
        entry: undefined,
        acp: undefined,
        storeReadFailed,
      });
    }
    const reloaded = await createManager(options);
    if (retained) {
      expect(reloaded.getByConversationId("thread")?.targetSessionKey).toBe(target);
    } else {
      expect(reloaded.getByConversationId("thread")).toBeUndefined();
      expect((await storedBindings()).map((binding) => binding.conversationId)).not.toContain(
        "thread",
      );
    }
    if (storeReadFailed === undefined) {
      expect(acpHost.read).not.toHaveBeenCalled();
    }
  });
});
