import { vi } from "vitest";
const registerPluginHttpRouteMock = vi.fn(
  () => vi.fn()
);
const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockResolvedValue({ counts: {} });
async function readRequestBodyWithLimitForTest(req) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
vi.mock("openclaw/plugin-sdk/synology-chat", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  setAccountEnabledInConfigSection: vi.fn((_opts) => ({})),
  registerPluginHttpRoute: registerPluginHttpRouteMock,
  buildChannelConfigSchema: vi.fn((schema) => ({ schema })),
  readRequestBodyWithLimit: vi.fn(readRequestBodyWithLimitForTest),
  isRequestBodyLimitError: vi.fn(() => false),
  requestBodyErrorToText: vi.fn(() => "Request body too large"),
  createFixedWindowRateLimiter: vi.fn(() => ({
    isRateLimited: vi.fn(() => false),
    size: vi.fn(() => 0),
    clear: vi.fn()
  }))
}));
vi.mock("./client.js", () => ({
  sendMessage: vi.fn().mockResolvedValue(true),
  sendFileUrl: vi.fn().mockResolvedValue(true)
}));
vi.mock("./runtime.js", () => ({
  getSynologyRuntime: vi.fn(() => ({
    config: { loadConfig: vi.fn().mockResolvedValue({}) },
    channel: {
      reply: {
        dispatchReplyWithBufferedBlockDispatcher
      }
    }
  }))
}));
function makeSecurityAccount(overrides = {}) {
  return {
    accountId: "default",
    enabled: true,
    token: "t",
    incomingUrl: "https://nas/incoming",
    nasHost: "h",
    webhookPath: "/w",
    dmPolicy: "allowlist",
    allowedUserIds: [],
    rateLimitPerMinute: 30,
    botName: "Bot",
    allowInsecureSsl: false,
    ...overrides
  };
}
export {
  dispatchReplyWithBufferedBlockDispatcher,
  makeSecurityAccount,
  registerPluginHttpRouteMock
};
