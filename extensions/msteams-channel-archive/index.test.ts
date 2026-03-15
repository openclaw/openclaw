import { beforeEach, describe, expect, it, vi } from "vitest";

const archiveStoreMock = {
  archiveMessage: vi.fn(),
  pruneConversation: vi.fn(),
};

vi.mock("./src/archive-store.js", () => ({
  createArchiveStore: () => archiveStoreMock,
}));

vi.mock("./src/tools.js", () => ({
  registerArchiveTools: vi.fn(),
}));

vi.mock("./src/channel-cleanup.js", () => ({
  createChannelArchiveCleanupService: vi.fn(() => ({ id: "cleanup-service" })),
}));

describe("msteams channel archive plugin", () => {
  type RegisteredHook = (...args: unknown[]) => unknown;
  const hooks: Record<string, RegisteredHook> = {};
  const api = {
    runtime: {
      state: {
        resolveStateDir: () => "/tmp/openclaw-state",
      },
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    registerService: vi.fn(),
    on: vi.fn((hookName: string, handler: RegisteredHook) => {
      hooks[hookName] = handler;
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    archiveStoreMock.archiveMessage.mockReset();
    archiveStoreMock.pruneConversation.mockReset();
    for (const key of Object.keys(hooks)) {
      delete hooks[key];
    }
  });

  it("registers channel_deleted and prunes deleted Teams channel archives", async () => {
    const plugin = (await import("./index.js")).default;
    plugin.register(api as never);

    expect(api.on).toHaveBeenCalledWith("channel_deleted", expect.any(Function));

    await hooks.channel_deleted(
      {
        conversationId: "19:deleted@thread.tacv2",
        metadata: { provider: "msteams" },
      },
      {
        channelId: "msteams",
        conversationId: "19:deleted@thread.tacv2",
      },
    );

    expect(archiveStoreMock.pruneConversation).toHaveBeenCalledWith("19:deleted@thread.tacv2");
  });

  it("preserves empty mediaTypes slots when archiving channel messages", async () => {
    const plugin = (await import("./index.js")).default;
    plugin.register(api as never);

    await hooks.message_received(
      {
        content: "archive this",
        timestamp: 1710000000000,
        metadata: {
          provider: "msteams",
          chatType: "channel",
          mediaPaths: ["/tmp/a.png", "/tmp/b.pdf", "/tmp/c.txt"],
          mediaTypes: ["image/png", "", "text/plain"],
          providerMetadata: {
            conversationType: "channel",
            tenantId: "tenant-1",
            teamId: "team-1",
            channelId: "channel-1",
          },
        },
      },
      {
        channelId: "msteams",
        conversationId: "conversation:19:alerts@thread.tacv2",
      },
    );

    expect(archiveStoreMock.archiveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "19:alerts@thread.tacv2",
        mediaPaths: ["/tmp/a.png", "/tmp/b.pdf", "/tmp/c.txt"],
        mediaTypes: ["image/png", "", "text/plain"],
      }),
    );
  });
});
