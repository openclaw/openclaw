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

// Mock SDK dm-policy functions used by monitor.ts
const mockReadStoreAllowFrom = vi.fn().mockResolvedValue([]);
const mockResolveDmGroupAccess = vi.fn().mockReturnValue({
  decision: "allow",
  reason: "open",
  effectiveAllowFrom: [],
  effectiveGroupAllowFrom: [],
});
vi.mock("openclaw/plugin-sdk/inboxapi", () => ({
  readStoreAllowFromForDmPolicy: (...args: any[]) => mockReadStoreAllowFrom(...args),
  resolveDmGroupAccessWithLists: (...args: any[]) => mockResolveDmGroupAccess(...args),
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
    mockReadStoreAllowFrom.mockReset().mockResolvedValue([]);
    mockResolveDmGroupAccess.mockReset().mockReturnValue({
      decision: "allow",
      reason: "open",
      effectiveAllowFrom: [],
      effectiveGroupAllowFrom: [],
    });
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

  it("skips emails blocked by DM policy", async () => {
    const controller = new AbortController();
    const deliver = vi.fn();
    const email = makeEmail({ from: "blocked@example.com" });

    vi.mocked(whoami).mockResolvedValue({
      accountName: "test",
      email: "test@inboxapi.ai",
      domain: "inboxapi.ai",
    });
    vi.mocked(getLastEmail).mockResolvedValue(null);
    mockResolveDmGroupAccess.mockReturnValue({
      decision: "block",
      reason: "dm-allowlist-not-matched",
      effectiveAllowFrom: [],
      effectiveGroupAllowFrom: [],
    });

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
    expect(mockReadStoreAllowFrom).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "inboxapi", dmPolicy: "allowlist" }),
    );
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
      if (callCount <= 2) return [email];
      controller.abort();
      return [];
    });

    await startPolling({
      account: makeAccount(),
      deliver,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      abortSignal: controller.signal,
    });

    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("paginates through all new emails before advancing high-water mark", async () => {
    const controller = new AbortController();
    const deliver = vi.fn();

    const e1 = makeEmail({ messageId: "<e1@x.com>", date: "2026-03-09T01:00:00Z" });
    const e2 = makeEmail({ messageId: "<e2@x.com>", date: "2026-03-09T02:00:00Z" });
    const e3 = makeEmail({ messageId: "<e3@x.com>", date: "2026-03-09T03:00:00Z" });

    vi.mocked(whoami).mockResolvedValue({
      accountName: "test",
      email: "test@inboxapi.ai",
      domain: "inboxapi.ai",
    });
    vi.mocked(getLastEmail).mockResolvedValue(null);

    let pollCycle = 0;
    let pageInCycle = 0;
    vi.mocked(getEmails).mockImplementation(async () => {
      if (pollCycle === 0) {
        pageInCycle++;
        // First page: 2 emails (= pollBatchSize, so pagination continues)
        if (pageInCycle === 1) return [e2, e1];
        // Second page: 1 email (< pollBatchSize, pagination stops)
        if (pageInCycle === 2) return [e3];
        return [];
      }
      controller.abort();
      return [];
    });

    // Use a deliver callback that marks first poll cycle done after all deliveries
    deliver.mockImplementation(async () => {
      if (deliver.mock.calls.length === 3) {
        pollCycle = 1;
      }
    });

    await startPolling({
      account: makeAccount({ pollBatchSize: 2 }),
      deliver,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      abortSignal: controller.signal,
    });

    // All 3 emails should be delivered (none skipped by pagination)
    expect(deliver).toHaveBeenCalledTimes(3);
  });
});
