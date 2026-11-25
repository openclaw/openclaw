import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareTelegramConversationFork } from "./conversation-fork.js";

const mocks = vi.hoisted(() => ({ bind: vi.fn(), create: vi.fn(), capabilities: vi.fn() }));
// mock-isolation: Exercise topic placement with a fake binding owner, without opening Gateway storage.
vi.mock("openclaw/plugin-sdk/session-binding-runtime", () => ({
  getSessionBindingService: () => ({ bind: mocks.bind, getCapabilities: mocks.capabilities }),
}));
// mock-isolation: Observe native topic creation without loading a live Telegram transport.
vi.mock("./send-runtime.js", () => ({
  loadTelegramSendModule: async () => ({ createForumTopicTelegram: mocks.create }),
}));
const params = () => ({
  cfg: {
    channels: { telegram: { accounts: { work: { botToken: "123456:telegram-fork-fixture" } } } },
  },
  accountId: "work",
  source: { conversationId: "-100123:topic:7", parentConversationId: "-100123", threadId: "7" },
  isGroup: true,
  senderId: "42",
  assertCurrent: vi.fn(),
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.capabilities.mockReturnValue({ bindSupported: true, placements: ["current"] });
  mocks.create.mockResolvedValue({ chatId: "-100123", topicId: 89 });
  mocks.bind.mockImplementation(async (input) => ({
    ...input,
    status: "active",
    bindingId: "work:89",
    boundAt: 1,
  }));
});

describe("Telegram conversation fork", () => {
  it("creates a sibling topic then binds its exact identity as an ordinary session", async () => {
    const request = params();
    const prepared = await prepareTelegramConversationFork({ ...request, title: "Branch" });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) {
      throw new Error(prepared.reason);
    }
    const created = await prepared.create("agent:main:fork:child");
    expect(mocks.create).toHaveBeenCalledWith(
      "-100123",
      "Branch",
      expect.objectContaining({
        accountId: "work",
        assertPlatformSendAuthorized: expect.any(Function),
      }),
    );
    expect(mocks.bind).toHaveBeenCalledWith(
      expect.objectContaining({
        targetKind: "session",
        targetSessionKey: "agent:main:fork:child",
        placement: "current",
        conversation: {
          channel: "telegram",
          accountId: "work",
          conversationId: "-100123:topic:89",
          parentConversationId: "-100123",
        },
        assertCurrent: expect.any(Function),
      }),
    );
    expect(created.url).toBe("https://t.me/c/123/89");
  });

  it("rejects DMs, channel-direct topics, unthreaded groups and overlong titles before creation", async () => {
    for (const source of [
      { conversationId: "42:topic:7" },
      { conversationId: "-100123:direct-topic:7" },
      { conversationId: "-100123" },
    ]) {
      expect((await prepareTelegramConversationFork({ ...params(), source })).ok).toBe(false);
    }
    expect(
      (await prepareTelegramConversationFork({ ...params(), title: "x".repeat(129) })).ok,
    ).toBe(false);
    mocks.capabilities.mockReturnValue({ bindSupported: false, placements: [] });
    expect((await prepareTelegramConversationFork(params())).ok).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.bind).not.toHaveBeenCalled();
  });

  it("does not create after authority closes and retains a known topic after binding failure", async () => {
    const request = params();
    const prepared = await prepareTelegramConversationFork(request);
    if (!prepared.ok) {
      throw new Error(prepared.reason);
    }
    request.assertCurrent.mockImplementation(() => {
      throw new Error("retired");
    });
    await expect(prepared.create("child")).rejects.toThrow("retired");
    expect(mocks.create).not.toHaveBeenCalled();
    request.assertCurrent.mockReset();
    mocks.bind.mockRejectedValue(new Error("disk write failed"));
    await expect(prepared.create("child")).rejects.toThrow(
      "https://t.me/c/123/89 was created, but its session binding was not confirmed",
    );
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
});
