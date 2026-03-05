import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock sendMessageFeishu before importing the manager
vi.mock("./send.js", () => ({
  sendMessageFeishu: vi.fn().mockResolvedValue({ messageId: "om_intro_msg_1", chatId: "oc_chat1" }),
}));

// Mock plugin-sdk session binding registration
const registeredAdapters = new Map<string, any>();
vi.mock("openclaw/plugin-sdk", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    registerSessionBindingAdapter: vi.fn((adapter: any) => {
      registeredAdapters.set(`${adapter.channel}:${adapter.accountId}`, adapter);
    }),
    unregisterSessionBindingAdapter: vi.fn((params: any) => {
      registeredAdapters.delete(`${params.channel}:${params.accountId}`);
    }),
    normalizeAccountId: (id?: string) => (id?.trim() || "default").toLowerCase(),
  };
});

import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { sendMessageFeishu } from "./send.js";
import {
  createFeishuThreadBindingManager,
  resetManagersForTests,
} from "./thread-bindings.manager.js";
import { resetForTests } from "./thread-bindings.state.js";

const mockSend = vi.mocked(sendMessageFeishu);

function makeCfg(): ClawdbotConfig {
  return {} as ClawdbotConfig;
}

beforeEach(() => {
  resetManagersForTests();
  resetForTests();
  registeredAdapters.clear();
  mockSend.mockReset();
  mockSend.mockResolvedValue({ messageId: "om_intro_msg_1", chatId: "oc_chat1" });
});

afterEach(() => {
  resetManagersForTests();
  resetForTests();
  registeredAdapters.clear();
});

describe("createFeishuThreadBindingManager", () => {
  it("registers a session binding adapter on creation", () => {
    const manager = createFeishuThreadBindingManager({
      accountId: "test-acc",
      cfg: makeCfg(),
      persist: false,
      enableSweeper: false,
    });

    expect(registeredAdapters.has("feishu:test-acc")).toBe(true);
    manager.stop();
    expect(registeredAdapters.has("feishu:test-acc")).toBe(false);
  });

  it("binds a target by sending intro + reply messages", async () => {
    const manager = createFeishuThreadBindingManager({
      accountId: "acc1",
      cfg: makeCfg(),
      persist: false,
      enableSweeper: false,
    });

    const record = await manager.bind({
      chatId: "oc_chat1",
      targetKind: "acp",
      targetSessionKey: "agent:default:feishu:group:oc_chat1",
      introText: "Hello thread!",
    });

    expect(record).not.toBeNull();
    expect(record!.chatId).toBe("oc_chat1");
    expect(record!.rootId).toBe("om_intro_msg_1");
    expect(record!.targetSessionKey).toBe("agent:default:feishu:group:oc_chat1");

    // Two messages: intro + thread activation reply
    expect(mockSend).toHaveBeenCalledTimes(2);
    // First call: intro message
    expect(mockSend.mock.calls[0][0]).toMatchObject({
      to: "chat:oc_chat1",
      text: "Hello thread!",
    });
    // Second call: thread activation reply
    expect(mockSend.mock.calls[1][0]).toMatchObject({
      to: "chat:oc_chat1",
      replyToMessageId: "om_intro_msg_1",
      replyInThread: true,
    });

    manager.stop();
  });

  it("retrieves binding by key after bind", async () => {
    const manager = createFeishuThreadBindingManager({
      accountId: "acc1",
      cfg: makeCfg(),
      persist: false,
      enableSweeper: false,
    });

    await manager.bind({
      chatId: "oc_chat1",
      targetKind: "acp",
      targetSessionKey: "agent:default:feishu:group:oc_chat1",
    });

    const found = manager.getByKey("oc_chat1", "om_intro_msg_1");
    expect(found).not.toBeUndefined();
    expect(found!.targetSessionKey).toBe("agent:default:feishu:group:oc_chat1");

    manager.stop();
  });

  it("lists bindings by session key", async () => {
    const manager = createFeishuThreadBindingManager({
      accountId: "acc1",
      cfg: makeCfg(),
      persist: false,
      enableSweeper: false,
    });

    let callCount = 0;
    mockSend.mockImplementation(async () => {
      callCount++;
      return { messageId: `om_msg_${callCount}`, chatId: "oc_chat1" };
    });

    const sessionKey = "agent:default:feishu:group:oc_chat1";
    await manager.bind({ chatId: "oc_chat1", targetKind: "acp", targetSessionKey: sessionKey });
    await manager.bind({ chatId: "oc_chat1", targetKind: "acp", targetSessionKey: sessionKey });

    const list = manager.listBySessionKey(sessionKey);
    expect(list).toHaveLength(2);

    manager.stop();
  });

  it("unbinds a binding and sends farewell", async () => {
    const manager = createFeishuThreadBindingManager({
      accountId: "acc1",
      cfg: makeCfg(),
      persist: false,
      enableSweeper: false,
    });

    await manager.bind({
      chatId: "oc_chat1",
      targetKind: "acp",
      targetSessionKey: "sess1",
    });

    mockSend.mockClear();
    const removed = manager.unbind("oc_chat1", "om_intro_msg_1", {
      reason: "test-done",
      sendFarewell: true,
    });

    expect(removed).not.toBeNull();
    expect(removed!.rootId).toBe("om_intro_msg_1");
    expect(manager.getByKey("oc_chat1", "om_intro_msg_1")).toBeUndefined();
    // Farewell message sent
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "chat:oc_chat1",
        replyToMessageId: "om_intro_msg_1",
        replyInThread: true,
      }),
    );

    manager.stop();
  });

  it("unbinds by session key", async () => {
    const manager = createFeishuThreadBindingManager({
      accountId: "acc1",
      cfg: makeCfg(),
      persist: false,
      enableSweeper: false,
    });

    await manager.bind({
      chatId: "oc_chat1",
      targetKind: "acp",
      targetSessionKey: "sess1",
    });

    const removed = manager.unbindBySessionKey("sess1");
    expect(removed).toHaveLength(1);
    expect(manager.listBindings()).toHaveLength(0);

    manager.stop();
  });

  it("touches a binding and updates lastActivityAt", async () => {
    const manager = createFeishuThreadBindingManager({
      accountId: "acc1",
      cfg: makeCfg(),
      persist: false,
      enableSweeper: false,
    });

    await manager.bind({
      chatId: "oc_chat1",
      targetKind: "acp",
      targetSessionKey: "sess1",
    });

    const before = manager.getByKey("oc_chat1", "om_intro_msg_1")!.lastActivityAt;
    const futureTime = Date.now() + 60_000;
    const updated = manager.touch("oc_chat1", "om_intro_msg_1", futureTime);
    expect(updated!.lastActivityAt).toBeGreaterThanOrEqual(futureTime);
    expect(updated!.lastActivityAt).toBeGreaterThan(before);

    manager.stop();
  });

  it("returns null for bind with empty chatId", async () => {
    const manager = createFeishuThreadBindingManager({
      accountId: "acc1",
      cfg: makeCfg(),
      persist: false,
      enableSweeper: false,
    });

    const result = await manager.bind({
      chatId: "",
      targetKind: "acp",
      targetSessionKey: "sess1",
    });
    expect(result).toBeNull();

    manager.stop();
  });

  it("returns null for bind when send fails", async () => {
    mockSend.mockRejectedValue(new Error("API error"));

    const manager = createFeishuThreadBindingManager({
      accountId: "acc1",
      cfg: makeCfg(),
      persist: false,
      enableSweeper: false,
    });

    const result = await manager.bind({
      chatId: "oc_chat1",
      targetKind: "acp",
      targetSessionKey: "sess1",
    });
    expect(result).toBeNull();

    manager.stop();
  });
});

