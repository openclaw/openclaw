import type { MockFn } from "openclaw/plugin-sdk/testing";
import { vi } from "vitest";

export const sendMock: MockFn = vi.fn();
export const reactMock: MockFn = vi.fn();
export const recordInboundSessionMock: MockFn = vi.fn();
export const updateLastRouteMock: MockFn = vi.fn();
export const dispatchMock: MockFn = vi.fn();
export const readAllowFromStoreMock: MockFn = vi.fn();
export const upsertPairingRequestMock: MockFn = vi.fn();

vi.mock("./send.js", () => ({
  addRoleDiscord: vi.fn(),
  banMemberDiscord: vi.fn(),
  createChannelDiscord: vi.fn(),
  createScheduledEventDiscord: vi.fn(),
  createThreadDiscord: vi.fn(),
  deleteChannelDiscord: vi.fn(),
  deleteMessageDiscord: vi.fn(),
  editChannelDiscord: vi.fn(),
  editMessageDiscord: vi.fn(),
  fetchChannelInfoDiscord: vi.fn(),
  fetchChannelPermissionsDiscord: vi.fn(),
  fetchMemberInfoDiscord: vi.fn(),
  fetchMessageDiscord: vi.fn(),
  fetchReactionsDiscord: vi.fn(),
  fetchRoleInfoDiscord: vi.fn(),
  fetchVoiceStatusDiscord: vi.fn(),
  hasAnyGuildPermissionDiscord: vi.fn(),
  kickMemberDiscord: vi.fn(),
  listGuildChannelsDiscord: vi.fn(),
  listGuildEmojisDiscord: vi.fn(),
  listPinsDiscord: vi.fn(),
  listScheduledEventsDiscord: vi.fn(),
  listThreadsDiscord: vi.fn(),
  moveChannelDiscord: vi.fn(),
  pinMessageDiscord: vi.fn(),
  reactMessageDiscord: async (...args: unknown[]) => {
    reactMock(...args);
  },
  readMessagesDiscord: vi.fn(),
  removeChannelPermissionDiscord: vi.fn(),
  removeOwnReactionsDiscord: vi.fn(),
  removeReactionDiscord: vi.fn(),
  removeRoleDiscord: vi.fn(),
  searchMessagesDiscord: vi.fn(),
  sendDiscordComponentMessage: vi.fn(),
  sendMessageDiscord: (...args: unknown[]) => sendMock(...args),
  sendPollDiscord: vi.fn(),
  sendStickerDiscord: vi.fn(),
  sendVoiceMessageDiscord: vi.fn(),
  setChannelPermissionDiscord: vi.fn(),
  timeoutMemberDiscord: vi.fn(),
  unpinMessageDiscord: vi.fn(),
  uploadEmojiDiscord: vi.fn(),
  uploadStickerDiscord: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/reply-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/reply-runtime")>();
  return {
    ...actual,
    dispatchInboundMessage: (...args: unknown[]) => dispatchMock(...args),
    dispatchInboundMessageWithDispatcher: (...args: unknown[]) => dispatchMock(...args),
    dispatchInboundMessageWithBufferedDispatcher: (...args: unknown[]) => dispatchMock(...args),
  };
});

function createPairingStoreMocks() {
  return {
    readChannelAllowFromStore(...args: unknown[]) {
      return readAllowFromStoreMock(...args);
    },
    upsertChannelPairingRequest(...args: unknown[]) {
      return upsertPairingRequestMock(...args);
    },
  };
}

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>();
  return {
    ...actual,
    ...createPairingStoreMocks(),
  };
});

vi.mock("openclaw/plugin-sdk/channel-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-runtime")>();
  return {
    ...actual,
    recordInboundSession: (...args: unknown[]) => recordInboundSessionMock(...args),
  };
});

vi.mock("openclaw/plugin-sdk/config-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/config-runtime")>();
  return {
    ...actual,
    readSessionUpdatedAt: vi.fn(() => undefined),
    resolveStorePath: vi.fn(() => "/tmp/openclaw-sessions.json"),
    updateLastRoute: (...args: unknown[]) => updateLastRouteMock(...args),
    resolveSessionKey: vi.fn(),
  };
});
