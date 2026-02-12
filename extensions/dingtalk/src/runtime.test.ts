import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedDingTalkAccount } from "./accounts.js";

const { createTokenManagerFromAccountMock, clearAllTokensMock } = vi.hoisted(() => ({
  createTokenManagerFromAccountMock: vi.fn(),
  clearAllTokensMock: vi.fn(),
}));

vi.mock("./api/token-manager.js", () => ({
  createTokenManagerFromAccount: createTokenManagerFromAccountMock,
  clearAllTokens: clearAllTokensMock,
}));

import { clearTokenManagers, getOrCreateTokenManager, invalidateTokenManager } from "./runtime.js";

function createAccount(overrides: Partial<ResolvedDingTalkAccount> = {}): ResolvedDingTalkAccount {
  return {
    accountId: "default",
    enabled: true,
    clientId: "client-id",
    clientSecret: "client-secret",
    credentialSource: "config",
    apiBase: "https://api.dingtalk.com",
    openPath: "/v1.0/gateway/connections/open",
    replyMode: "text",
    maxChars: 1800,
    tableMode: "code",
    coalesce: {
      enabled: true,
      minChars: 800,
      maxChars: 1200,
      idleMs: 1000,
    },
    allowFrom: [],
    requireMention: true,
    isolateContextPerUserInGroup: false,
    mentionBypassUsers: [],
    showToolStatus: false,
    showToolResult: false,
    thinking: "off",
    ...overrides,
  };
}

function createManager() {
  return {
    getToken: vi.fn(),
    invalidate: vi.fn(),
  };
}

describe("runtime token manager cache", () => {
  beforeEach(() => {
    clearTokenManagers();
    createTokenManagerFromAccountMock.mockReset();
    clearAllTokensMock.mockReset();
  });

  it("reuses manager when account credentials are unchanged", () => {
    const manager = createManager();
    createTokenManagerFromAccountMock.mockReturnValue(manager);
    const account = createAccount();

    const first = getOrCreateTokenManager(account);
    const second = getOrCreateTokenManager({ ...account });

    expect(first).toBe(manager);
    expect(second).toBe(manager);
    expect(createTokenManagerFromAccountMock).toHaveBeenCalledTimes(1);
  });

  it("recreates manager when credentials rotate for the same accountId", () => {
    const oldManager = createManager();
    const newManager = createManager();
    createTokenManagerFromAccountMock
      .mockReturnValueOnce(oldManager)
      .mockReturnValueOnce(newManager);

    const base = createAccount();
    const rotated = createAccount({ clientSecret: "rotated-secret" });

    const first = getOrCreateTokenManager(base);
    const second = getOrCreateTokenManager(rotated);

    expect(first).toBe(oldManager);
    expect(second).toBe(newManager);
    expect(oldManager.invalidate).toHaveBeenCalledTimes(1);
    expect(createTokenManagerFromAccountMock).toHaveBeenCalledTimes(2);
  });

  it("invalidates and removes manager by accountId", () => {
    const manager = createManager();
    createTokenManagerFromAccountMock.mockReturnValue(manager);
    const account = createAccount();

    getOrCreateTokenManager(account);
    invalidateTokenManager(account.accountId);
    getOrCreateTokenManager(account);

    expect(manager.invalidate).toHaveBeenCalledTimes(1);
    expect(createTokenManagerFromAccountMock).toHaveBeenCalledTimes(2);
  });

  it("clears all managers and token cache", () => {
    const manager1 = createManager();
    const manager2 = createManager();
    createTokenManagerFromAccountMock.mockReturnValueOnce(manager1).mockReturnValueOnce(manager2);

    getOrCreateTokenManager(createAccount({ accountId: "a" }));
    getOrCreateTokenManager(createAccount({ accountId: "b", clientId: "other-client" }));

    clearTokenManagers();

    expect(manager1.invalidate).toHaveBeenCalledTimes(1);
    expect(manager2.invalidate).toHaveBeenCalledTimes(1);
    expect(clearAllTokensMock).toHaveBeenCalledTimes(1);
  });
});
