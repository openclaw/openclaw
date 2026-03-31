import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenStore } from "./oauth.js";
import { StravaRefreshError } from "./oauth.js";
import { createStravaTools } from "./tools.js";

describe("createStravaTools", () => {
  let tmpDir: string;
  let tokenStore: TokenStore;
  const config = { clientId: "test-id", clientSecret: "test-secret" };
  const getRedirectUri = () => "http://localhost:18789/api/plugins/strava/oauth/callback";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "strava-tools-test-"));
    tokenStore = new TokenStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns exactly 4 tools", () => {
    const tools = createStravaTools({ config, tokenStore, getRedirectUri });
    expect(tools).toHaveLength(4);
  });

  it("tools have correct names", () => {
    const tools = createStravaTools({ config, tokenStore, getRedirectUri });
    const names = tools.map((t) => t.name);
    expect(names).toEqual([
      "strava_auth_status",
      "strava_activities",
      "strava_activity_detail",
      "strava_stats",
    ]);
  });

  it("auth_status returns not-connected with auth URL when no tokens", async () => {
    const tools = createStravaTools({ config, tokenStore, getRedirectUri });
    const authTool = tools.find((t) => t.name === "strava_auth_status")!;
    const result = await authTool.execute("test-id", {});
    const data = JSON.parse(result.content[0].text);
    expect(data.connected).toBe(false);
    expect(data.authUrl).toContain("client_id=test-id");
    expect(data.authUrl).toContain("state=");
    expect(data.message).toContain("authorize");
  });

  it("activities returns not-connected when no tokens", async () => {
    const tools = createStravaTools({ config, tokenStore, getRedirectUri });
    const activitiesTool = tools.find((t) => t.name === "strava_activities")!;
    const result = await activitiesTool.execute("test-id", {});
    const data = JSON.parse(result.content[0].text);
    expect(data.connected).toBe(false);
  });

  it("activity_detail returns not-connected when no tokens", async () => {
    const tools = createStravaTools({ config, tokenStore, getRedirectUri });
    const detailTool = tools.find((t) => t.name === "strava_activity_detail")!;
    const result = await detailTool.execute("test-id", { activityId: "123" });
    const data = JSON.parse(result.content[0].text);
    expect(data.connected).toBe(false);
  });

  it("stats returns not-connected when no tokens", async () => {
    const tools = createStravaTools({ config, tokenStore, getRedirectUri });
    const statsTool = tools.find((t) => t.name === "strava_stats")!;
    const result = await statsTool.execute("test-id", {});
    const data = JSON.parse(result.content[0].text);
    expect(data.connected).toBe(false);
  });
});

describe("getTokenOrNull error handling", () => {
  let tmpDir: string;
  let tokenStore: TokenStore;
  const config = { clientId: "test-id", clientSecret: "test-secret" };
  const getRedirectUri = () => "http://localhost:18789/callback";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "strava-err-test-"));
    tokenStore = new TokenStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("clears tokens on 401 StravaRefreshError", async () => {
    // Save tokens that will trigger a refresh (expired)
    tokenStore.save({
      accessToken: "old",
      refreshToken: "old-refresh",
      expiresAt: 0, // expired
      athleteId: "1",
    });

    // Mock fetch to return 401
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Unauthorized", { status: 401 }),
    );

    const tools = createStravaTools({ config, tokenStore, getRedirectUri });
    const authTool = tools.find((t) => t.name === "strava_auth_status")!;
    const result = await authTool.execute("test-id", {});
    const data = JSON.parse(result.content[0].text);

    expect(data.connected).toBe(false);
    // Tokens should be cleared
    expect(tokenStore.load()).toBeNull();
  });

  it("preserves tokens on transient 500 error", async () => {
    tokenStore.save({
      accessToken: "old",
      refreshToken: "old-refresh",
      expiresAt: 0, // expired
      athleteId: "1",
    });

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 }),
    );

    const tools = createStravaTools({ config, tokenStore, getRedirectUri });
    const authTool = tools.find((t) => t.name === "strava_auth_status")!;

    // Should throw (transient error propagated, not swallowed)
    await expect(authTool.execute("test-id", {})).rejects.toThrow(StravaRefreshError);
    // Tokens should still be there
    expect(tokenStore.load()).not.toBeNull();
  });
});
