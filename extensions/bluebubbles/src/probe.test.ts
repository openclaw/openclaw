import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeBlueBubbles } from "./probe.js";
import { createBlueBubblesFetchGuardPassthroughInstaller } from "./test-harness.js";
import { _setFetchGuardForTesting } from "./types.js";

const mockFetch = vi.fn();
const installFetchGuardPassthrough = createBlueBubblesFetchGuardPassthroughInstaller();

describe("probeBlueBubbles", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    installFetchGuardPassthrough();
    mockFetch.mockReset();
  });

  afterEach(() => {
    _setFetchGuardForTesting(null);
    vi.unstubAllGlobals();
  });

  it("projects server info into the probe result", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(""),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            data: {
              private_api: true,
              helper_connected: false,
              os_version: "26.5.0",
              server_version: "1.9.9",
              proxy_service: "cloudflare",
              detected_icloud: "neil@example.invalid",
            },
          }),
      });

    const result = await probeBlueBubbles({
      baseUrl: "http://localhost:1234",
      password: "test-password",
      accountId: "probe-test",
      allowPrivateNetwork: true,
    });

    expect(result).toMatchObject({
      ok: true,
      status: 200,
      privateApi: true,
      helperConnected: false,
      osVersion: "26.5.0",
      serverVersion: "1.9.9",
      proxyService: "cloudflare",
      detectedIcloud: "neil@example.invalid",
    });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/ping"),
      expect.objectContaining({ method: "GET" }),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/server/info"),
      expect.objectContaining({ method: "GET" }),
    );
  });
});
