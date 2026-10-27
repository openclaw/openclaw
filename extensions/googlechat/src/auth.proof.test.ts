// Real SSRF guard and deadline, with fetch redirected to a hanging loopback.
// DNS pinning/dispatcher construction are bypassed; JWT verification is hermetic.
import { afterEach, expect, it, vi } from "vitest";
import { startHangingLoopbackServer } from "../../test-support/hanging-loopback-server.js";

const GOOGLECHAT_CERT_FETCH_TIMEOUT_MS = 30_000;
const CHAT_CERTS_PATH = "/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com";

const mockVerifySignedJwt = vi.hoisted(() => vi.fn());
// vi.fn() used as a constructor requires a non-arrow factory.
const mockOAuth2Client = vi.hoisted(() =>
  vi.fn(function (this: { verifySignedJwtWithCertsAsync: typeof mockVerifySignedJwt }) {
    this.verifySignedJwtWithCertsAsync = mockVerifySignedJwt;
  }),
);

vi.mock("./google-auth.runtime.js", () => ({
  loadGoogleAuthRuntime: vi.fn().mockResolvedValue({ OAuth2Client: mockOAuth2Client }),
  getGoogleAuthTransport: vi.fn().mockResolvedValue({}),
  resolveValidatedGoogleChatCredentials: vi.fn().mockResolvedValue(null),
}));

import { verifyGoogleChatRequest } from "./auth.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Capture the production 30s deadline scheduled by buildTimeoutAbortSignal so it
// can be fired deterministically after the loopback server confirms receipt.
function captureCertFetchTimeout() {
  const originalSetTimeout = globalThis.setTimeout;
  let fireTimeout: (() => void) | undefined;
  const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void,
    timeout?: number,
    ...args: unknown[]
  ) => {
    if (timeout === GOOGLECHAT_CERT_FETCH_TIMEOUT_MS) {
      fireTimeout = () => callback(...args);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return originalSetTimeout(() => callback(...args), timeout);
  }) as typeof setTimeout);
  return {
    scheduled: () =>
      setTimeoutSpy.mock.calls.some(([, ms]) => ms === GOOGLECHAT_CERT_FETCH_TIMEOUT_MS),
    fire() {
      if (!fireTimeout) {
        throw new Error("expected Google Chat cert-fetch 30s timeout to be scheduled");
      }
      const callback = fireTimeout;
      fireTimeout = undefined;
      callback();
    },
  };
}

it("times out a stalled cert fetch through the real production guard", async () => {
  const realFetch = globalThis.fetch;
  const server = await startHangingLoopbackServer();
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const certFetchTimeout = captureCertFetchTimeout();
  let pendingVerify: Promise<{ ok: boolean; reason?: string }> | undefined;

  // Keep the guard's composed timeout signal while redirecting transport.
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
    realFetch(`${server.origin}${CHAT_CERTS_PATH}`, {
      method: (init?.method as string | undefined) ?? "GET",
      signal: init?.signal,
    }),
  );
  vi.stubGlobal("fetch", fetchMock);

  try {
    pendingVerify = verifyGoogleChatRequest({
      bearer: "token",
      audienceType: "project-number",
      audience: "12345",
    });

    await server.waitForRequestCount(1);
    expect(certFetchTimeout.scheduled()).toBe(true);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);

    // Only the production deadline may settle the pending request.
    let verifySettled = false;
    const markSettled = () => {
      verifySettled = true;
    };
    void pendingVerify.then(markSettled, markSettled);
    await vi.advanceTimersByTimeAsync(500);
    expect(verifySettled).toBe(false);

    certFetchTimeout.fire();

    await expect(pendingVerify).resolves.toMatchObject({
      ok: false,
      reason: expect.stringMatching(/aborted|timed out|timeout/i),
    });
    expect(server.requests).toContain(CHAT_CERTS_PATH);
    expect(mockVerifySignedJwt).not.toHaveBeenCalled();
  } finally {
    await server.close();
    await pendingVerify?.catch(() => undefined);
  }
});