describe("session binding adapter", () => {
  it("adapter bind with child placement creates thread", async () => {
    const manager = createFeishuThreadBindingManager({
      accountId: "acc1",
      cfg: makeCfg(),
      persist: false,
      enableSweeper: false,
    });

    const adapter = registeredAdapters.get("feishu:acc1");
    expect(adapter).toBeDefined();
    expect(adapter.capabilities.placements).toContain("child");

    const result = await adapter.bind({
      targetSessionKey: "sess1",
      targetKind: "session",
      conversation: {
        channel: "feishu",
        accountId: "acc1",
        conversationId: "oc_chat1",
        parentConversationId: "oc_chat1",
      },
      placement: "child",
      metadata: { introText: "Hello from ACP" },
    });

    expect(result).not.toBeNull();
    expect(result!.conversation.channel).toBe("feishu");
    expect(result!.targetSessionKey).toBe("sess1");

    manager.stop();
  });

  it("adapter bind with current placement binds existing thread", async () => {
    const manager = createFeishuThreadBindingManager({
      accountId: "acc1",
      cfg: makeCfg(),
      persist: false,
      enableSweeper: false,
    });

    const adapter = registeredAdapters.get("feishu:acc1");
    const result = await adapter.bind({
      targetSessionKey: "sess1",
      targetKind: "session",
      conversation: {
        channel: "feishu",
        accountId: "acc1",
        conversationId: "oc_chat1:om_existing_root",
      },
      placement: "current",
    });

    expect(result).not.toBeNull();
    expect(result!.conversation.conversationId).toBe("oc_chat1:om_existing_root");

    manager.stop();
  });

  it("adapter resolveByConversation finds bound thread", async () => {
    const manager = createFeishuThreadBindingManager({
      accountId: "acc1",
      cfg: makeCfg(),
      persist: false,
      enableSweeper: false,
    });

    await manager.bind({
      chatId: "oc_chat1",
      targetKind: "acp",
      targetSessionKey: "sess1",
    });

    const adapter = registeredAdapters.get("feishu:acc1");
    const resolved = adapter.resolveByConversation({
      channel: "feishu",
      accountId: "acc1",
      conversationId: "oc_chat1:om_intro_msg_1",
    });

    expect(resolved).not.toBeNull();
    expect(resolved!.targetSessionKey).toBe("sess1");

    manager.stop();
  });

  it("adapter resolveByConversation returns null for unknown thread", () => {
    const manager = createFeishuThreadBindingManager({
      accountId: "acc1",
      cfg: makeCfg(),
      persist: false,
      enableSweeper: false,
    });

    const adapter = registeredAdapters.get("feishu:acc1");
    const resolved = adapter.resolveByConversation({
      channel: "feishu",
      accountId: "acc1",
      conversationId: "oc_chat1:om_nonexistent",
    });

    expect(resolved).toBeNull();

    manager.stop();
  });

  it("adapter listBySession returns bound sessions", async () => {
    const manager = createFeishuThreadBindingManager({
      accountId: "acc1",
      cfg: makeCfg(),
      persist: false,
      enableSweeper: false,
    });

    await manager.bind({
      chatId: "oc_chat1",
      targetKind: "acp",
      targetSessionKey: "sess1",
    });

    const adapter = registeredAdapters.get("feishu:acc1");
    const list = adapter.listBySession("sess1");
    expect(list).toHaveLength(1);
    expect(list[0].targetSessionKey).toBe("sess1");

    manager.stop();
  });
});
