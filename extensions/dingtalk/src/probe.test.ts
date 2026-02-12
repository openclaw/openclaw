/**
 * Tests for DingTalk probe utilities.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { BASIC_ACCOUNT, UNCONFIGURED_ACCOUNT } from "../test/fixtures/configs.js";
import { probeDingTalk } from "./probe.js";

describe("probeDingTalk", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns ok when credentials are valid", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ accessToken: "test-token", expireIn: 7200 }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await probeDingTalk(BASIC_ACCOUNT);

    expect(result.ok).toBe(true);
    expect(result.elapsedMs).toBeDefined();
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("returns error when credentials not configured", async () => {
    const result = await probeDingTalk(UNCONFIGURED_ACCOUNT);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Credentials not configured");
  });

  it("returns error on HTTP failure", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve("Invalid credentials"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await probeDingTalk(BASIC_ACCOUNT);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toContain("Invalid credentials");
    expect(result.elapsedMs).toBeDefined();
  });

  it("returns error when accessToken missing in response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ expireIn: 7200 }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await probeDingTalk(BASIC_ACCOUNT);

    expect(result.ok).toBe(false);
    expect(result.status).toBeUndefined(); // Response was ok but invalid
  });

  it("returns error on network failure", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network unreachable"));
    vi.stubGlobal("fetch", mockFetch);

    const result = await probeDingTalk(BASIC_ACCOUNT);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Network unreachable");
    expect(result.elapsedMs).toBeDefined();
  });

  it("respects custom timeout", async () => {
    // Mock a slow response
    const mockFetch = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                ok: true,
                json: () => Promise.resolve({ accessToken: "token" }),
              }),
            100,
          ),
        ),
    );
    vi.stubGlobal("fetch", mockFetch);

    const result = await probeDingTalk(BASIC_ACCOUNT, 5000);

    expect(result.ok).toBe(true);
  });

  it("calls correct API endpoint", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ accessToken: "token" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await probeDingTalk(BASIC_ACCOUNT);

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.dingtalk.com/v1.0/oauth2/accessToken",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.appKey).toBe(BASIC_ACCOUNT.clientId);
    expect(body.appSecret).toBe(BASIC_ACCOUNT.clientSecret);
  });

  it("truncates long error messages", async () => {
    const longError = "E".repeat(500);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () => Promise.resolve(longError),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await probeDingTalk(BASIC_ACCOUNT);

    expect(result.ok).toBe(false);
    expect(result.error!.length).toBeLessThanOrEqual(200);
  });
});
