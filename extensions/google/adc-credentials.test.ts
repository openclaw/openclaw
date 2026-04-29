import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AdcCredentials,
  type FetchLike,
  clearAdcTokenCache,
  getAuthorizedUserAccessToken,
  loadAdcCredentials,
  mintAccessTokenFromAuthorizedUser,
} from "./adc-credentials.js";

type AuthorizedUserCred = Extract<AdcCredentials, { type: "authorized_user" }>;

async function writeTempJson(content: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "openclaw-adc-"));
  const file = path.join(dir, "adc.json");
  await writeFile(file, JSON.stringify(content), "utf8");
  return file;
}

describe("loadAdcCredentials", () => {
  afterEach(() => {
    clearAdcTokenCache();
  });

  it("parses authorized_user ADC", async () => {
    const file = await writeTempJson({
      type: "authorized_user",
      client_id: "cid",
      client_secret: "csec",
      refresh_token: "rt",
      quota_project_id: "qproj",
    });
    const cred = await loadAdcCredentials(file);
    expect(cred.type).toBe("authorized_user");
    if (cred.type === "authorized_user") {
      expect(cred.clientId).toBe("cid");
      expect(cred.clientSecret).toBe("csec");
      expect(cred.refreshToken).toBe("rt");
      expect(cred.quotaProjectId).toBe("qproj");
    }
  });

  it("rejects authorized_user missing required fields", async () => {
    const file = await writeTempJson({ type: "authorized_user", client_id: "cid" });
    await expect(loadAdcCredentials(file)).rejects.toThrow(/missing client_id/);
  });

  it("parses service_account ADC", async () => {
    const file = await writeTempJson({
      type: "service_account",
      project_id: "p",
      private_key: "k",
      client_email: "e",
    });
    const cred = await loadAdcCredentials(file);
    expect(cred.type).toBe("service_account");
  });

  it("returns 'other' for unknown ADC types so callers can fall through", async () => {
    const file = await writeTempJson({ type: "external_account", audience: "x" });
    const cred = await loadAdcCredentials(file);
    expect(cred.type).toBe("other");
    if (cred.type === "other") {
      expect(cred.rawType).toBe("external_account");
    }
  });
});

describe("mintAccessTokenFromAuthorizedUser", () => {
  it("POSTs refresh_token grant and returns access token", async () => {
    const fetchMock: FetchLike = vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: "AT", expires_in: 3600 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const cred: AuthorizedUserCred = {
      type: "authorized_user",
      clientId: "cid",
      clientSecret: "csec",
      refreshToken: "rt",
      raw: {},
    };
    const minted = await mintAccessTokenFromAuthorizedUser(cred, {
      fetch: fetchMock,
      now: () => 1_000_000,
    });
    expect(minted.accessToken).toBe("AT");
    expect(minted.expiresAt).toBe(1_000_000 + 3600 * 1000 - 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("grant_type=refresh_token"),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({
        body: expect.stringContaining("refresh_token=rt"),
      }),
    );
  });

  it("throws on non-OK response", async () => {
    const fetchMock: FetchLike = vi.fn(
      async () => new Response("invalid_grant", { status: 400, statusText: "Bad Request" }),
    );
    const cred: AuthorizedUserCred = {
      type: "authorized_user",
      clientId: "cid",
      clientSecret: "csec",
      refreshToken: "rt",
      raw: {},
    };
    await expect(mintAccessTokenFromAuthorizedUser(cred, { fetch: fetchMock })).rejects.toThrow(
      /token refresh failed: 400/,
    );
  });
});

describe("getAuthorizedUserAccessToken cache", () => {
  afterEach(() => {
    clearAdcTokenCache();
  });

  it("reuses cached token while not expired", async () => {
    let now = 1_000_000;
    const fetchMock: FetchLike = vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: "AT", expires_in: 3600 }), {
          status: 200,
        }),
    );
    const cred: AuthorizedUserCred = {
      type: "authorized_user",
      clientId: "cid",
      clientSecret: "csec",
      refreshToken: "rt",
      raw: {},
    };
    const t1 = await getAuthorizedUserAccessToken(cred, { fetch: fetchMock, now: () => now });
    now += 1000;
    const t2 = await getAuthorizedUserAccessToken(cred, { fetch: fetchMock, now: () => now });
    expect(t1).toBe("AT");
    expect(t2).toBe("AT");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-mints after expiry", async () => {
    let now = 1_000_000;
    let calls = 0;
    const fetchMock: FetchLike = vi.fn(async () => {
      calls += 1;
      return new Response(JSON.stringify({ access_token: `AT${calls}`, expires_in: 1 }), {
        status: 200,
      });
    });
    const cred: AuthorizedUserCred = {
      type: "authorized_user",
      clientId: "cid",
      clientSecret: "csec",
      refreshToken: "rt",
      raw: {},
    };
    const t1 = await getAuthorizedUserAccessToken(cred, { fetch: fetchMock, now: () => now });
    now += 5 * 60_000;
    const t2 = await getAuthorizedUserAccessToken(cred, { fetch: fetchMock, now: () => now });
    expect(t1).toBe("AT1");
    expect(t2).toBe("AT2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
