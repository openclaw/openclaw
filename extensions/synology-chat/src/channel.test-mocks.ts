import type { IncomingMessage, ServerResponse } from "node:http";
import type { Mock } from "vitest";
import { vi } from "vitest";

export type RegisteredRoute = {
  path: string;
  accountId: string;
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
};

export const registerPluginHttpRouteMock: Mock<(params: RegisteredRoute) => () => void> = vi.fn(
  () => vi.fn(),
);

export const dispatchReplyWithBufferedBlockDispatcher: Mock<
  () => Promise<{ counts: Record<string, number> }>
> = vi.fn().mockResolvedValue({ counts: {} });

async function readRequestBodyWithLimitForTest(req: IncomingMessage): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

vi.mock("../api.js", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  setAccountEnabledInConfigSection: vi.fn((_opts: unknown) => ({})),
  registerPluginHttpRoute: registerPluginHttpRouteMock,
  buildChannelConfigSchema: vi.fn((schema: unknown) => ({ schema })),
  readRequestBodyWithLimit: vi.fn(readRequestBodyWithLimitForTest),
  isRequestBodyLimitError: vi.fn(() => false),
  requestBodyErrorToText: vi.fn(() => "Request body too large"),
  createFixedWindowRateLimiter: vi.fn(() => ({
    isRateLimited: vi.fn(() => false),
    size: vi.fn(() => 0),
    clear: vi.fn(),
  })),
}));

vi.mock("./client.js", () => ({
  sendMessage: vi.fn().mockResolvedValue(true),
  sendFileUrl: vi.fn().mockResolvedValue(true),
}));

vi.mock("./runtime.js", () => ({
  getSynologyRuntime: vi.fn(() => ({
    config: { loadConfig: vi.fn().mockResolvedValue({}) },
    channel: {
      reply: {
        dispatchReplyWithBufferedBlockDispatcher,
      },
    },
  })),
}));

export function makeSecurityAccount(overrides: Record<string, unknown> = {}) {
  return {
    accountId: "default",
    enabled: true,
    token: "t",
    incomingUrl: "https://nas/incoming",
    nasHost: "h",
    webhookPath: "/w",
    dmPolicy: "allowlist" as const,
    allowedUserIds: [],
    rateLimitPerMinute: 30,
    botName: "Bot",
    allowInsecureSsl: false,
    ...overrides,
  };
}
