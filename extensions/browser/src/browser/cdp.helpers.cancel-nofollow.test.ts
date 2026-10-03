import { describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
  };
});

import { fetchCdpChecked } from "./cdp.helpers.js";

describe("fetchCdpChecked cancel-nofollow", () => {
  it("releases without waiting when unread body cancel never settles", async () => {
    let cancelStarted = false;
    const cancel = vi.fn(() => {
      cancelStarted = true;
      return new Promise<void>(() => {});
    });
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: {
        ok: true,
        status: 200,
        bodyUsed: false,
        body: { cancel },
      } as unknown as Response,
      release,
    });

    const { release: guardedRelease } = await fetchCdpChecked(
      "http://127.0.0.1:9222/json/version",
      250,
      undefined,
      { dangerouslyAllowPrivateNetwork: false, allowedHostnames: ["127.0.0.1"] },
    );

    const startedAt = Date.now();
    await expect(
      Promise.race([
        guardedRelease(),
        new Promise<never>((_, reject) => {
          AbortSignal.timeout(1_000).addEventListener("abort", () => {
            reject(new Error("release hung waiting for body.cancel"));
          });
        }),
      ]),
    ).resolves.toBeUndefined();
    const elapsedMs = Date.now() - startedAt;

    expect(cancelStarted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(elapsedMs).toBeLessThan(1_000);
    console.log(
      `[browser cdp cancel-nofollow proof] cancel_started=${cancelStarted} release_called=${release.mock.calls.length} elapsed_ms=${elapsedMs}`,
    );
  });
});
