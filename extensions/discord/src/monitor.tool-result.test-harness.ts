import type { MockFn } from "openclaw/plugin-sdk/testing";
import { vi } from "vitest";

export const sendMock: MockFn = vi.fn();
export const reactMock: MockFn = vi.fn();
export const updateLastRouteMock: MockFn = vi.fn();
export const dispatchMock: MockFn = vi.fn();
export const readAllowFromStoreMock: MockFn = vi.fn();
export const upsertPairingRequestMock: MockFn = vi.fn();
export const loadConfigMock: MockFn = vi.fn();

vi.mock("./send.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./send.js")>();
  return {
    ...actual,
    sendMessageDiscord: (...args: unknown[]) => sendMock(...args),
    reactMessageDiscord: async (...args: unknown[]) => {
      reactMock(...args);
    },
  };
});

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

vi.mock("openclaw/plugin-sdk/config-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/config-runtime")>();
  return {
    ...actual,
    loadConfig: (...args: unknown[]) => loadConfigMock(...args),
    readSessionUpdatedAt: vi.fn(() => undefined),
    resolveStorePath: vi.fn(() => "/tmp/openclaw-sessions.json"),
    readSessionUpdatedAt: vi.fn(() => undefined),
    updateLastRoute: (...args: unknown[]) => updateLastRouteMock(...args),
    resolveSessionKey: vi.fn(),
  };
});
