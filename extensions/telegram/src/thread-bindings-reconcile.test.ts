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

  it("propagates a refused session join without deleting the stored binding", async () => {
    const options = { accountId: "default", persist: true, enableSweeper: false };
    const manager = await createManager(options);
    const target = "agent:main:acp:refused";
    await getSessionBindingService().bind({
      targetSessionKey: target,
      targetKind: "session",
      conversation: { channel: "telegram", accountId: "default", conversationId: "refused" },
    });
    await manager.stop();
    const error = new IncognitoSessionEndedError();
    acpHost.read.mockImplementation(() => {
      throw error;
    });

    await expect(createManager(options)).rejects.toBe(error);
    expect(await storedBindings()).toContainEqual(
      expect.objectContaining({ conversationId: "refused", targetSessionKey: target }),
    );
  });

  it("retains persisted incognito bindings when prepared cleanup loses authority", async () => {
    const options = { accountId: "default", persist: true, enableSweeper: false };
    const manager = await createManager(options);
    const target = "agent:main:dashboard:incognito-prepared";
    await getSessionBindingService().bind({
      targetSessionKey: target,
      targetKind: "session",
      conversation: { channel: "telegram", accountId: "default", conversationId: "prepared" },
    });
    await manager.stop();
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
      }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(() => rethrowIncognitoSessionError(failure)).toThrow();
      expect(await storedBindings()).toContainEqual(
        expect.objectContaining({ conversationId: "prepared", targetSessionKey: target }),
      );
      expect(release).toHaveBeenCalledOnce();
    } finally {
      deletion.mockRestore();
    }
  });
});
