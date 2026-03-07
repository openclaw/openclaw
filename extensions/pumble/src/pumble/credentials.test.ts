import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ResolvedPumbleAccount } from "./accounts.js";
import { OcCredentialsStore } from "./credentials.js";

const mockWriteConfigFile = vi.fn();

vi.mock("../runtime.js", () => ({
  getPumbleRuntime: () => ({
    config: {
      loadConfig: () => ({ channels: { pumble: { accounts: {} } } }),
      writeConfigFile: mockWriteConfigFile,
    },
  }),
}));

vi.mock("./bot-user-id.js", () => ({
  resolveBotUserId: vi.fn(async (params: { explicitBotUserId?: string }) => {
    return params.explicitBotUserId?.trim() || "resolved-bot-id";
  }),
  resetBotUserIdCacheForTests: vi.fn(),
}));

function makeAccount(overrides: Partial<ResolvedPumbleAccount> = {}): ResolvedPumbleAccount {
  return {
    accountId: "default",
    enabled: true,
    appId: "app-1",
    appKey: "key-1",
    clientSecret: "secret-1",
    signingSecret: "sig-1",
    botToken: "xoxb-test-token",
    workspaceId: "ws-1",
    appIdSource: "config",
    config: {},
    ...overrides,
  };
}

describe("OcCredentialsStore", () => {
  let store: OcCredentialsStore;
  let account: ResolvedPumbleAccount;

  beforeEach(() => {
    account = makeAccount();
    store = new OcCredentialsStore("default", account);
    mockWriteConfigFile.mockClear();
  });

  it("initialize() is a no-op", async () => {
    await expect(store.initialize()).resolves.toBeUndefined();
  });

  it("getBotToken() returns configured token", async () => {
    const token = await store.getBotToken("ws-1");
    expect(token).toBe("xoxb-test-token");
  });

  it("getBotToken() ignores workspaceId (single workspace Phase 1)", async () => {
    const token = await store.getBotToken("other-workspace");
    expect(token).toBe("xoxb-test-token");
  });

  it("getBotToken() returns undefined when no token configured", async () => {
    store = new OcCredentialsStore("default", makeAccount({ botToken: undefined }));
    const token = await store.getBotToken("ws-1");
    expect(token).toBeUndefined();
  });

  it("getBotToken() returns undefined for empty/whitespace token", async () => {
    store = new OcCredentialsStore("default", makeAccount({ botToken: "   " }));
    const token = await store.getBotToken("ws-1");
    expect(token).toBeUndefined();
  });

  it("getUserToken() returns undefined (Phase 1)", async () => {
    const token = await store.getUserToken("ws-1", "user-1");
    expect(token).toBeUndefined();
  });

  it("deleteForUser() is a no-op", async () => {
    await expect(store.deleteForUser("user-1", "ws-1")).resolves.toBeUndefined();
  });

  it("getBotUserId() returns undefined when no token", async () => {
    store = new OcCredentialsStore("default", makeAccount({ botToken: undefined }));
    const id = await store.getBotUserId("ws-1");
    expect(id).toBeUndefined();
  });

  it("getBotUserId() returns explicit botUserId from config", async () => {
    store = new OcCredentialsStore(
      "default",
      makeAccount({ config: { botUserId: "explicit-bot-id" } }),
    );
    const id = await store.getBotUserId("ws-1");
    expect(id).toBe("explicit-bot-id");
  });

  it("getBotUserId() delegates to shared resolver", async () => {
    const id = await store.getBotUserId("ws-1");
    expect(id).toBe("resolved-bot-id");
  });

  it("getBotUserId() caches the resolved value", async () => {
    store = new OcCredentialsStore("default", makeAccount({ config: { botUserId: "cached-id" } }));
    const id1 = await store.getBotUserId("ws-1");
    const id2 = await store.getBotUserId("ws-1");
    expect(id1).toBe("cached-id");
    expect(id2).toBe("cached-id");
  });

  it("saveTokens() writes top-level for default account without accounts.default", async () => {
    await store.saveTokens({
      accessToken: "access-1",
      botToken: "xoxb-new-token",
      userId: "u-1",
      workspaceId: "ws-2",
    });

    expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
    const writtenCfg = mockWriteConfigFile.mock.calls[0][0];
    // Top-level write (no accounts.default in loadConfig mock)
    expect(writtenCfg.channels.pumble.botToken).toBe("xoxb-new-token");
    expect(writtenCfg.channels.pumble.workspaceId).toBe("ws-2");
  });

  it("saveTokens() writes to accounts[id] for named account", async () => {
    store = new OcCredentialsStore("prod", makeAccount({ accountId: "prod" }));
    await store.saveTokens({
      accessToken: "access-1",
      botToken: "xoxb-prod-token",
      userId: "u-1",
      workspaceId: "ws-prod",
    });

    expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
    const writtenCfg = mockWriteConfigFile.mock.calls[0][0];
    expect(writtenCfg.channels.pumble.accounts.prod.botToken).toBe("xoxb-prod-token");
    expect(writtenCfg.channels.pumble.accounts.prod.workspaceId).toBe("ws-prod");
  });

  it("deleteForWorkspace() clears top-level for default account", async () => {
    await store.deleteForWorkspace("ws-1");

    expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
    const writtenCfg = mockWriteConfigFile.mock.calls[0][0];
    // Top-level delete (no accounts.default in loadConfig mock)
    expect(writtenCfg.channels.pumble.botToken).toBeUndefined();
    expect(writtenCfg.channels.pumble.workspaceId).toBeUndefined();
  });

  it("deleteForWorkspace() clears from accounts[id] for named account", async () => {
    store = new OcCredentialsStore("prod", makeAccount({ accountId: "prod" }));
    await store.deleteForWorkspace("ws-1");

    expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
    const writtenCfg = mockWriteConfigFile.mock.calls[0][0];
    expect(writtenCfg.channels.pumble.accounts.prod.botToken).toBeUndefined();
    expect(writtenCfg.channels.pumble.accounts.prod.workspaceId).toBeUndefined();
  });
});
