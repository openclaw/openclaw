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

vi.mock("openclaw/plugin-sdk/security-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/security-runtime")>();
  return {
    ...actual,
    readStoreAllowFromForDmPolicy: (...args: unknown[]) => readAllowFromStoreMock(...args),
  };
});

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>();
  return {
    ...actual,
    upsertChannelPairingRequest: (...args: unknown[]) => upsertPairingRequestMock(...args),
    issuePairingChallenge: async (params: {
      upsertPairingRequest: (params: {
        id: string;
        meta?: Record<string, string | undefined>;
      }) => Promise<{ code: string; created: boolean }>;
      sendPairingReply: (text: string) => Promise<void>;
      senderId: string;
      senderIdLine: string;
      meta?: Record<string, string | undefined>;
    }) => {
      const result = await params.upsertPairingRequest({
        id: params.senderId,
        meta: params.meta,
      });
      if (!result.created) {
        return { created: false };
      }
      await params.sendPairingReply(
        `OpenClaw: access not configured.\n\n${params.senderIdLine}\n\nPairing code: ${result.code}\n\nAsk the bot owner to approve with:\nopenclaw pairing approve whatsapp ${result.code}`,
      );
      return { created: true, code: result.code };
    },
  };
});
