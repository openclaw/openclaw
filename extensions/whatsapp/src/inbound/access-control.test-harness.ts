import { beforeEach, vi } from "vitest";

type AsyncMock<TArgs extends unknown[] = unknown[], TResult = unknown> = {
  (...args: TArgs): Promise<TResult>;
  mockReset: () => AsyncMock<TArgs, TResult>;
  mockResolvedValue: (value: TResult) => AsyncMock<TArgs, TResult>;
  mockResolvedValueOnce: (value: TResult) => AsyncMock<TArgs, TResult>;
};

export const sendMessageMock = vi.fn() as AsyncMock;
export const readAllowFromStoreMock = vi.fn() as AsyncMock;
export const upsertPairingRequestMock = vi.fn() as AsyncMock;

let config: Record<string, unknown> = {};

export function setAccessControlTestConfig(next: Record<string, unknown>): void {
  config = next;
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
    readAllowFromStoreMock.mockReset().mockResolvedValue([]);
    upsertPairingRequestMock.mockReset().mockResolvedValue({ code: "PAIRCODE", created: true });
  });
}

vi.mock("openclaw/plugin-sdk/config-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/config-runtime")>();
  return {
    ...actual,
    loadConfig: () => config,
  };
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
