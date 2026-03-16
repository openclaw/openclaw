import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearServerInfoCache,
  fetchBlueBubblesServerInfo,
  getCachedBlueBubblesServerInfo,
} from "./probe.js";

const fetchMock = vi.fn();

describe("fetchBlueBubblesServerInfo", () => {
  beforeEach(() => {
    clearServerInfoCache();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    clearServerInfoCache();
    vi.unstubAllGlobals();
  });

  it("caches failed probes to avoid repeated blocking lookups", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
    });

    await expect(
      fetchBlueBubblesServerInfo({
        baseUrl: "http://localhost:1234",
        password: "test",
        accountId: "default",
      }),
    ).resolves.toBeNull();

    await expect(
      fetchBlueBubblesServerInfo({
        baseUrl: "http://localhost:1234",
        password: "test",
        accountId: "default",
      }),
    ).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getCachedBlueBubblesServerInfo("default")).toEqual({});
  });
});
