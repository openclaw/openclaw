import { getSessionBindingService } from "openclaw/plugin-sdk/conversation-runtime";
import { describe, expect, it } from "vitest";
import { acpHost, useTelegramThreadBindingsFixture } from "./thread-bindings.test-support.js";

const readAcpSessionEntryMock = acpHost.read;

describe("telegram thread binding startup reconciliation", () => {
  const fixture = useTelegramThreadBindingsFixture();
  const { createManager: createTelegramThreadBindingManager, storedBindings } = fixture;

  it("cleans up stale ACP bindings before restart routing can reuse them", async () => {
    const manager = await createTelegramThreadBindingManager({
      accountId: "default",
      persist: true,
      enableSweeper: false,
    });

    await getSessionBindingService().bind({
      targetSessionKey: "agent:main:acp:stale-1",
      targetKind: "session",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "cleanup-me",
      },
    });

    await manager.stop();
    readAcpSessionEntryMock.mockReturnValue({
      cfg: {} as never,
      storePath: "/tmp/acp-store.json",
      sessionKey: "agent:main:acp:stale-1",
      storeSessionKey: "agent:main:acp:stale-1",
      entry: undefined,
      acp: undefined,
      storeReadFailed: false,
    });

    const reloaded = await createTelegramThreadBindingManager({
      accountId: "default",
      persist: true,
      enableSweeper: false,
    });

    expect(reloaded.getByConversationId("cleanup-me")).toBeUndefined();
    expect((await storedBindings()).map((binding) => binding.conversationId)).not.toContain(
      "cleanup-me",
    );
  });

  it("keeps plugin-owned bindings when ACP cleanup runs on startup", async () => {
    const manager = await createTelegramThreadBindingManager({
      accountId: "default",
      persist: true,
      enableSweeper: false,
    });

    await getSessionBindingService().bind({
      targetSessionKey: "plugin-binding:openclaw-codex-app-server:still-valid",
      targetKind: "session",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "plugin-binding-convo",
      },
    });

    await manager.stop();

    const reloaded = await createTelegramThreadBindingManager({
      accountId: "default",
      persist: true,
      enableSweeper: false,
    });

    expect(reloaded.getByConversationId("plugin-binding-convo")?.targetSessionKey).toBe(
      "plugin-binding:openclaw-codex-app-server:still-valid",
    );
    expect(readAcpSessionEntryMock).not.toHaveBeenCalled();
  });

  it("keeps ACP bindings when the session store cannot be read during startup cleanup", async () => {
    const manager = await createTelegramThreadBindingManager({
      accountId: "default",
      persist: true,
      enableSweeper: false,
    });

    await getSessionBindingService().bind({
      targetSessionKey: "agent:main:acp:read-failed",
      targetKind: "session",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "keep-on-read-failure",
      },
    });

    await manager.stop();
    readAcpSessionEntryMock.mockReturnValue({
      cfg: {} as never,
      storePath: "/tmp/acp-store.json",
      sessionKey: "agent:main:acp:read-failed",
      storeSessionKey: "agent:main:acp:read-failed",
      entry: undefined,
      acp: undefined,
      storeReadFailed: true,
    });

    const reloaded = await createTelegramThreadBindingManager({
      accountId: "default",
      persist: true,
      enableSweeper: false,
    });

    expect(reloaded.getByConversationId("keep-on-read-failure")?.targetSessionKey).toBe(
      "agent:main:acp:read-failed",
    );
  });
});
