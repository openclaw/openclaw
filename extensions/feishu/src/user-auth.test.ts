import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeishuUserToken } from "./types.js";
import {
  buildAuthUrl,
  exchangeCodeForToken,
  refreshUserToken,
  persistUserToken,
  loadUserToken,
  deleteUserToken,
  getUserAccessToken,
  createPendingAuth,
  consumePendingAuth,
} from "./user-auth.js";

// ── buildAuthUrl ──

describe("buildAuthUrl", () => {
  it("generates feishu-auth URL by default", () => {
    const url = buildAuthUrl({
      appId: "cli_abc",
      redirectUri: "http://localhost:18789/callback",
      state: "test_state",
    });
    expect(url).toContain("https://open.feishu.cn/open-apis/authen/v1/authorize");
    expect(url).toContain("app_id=cli_abc");
    expect(url).toContain("state=test_state");
    expect(url).toContain(encodeURIComponent("http://localhost:18789/callback"));
  });

  it("generates lark auth URL when domain is lark", () => {
    const url = buildAuthUrl({
      appId: "cli_abc",
      redirectUri: "http://localhost/cb",
      state: "s",
      domain: "lark",
    });
    expect(url).toContain("https://open.larksuite.com");
  });
});

// ── exchangeCodeForToken ──

describe("exchangeCodeForToken", () => {
  it("exchanges code and returns token", async () => {
    const mockClient = {
      authen: {
        oidcAccessToken: {
          create: vi.fn(async () => ({
            code: 0,
            data: {
              access_token: "u-abc",
              refresh_token: "r-xyz",
              expires_in: 7200,
              open_id: "ou_user1",
            },
          })),
        },
      },
    };

    const token = await exchangeCodeForToken(mockClient as never, "auth_code_123");
    expect(token.accessToken).toBe("u-abc");
    expect(token.refreshToken).toBe("r-xyz");
    expect(token.openId).toBe("ou_user1");
    expect(token.expiresAt).toBeGreaterThan(Date.now());
    expect(mockClient.authen.oidcAccessToken.create).toHaveBeenCalledWith({
      data: { grant_type: "authorization_code", code: "auth_code_123" },
    });
  });

  it("throws on error code", async () => {
    const mockClient = {
      authen: {
        oidcAccessToken: {
          create: vi.fn(async () => ({ code: 10003, msg: "invalid code" })),
        },
      },
    };

    await expect(exchangeCodeForToken(mockClient as never, "bad")).rejects.toThrow("invalid code");
  });
});

// ── refreshUserToken ──

describe("refreshUserToken", () => {
  it("refreshes token successfully", async () => {
    const mockClient = {
      authen: {
        oidcRefreshAccessToken: {
          create: vi.fn(async () => ({
            code: 0,
            data: {
              access_token: "u-new",
              refresh_token: "r-new",
              expires_in: 7200,
              open_id: "ou_user1",
            },
          })),
        },
      },
    };

    const token = await refreshUserToken(mockClient as never, "r-old");
    expect(token.accessToken).toBe("u-new");
    expect(token.refreshToken).toBe("r-new");
  });

  it("throws on refresh failure", async () => {
    const mockClient = {
      authen: {
        oidcRefreshAccessToken: {
          create: vi.fn(async () => ({ code: 10012, msg: "refresh expired" })),
        },
      },
    };

    await expect(refreshUserToken(mockClient as never, "r-old")).rejects.toThrow("refresh expired");
  });
});

// ── Token persistence ──

describe("token persistence", () => {
  const testDir = path.join(os.tmpdir(), `openclaw-test-${Date.now()}`);
  const origHome = process.env.HOME;

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
    process.env.HOME = testDir;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  // persistUserToken/loadUserToken use os.homedir() which reads HOME env var
  // We need to use the actual functions since they derive path from os.homedir()
  // But os.homedir() caches the result, so we test via direct file ops

  it("returns null for non-existent token", () => {
    expect(loadUserToken("nonexistent_account_xyz_" + Date.now(), "ou_user123")).toBeNull();
  });
});

// ── Pending auth state ──

describe("pending auth state", () => {
  it("creates and consumes a pending auth", () => {
    const state = createPendingAuth("account1", "ou_user123");
    expect(typeof state).toBe("string");
    expect(state.length).toBe(32);

    const authData = consumePendingAuth(state);
    expect(authData).toEqual({ accountId: "account1", userId: "ou_user123" });

    // Second consumption should return null
    expect(consumePendingAuth(state)).toBeNull();
  });

  it("returns null for unknown state", () => {
    expect(consumePendingAuth("nonexistent")).toBeNull();
  });
});

// ── getUserAccessToken ──

describe("getUserAccessToken", () => {
  it("returns null when no token file exists", async () => {
    const mockClient = {} as never;
    const result = await getUserAccessToken(
      mockClient,
      "no_such_account_" + Date.now(),
      "ou_user123",
    );
    expect(result).toBeNull();
  });
});
