import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the client module
vi.mock("./client.js", () => ({
  whoami: vi.fn(),
  getLastEmail: vi.fn(),
  getEmails: vi.fn(),
}));

// Mock auth module
vi.mock("./auth.js", () => ({
  resolveAccessToken: vi.fn().mockResolvedValue("test-token"),
}));

import { whoami, getLastEmail, getEmails } from "./client.js";
import { startPolling } from "./monitor.js";
import type { ResolvedInboxApiAccount, InboxApiEmail } from "./types.js";

function makeAccount(overrides: Partial<ResolvedInboxApiAccount> = {}): ResolvedInboxApiAccount {
  return {
    accountId: "default",
    enabled: true,
    mcpEndpoint: "https://mcp.inboxapi.ai/mcp",
    credentialsPath: "~/.local/inboxapi/credentials.json",
    accessToken: "test-token",
    domain: "test.inboxapi.ai",
    fromName: "TestBot",
    pollIntervalMs: 50, // fast for tests
    pollBatchSize: 20,
    dmPolicy: "open",
    allowFrom: [],
    textChunkLimit: 50_000,
    ...overrides,
  };
}

function makeEmail(overrides: Partial<InboxApiEmail> = {}): InboxApiEmail {
  return {
    id: "e1",
    messageId: `<${Date.now()}@example.com>`,
    from: "sender@example.com",
    to: "bot@inboxapi.ai",
    subject: "Test",
    text: "Hello",
    date: new Date().toISOString(),
    ...overrides,
  };
}

describe("startPolling", () => {
  beforeEach(() => {
    vi.mocked(whoami).mockReset();
    vi.mocked(getLastEmail).mockReset();
    vi.mocked(getEmails).mockReset();
  });

  it("verifies identity on startup", async () => {
    const controller = new AbortController();
    vi.mocked(whoami).mockResolvedValue({
      accountName: "test",
      email: "test@inboxapi.ai",
      domain: "inboxapi.ai",
    });
    vi.mocked(getLastEmail).mockResolvedValue(null);
    vi.mocked(getEmails).mockResolvedValue([]);

    // Abort after a short delay
    setTimeout(() => controller.abort(), 100);

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await startPolling({
      account: makeAccount(),
      deliver: vi.fn(),
      log,
      abortSignal: controller.signal,
    });

    expect(whoami).toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("connected as test"));
  });

  it("stops when no access token", async () => {
    const { resolveAccessToken } = await import("./auth.js");
    vi.mocked(resolveAccessToken).mockResolvedValueOnce("");

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await startPolling({
      account: makeAccount({ accessToken: "" }),
      deliver: vi.fn(),
      log,
    });

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("no access token"));
  });

  it("delivers new emails", async () => {
    const controller = new AbortController();
    const deliver = vi.fn();
    const email = makeEmail({ messageId: "<new@example.com>" });

    vi.mocked(whoami).mockResolvedValue({
      accountName: "test",
      email: "test@inboxapi.ai",
      domain: "inboxapi.ai",
    });
    vi.mocked(getLastEmail).mockResolvedValue(null);

    let callCount = 0;
    vi.mocked(getEmails).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return [email];
      // Abort after first successful poll
      controller.abort();
      return [];
    });

    await startPolling({
      account: makeAccount(),
      deliver,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      abortSignal: controller.signal,
    });

    expect(deliver).toHaveBeenCalledWith(email);
  });

  it("skips emails not in allowlist", async () => {
    const controller = new AbortController();
    const deliver = vi.fn();
    const email = makeEmail({ from: "blocked@example.com" });

    vi.mocked(whoami).mockResolvedValue({
      accountName: "test",
      email: "test@inboxapi.ai",
      domain: "inboxapi.ai",
    });
    vi.mocked(getLastEmail).mockResolvedValue(null);

    let callCount = 0;
    vi.mocked(getEmails).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return [email];
      controller.abort();
      return [];
    });

    await startPolling({
      account: makeAccount({ dmPolicy: "allowlist", allowFrom: ["allowed@example.com"] }),
      deliver,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      abortSignal: controller.signal,
    });

    expect(deliver).not.toHaveBeenCalled();
  });

  it("does not re-deliver seen emails", async () => {
    const controller = new AbortController();
    const deliver = vi.fn();
    const email = makeEmail({ messageId: "<seen@example.com>" });

    vi.mocked(whoami).mockResolvedValue({
      accountName: "test",
      email: "test@inboxapi.ai",
      domain: "inboxapi.ai",
    });
    vi.mocked(getLastEmail).mockResolvedValue(null);

    let callCount = 0;
    vi.mocked(getEmails).mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) return [email]; // same email both polls
      controller.abort();
      return [];
    });

    await startPolling({
      account: makeAccount(),
      deliver,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      abortSignal: controller.signal,
    });

    // Should only be delivered once despite appearing in two polls
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
