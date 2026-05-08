import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listDevicePairingMock = vi.hoisted(() => vi.fn(async () => ({ pending: [] })));

vi.mock("./api.js", () => ({
  listDevicePairing: listDevicePairingMock,
}));

import { handleNotifyCommand } from "./notify.js";

describe("device-pair notify persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listDevicePairingMock.mockResolvedValue({ pending: [] });
  });

  function createNotifyApi(initialState: unknown) {
    let state = initialState;
    const store = {
      register: vi.fn(async (_key: string, value: unknown) => {
        state = value;
      }),
      registerIfAbsent: vi.fn(async () => false),
      lookup: vi.fn(async () => state),
      consume: vi.fn(),
      delete: vi.fn(),
      entries: vi.fn(async () => []),
      clear: vi.fn(),
    };
    const api = createTestPluginApi({
      runtime: {
        state: {
          resolveStateDir: () => "/tmp/openclaw-test-state",
          openKeyedStore: () => store,
        },
      } as never,
    });
    return { api, readState: () => state };
  }

  it("matches persisted telegram thread ids across number and string roundtrips", async () => {
    const { api, readState } = createNotifyApi({
      subscribers: [
        {
          to: "chat-123",
          accountId: "telegram-default",
          messageThreadId: 271,
          mode: "persistent",
          addedAtMs: 1,
        },
      ],
      notifiedRequestIds: {},
    });
    const status = await handleNotifyCommand({
      api,
      ctx: {
        channel: "telegram",
        senderId: "chat-123",
        accountId: "telegram-default",
        messageThreadId: "271",
      },
      action: "status",
    });

    expect(status.text).toContain("Pair request notifications: enabled for this chat.");
    expect(status.text).toContain("Mode: persistent");

    await handleNotifyCommand({
      api,
      ctx: {
        channel: "telegram",
        senderId: "chat-123",
        accountId: "telegram-default",
        messageThreadId: "271",
      },
      action: "off",
    });

    const persisted = readState() as { subscribers: unknown[] };
    expect(persisted.subscribers).toEqual([]);
  });

  it("does not remove a different persisted subscriber when notify fields contain pipes", async () => {
    const { api, readState } = createNotifyApi({
      subscribers: [
        {
          to: "chat|123",
          accountId: "acct",
          mode: "persistent",
          addedAtMs: 1,
        },
        {
          to: "chat",
          accountId: "123|acct",
          mode: "persistent",
          addedAtMs: 2,
        },
      ],
      notifiedRequestIds: {},
    });

    await handleNotifyCommand({
      api,
      ctx: {
        channel: "telegram",
        senderId: "chat",
        accountId: "123|acct",
      },
      action: "off",
    });

    const status = await handleNotifyCommand({
      api,
      ctx: {
        channel: "telegram",
        senderId: "chat",
        accountId: "123|acct",
      },
      action: "status",
    });
    expect(status.text).toContain("Pair request notifications: disabled for this chat.");

    const persisted = readState() as { subscribers: Array<{ to: string; accountId?: string }> };
    expect(persisted.subscribers).toHaveLength(1);
    expect(persisted.subscribers[0]).toMatchObject({
      to: "chat|123",
      accountId: "acct",
    });
  });
});
