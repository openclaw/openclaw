import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearServerInfoCache,
  resolveBlueBubblesPrivateApiStatus,
  type BlueBubblesPrivateApiStatusParams,
} from "./probe.js";

const mockFetch = vi.fn();

const probeParams: BlueBubblesPrivateApiStatusParams = {
  baseUrl: "http://localhost:1234",
  password: "test-password", // pragma: allowlist secret
  accountId: "default",
  timeoutMs: 500,
};

describe("probe", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch);
    mockFetch.mockReset();
    clearServerInfoCache();
  });

  afterEach(() => {
    clearServerInfoCache();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("coalesces concurrent private-api status probes", async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    mockFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve as (value: Response) => void;
        }),
    );

    const first = resolveBlueBubblesPrivateApiStatus(probeParams);
    const second = resolveBlueBubblesPrivateApiStatus(probeParams);

    expect(mockFetch).toHaveBeenCalledTimes(1);

    resolveFetch?.({
      ok: false,
      status: 503,
    } as Response);

    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
  });

  it("briefly caches unresolved private-api probes to avoid repeated retries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-08T00:00:00.000Z"));

    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
    } as Response);

    await expect(resolveBlueBubblesPrivateApiStatus(probeParams)).resolves.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await expect(resolveBlueBubblesPrivateApiStatus(probeParams)).resolves.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_001);

    await expect(resolveBlueBubblesPrivateApiStatus(probeParams)).resolves.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest unknown-status entries when the cache reaches capacity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-08T00:00:00.000Z"));

    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
    } as Response);

    for (let index = 0; index < 65; index += 1) {
      await expect(
        resolveBlueBubblesPrivateApiStatus({
          ...probeParams,
          accountId: `account-${index}`,
        }),
      ).resolves.toBeNull();
    }

    expect(mockFetch).toHaveBeenCalledTimes(65);

    await expect(
      resolveBlueBubblesPrivateApiStatus({
        ...probeParams,
        accountId: "account-0",
      }),
    ).resolves.toBeNull();

    expect(mockFetch).toHaveBeenCalledTimes(66);
  });
});
