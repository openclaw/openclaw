import { beforeEach, vi } from "vitest";
import {
  type AsyncMock,
  loadConfigMock,
  readAllowFromStoreMock as pairingReadAllowFromStoreMock,
  resetPairingSecurityMocks,
  upsertPairingRequestMock as pairingUpsertPairingRequestMock,
} from "../pairing-security.test-harness.js";

export const sendMessageMock = vi.fn() as AsyncMock;
export const readAllowFromStoreMock = pairingReadAllowFromStoreMock;
export const upsertPairingRequestMock = pairingUpsertPairingRequestMock;

let config: Record<string, unknown> = {};

export function setAccessControlTestConfig(next: Record<string, unknown>): void {
  config = next;
  loadConfigMock.mockReturnValue(config);
}

export function setupAccessControlTestHarness(): void {
  beforeEach(() => {
    config = {
      channels: {
        whatsapp: {
          dmPolicy: "pairing",
          allowFrom: [],
        },
      },
    };
    sendMessageMock.mockReset().mockResolvedValue(undefined);
    resetPairingSecurityMocks(config);
  });
}

vi.mock("openclaw/plugin-sdk/config-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/config-runtime")>();
  const mockModule = Object.create(null) as Record<string, unknown>;
  Object.defineProperties(mockModule, Object.getOwnPropertyDescriptors(actual));
  Object.defineProperty(mockModule, "loadConfig", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: () => config,
  });
  return mockModule;
});

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>();
  return {
    ...actual,
    upsertChannelPairingRequest: (...args: unknown[]) => upsertPairingRequestMock(...args),
  };
});

vi.mock("openclaw/plugin-sdk/security-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/security-runtime")>();
  return {
    ...actual,
    readStoreAllowFromForDmPolicy: async (
      params: Parameters<typeof actual.readStoreAllowFromForDmPolicy>[0],
    ) =>
      await actual.readStoreAllowFromForDmPolicy({
        ...params,
        readStore: async (provider, accountId) =>
          (await readAllowFromStoreMock(provider, accountId)) as string[],
      }),
  };
});
