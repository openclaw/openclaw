import type { MockFn } from "mullusi/plugin-sdk/testing";
import { vi } from "vitest";

export const sendMock: MockFn = vi.fn();
export const reactMock: MockFn = vi.fn();
export const updateLastRouteMock: MockFn = vi.fn();
export const dispatchMock: MockFn = vi.fn();
export const readAllowFromStoreMock: MockFn = vi.fn();
export const upsertPairingRequestMock: MockFn = vi.fn();
export const loadConfigMock: MockFn = vi.fn();

const sendModule = await import("./send.js");
vi.spyOn(sendModule, "sendMessageDiscord").mockImplementation(
  (...args) => sendMock(...args) as never,
);
vi.spyOn(sendModule, "reactMessageDiscord").mockImplementation(async (...args) => {
  reactMock(...args);
  return { ok: true };
});

const replyRuntimeModule = await import("mullusi/plugin-sdk/reply-runtime");
vi.spyOn(replyRuntimeModule, "dispatchInboundMessage").mockImplementation(
  (...args) => dispatchMock(...args) as never,
);
vi.spyOn(replyRuntimeModule, "dispatchInboundMessageWithDispatcher").mockImplementation(
  (...args) => dispatchMock(...args) as never,
);
vi.spyOn(replyRuntimeModule, "dispatchInboundMessageWithBufferedDispatcher").mockImplementation(
  (...args) => dispatchMock(...args) as never,
);

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

const conversationRuntimeModule = await import("mullusi/plugin-sdk/conversation-runtime");
vi.spyOn(conversationRuntimeModule, "readChannelAllowFromStore").mockImplementation(
  createPairingStoreMocks().readChannelAllowFromStore,
);
vi.spyOn(conversationRuntimeModule, "upsertChannelPairingRequest").mockImplementation(
  createPairingStoreMocks().upsertChannelPairingRequest,
);

const configRuntimeModule = await import("mullusi/plugin-sdk/config-runtime");
vi.spyOn(configRuntimeModule, "loadConfig").mockImplementation(
  (...args) => loadConfigMock(...args) as never,
);
vi.spyOn(configRuntimeModule, "readSessionUpdatedAt").mockImplementation(() => undefined);
vi.spyOn(configRuntimeModule, "resolveStorePath").mockImplementation(
  () => "/tmp/mullusi-sessions.json",
);
vi.spyOn(configRuntimeModule, "updateLastRoute").mockImplementation(
  (...args) => updateLastRouteMock(...args) as never,
);
vi.spyOn(configRuntimeModule, "resolveSessionKey").mockImplementation(vi.fn() as never);
