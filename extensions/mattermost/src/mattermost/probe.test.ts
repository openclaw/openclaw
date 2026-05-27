import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeMattermost } from "./probe.js";

const mockFetch = vi.fn<typeof fetch>();

describe("probeMattermost", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns baseUrl missing for empty base URL", async () => {
    await expect(probeMattermost(" ", "token")).resolves.toEqual({
      ok: false,
      error: "baseUrl missing",
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("normalizes base URL and returns bot info", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "bot-1", username: "clawbot" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await probeMattermost("https://mm.example.com/api/v4/", "bot-token");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://mm.example.com/api/v4/users/me",
      expect.objectContaining({
        headers: { Authorization: "Bearer bot-token" },
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        status: 200,
        bot: { id: "bot-1", username: "clawbot" },
      }),
    );
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("returns API error details from JSON response", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "invalid auth token" }), {
        status: 401,
        statusText: "Unauthorized",
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(probeMattermost("https://mm.example.com", "bad-token")).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        status: 401,
        error: "invalid auth token",
      }),
    );
  });

  it("falls back to statusText when error body is empty", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response("", {
        status: 403,
        statusText: "Forbidden",
        headers: { "content-type": "text/plain" },
      }),
    );

    await expect(probeMattermost("https://mm.example.com", "token")).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        status: 403,
        error: "Forbidden",
      }),
    );
  });

  it("returns fetch error when request throws", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network down"));

    await expect(probeMattermost("https://mm.example.com", "token")).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        status: null,
        error: "network down",
      }),
    );
  });
});
