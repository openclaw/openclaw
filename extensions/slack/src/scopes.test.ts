import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const apiCallMock = vi.fn();

vi.mock("@slack/web-api", () => {
  const WebClient = vi.fn(function WebClientMock(this: Record<string, unknown>, _token: string) {
    this.apiCall = apiCallMock;
  });
  return { WebClient };
});

let fetchSlackScopes: typeof import("./scopes.js").fetchSlackScopes;

beforeAll(async () => {
  ({ fetchSlackScopes } = await import("./scopes.js"));
});

beforeEach(() => {
  apiCallMock.mockReset();
});

describe("fetchSlackScopes", () => {
  it("returns scopes from auth.scopes when available (legacy workspace app)", async () => {
    apiCallMock.mockImplementation((method: string) => {
      if (method === "auth.scopes") {
        return Promise.resolve({ ok: true, scopes: ["chat:write", "channels:read"] });
      }
      return Promise.resolve({ ok: false, error: "not called" });
    });

    const result = await fetchSlackScopes("xoxp-legacy", 1234);

    expect(result).toEqual({
      ok: true,
      scopes: ["channels:read", "chat:write"],
      source: "auth.scopes",
    });
    expect(apiCallMock).toHaveBeenCalledTimes(1);
    expect(apiCallMock).toHaveBeenCalledWith("auth.scopes");
  });

  it("falls through to auth.test when both legacy methods return unknown_method (issue #44625)", async () => {
    apiCallMock.mockImplementation((method: string) => {
      if (method === "auth.scopes" || method === "apps.permissions.info") {
        return Promise.resolve({ ok: false, error: "unknown_method" });
      }
      if (method === "auth.test") {
        return Promise.resolve({
          ok: true,
          user_id: "U123",
          team_id: "T123",
          response_metadata: {
            scopes: ["chat:write", "channels:history", "im:read"],
          },
        });
      }
      throw new Error(`unexpected ${method}`);
    });

    const result = await fetchSlackScopes("xoxb-modern", 1234);

    expect(result).toEqual({
      ok: true,
      scopes: ["channels:history", "chat:write", "im:read"],
      source: "auth.test",
    });
    expect(apiCallMock).toHaveBeenCalledTimes(3);
    expect(apiCallMock.mock.calls.map((call) => call[0])).toEqual([
      "auth.scopes",
      "apps.permissions.info",
      "auth.test",
    ]);
  });

  it("collects acceptedScopes from response_metadata when scopes are absent", async () => {
    apiCallMock.mockImplementation((method: string) => {
      if (method === "auth.test") {
        return Promise.resolve({
          ok: true,
          response_metadata: { acceptedScopes: ["chat:write"] },
        });
      }
      return Promise.resolve({ ok: false, error: "unknown_method" });
    });

    const result = await fetchSlackScopes("xoxb-accepted-only", 1234);

    expect(result).toEqual({
      ok: true,
      scopes: ["chat:write"],
      source: "auth.test",
    });
  });

  it("joins all three errors when no source returns scopes", async () => {
    apiCallMock.mockImplementation((method: string) => {
      if (method === "auth.test") {
        return Promise.resolve({ ok: false, error: "invalid_auth" });
      }
      return Promise.resolve({ ok: false, error: "unknown_method" });
    });

    const result = await fetchSlackScopes("xoxb-broken", 1234);

    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      "auth.scopes: unknown_method | apps.permissions.info: unknown_method | auth.test: invalid_auth",
    );
    expect(apiCallMock).toHaveBeenCalledTimes(3);
  });

  it("falls back to a generic error when every attempt is silent", async () => {
    apiCallMock.mockResolvedValue({ ok: true });

    const result = await fetchSlackScopes("xoxb-no-data", 1234);

    expect(result).toEqual({ ok: false, error: "no scopes returned" });
  });

  it("treats apiCall throws as an error attempt and continues to the next source", async () => {
    apiCallMock.mockImplementation((method: string) => {
      if (method === "auth.scopes") {
        throw new Error("network glitch");
      }
      if (method === "apps.permissions.info") {
        return Promise.resolve({ ok: false, error: "unknown_method" });
      }
      if (method === "auth.test") {
        return Promise.resolve({
          ok: true,
          response_metadata: { scopes: "chat:write,channels:read" },
        });
      }
      throw new Error(`unexpected ${method}`);
    });

    const result = await fetchSlackScopes("xoxb-flaky", 1234);

    expect(result.ok).toBe(true);
    expect(result.source).toBe("auth.test");
    expect(result.scopes).toEqual(["channels:read", "chat:write"]);
  });

  it("does not call later sources once a source returns scopes", async () => {
    apiCallMock.mockImplementation((method: string) => {
      if (method === "auth.scopes") {
        return Promise.resolve({ ok: true, scopes: ["chat:write"] });
      }
      throw new Error(`should not have called ${method}`);
    });

    const result = await fetchSlackScopes("xoxp-legacy-shortcircuit", 1234);

    expect(result.source).toBe("auth.scopes");
    expect(apiCallMock).toHaveBeenCalledTimes(1);
  });
});
