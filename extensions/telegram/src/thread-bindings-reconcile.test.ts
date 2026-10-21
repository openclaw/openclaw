import {
  IncognitoSessionEndedError,
  rethrowIncognitoSessionError,
} from "openclaw/plugin-sdk/acp-runtime";
import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { describe, expect, it, vi } from "vitest";
import { acpHost, useTelegramThreadBindingsFixture } from "./thread-bindings.test-support.js";

describe("telegram thread binding startup reconciliation", () => {
  const fixture = useTelegramThreadBindingsFixture();
  const { createManager, storedBindings } = fixture;
  const options = { accountId: "default", persist: true, enableSweeper: false };
  const storeBinding = async (targetSessionKey: string, conversationId = "thread") => {
    const manager = await createManager(options);
    await getSessionBindingService().bind({
      targetSessionKey,
      targetKind: "session",
      conversation: { channel: "telegram", accountId: "default", conversationId },
    });
    await manager.stop();
  };
  const expectStoredBinding = async (conversationId: string, targetSessionKey: string) => {
    expect(await storedBindings()).toContainEqual(
      expect.objectContaining({ conversationId, targetSessionKey }),
    );
  };

  it.each([
    { target: "agent:main:acp:stale", storeReadFailed: false, retained: false },
    { target: "agent:main:acp:read-failed", storeReadFailed: true, retained: true },
    { target: "plugin-binding:openclaw-codex-app-server:valid", retained: true },
  ])("reconciles $target on restart", async ({ target, storeReadFailed, retained }) => {
    await storeBinding(target);
    if (storeReadFailed !== undefined) {
      acpHost.read.mockResolvedValue({ storeReadFailed });
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

  it("propagates a refused session join without deleting the stored binding", async () => {
    const target = "agent:main:acp:refused";
    await storeBinding(target, "refused");
    const error = new IncognitoSessionEndedError();
    acpHost.read.mockRejectedValue(error);

    await expect(createManager(options)).rejects.toBe(error);
    await expectStoredBinding("refused", target);
  });

  it("retains persisted incognito bindings when prepared cleanup loses authority", async () => {
    const target = "agent:main:dashboard:incognito-prepared";
    await storeBinding(target, "prepared");
    let current = true;
    const error = new IncognitoSessionEndedError();
    const remove = fixture.store.delete.bind(fixture.store);
    const deletion = vi.spyOn(fixture.store, "delete").mockImplementation(async (...args) => {
      current = false;
      return remove(...args);
    });
    const release = vi.fn();
    try {
      const failure = await createManager({
        ...options,
        prepareAcpSession: async () => ({
          session: { cfg: {}, storePath: "/fixture", sessionKey: target, storeSessionKey: target },
          assertCurrent() {
            if (!current) {
              throw error;
            }
          },
          release,
        }),
      }).catch((caught: unknown) => caught);
      expect(() => rethrowIncognitoSessionError(failure)).toThrow();
      await expectStoredBinding("prepared", target);
      expect(release).toHaveBeenCalledOnce();
    } finally {
      deletion.mockRestore();
    }
  });
});
