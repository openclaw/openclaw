import type { IncomingMessage, ServerResponse } from "node:http";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { withFetchPreconnect, withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginAppRegistration, pollAppRegistration, printQrCode } from "./app-registration.js";
import { readRequestBody, stripDispatcher, writeOversizedJson } from "./http.test-support.js";

const FEISHU_JSON_MAX_BYTES = 16 * 1024 * 1024;

const { renderQrTerminalMock } = vi.hoisted(() => ({
  renderQrTerminalMock: vi.fn(async () => "terminal-qr"),
}));

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  renderQrTerminal: renderQrTerminalMock,
}));

type RegistrationFetchOptions = {
  fetchImpl: typeof fetch;
  timeoutMs?: number;
};

const fetchWithSsrFGuard = ssrfRuntime.fetchWithSsrFGuard;

function mockRegistrationFetch(options: RegistrationFetchOptions): void {
  vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation((params) =>
    fetchWithSsrFGuard({ ...params, lookupFn: hermeticPublicLookup, ...options }),
  );
}

const hermeticPublicLookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];

async function withRegistrationServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (options: RegistrationFetchOptions) => Promise<void>,
) {
  return withServer(handler, async (origin) => {
    const realFetch = globalThis.fetch.bind(globalThis);
    const fetchImpl = withFetchPreconnect(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.hostname === "accounts.feishu.cn" || url.hostname === "accounts.larksuite.com") {
        return await realFetch(
          new URL(`${url.pathname}${url.search}`, origin),
          stripDispatcher(init),
        );
      }
      return await realFetch(input, init);
    });
    const options = { fetchImpl };
    mockRegistrationFetch(options);
    return await run(options);
  });
}

const beginPayload = {
  device_code: "dev",
  verification_uri_complete: "https://accounts.feishu.cn/verify?x=1",
  user_code: "user",
  interval: 5,
  expire_in: 300,
};
const beginResult = { deviceCode: "dev", interval: 5, expireIn: 300 };
const pollParams = { deviceCode: "dev", interval: 30, expireIn: 600 };

function beginRegistrationJson(
  overrides: Record<string, unknown>,
  run: (options: RegistrationFetchOptions) => Promise<void>,
) {
  return withRegistrationServer((req, res) => {
    void readRequestBody(req).then((body) => {
      if (new URLSearchParams(body).get("action") !== "begin") {
        res.writeHead(400);
        res.end("unexpected action");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...beginPayload, ...overrides }));
    });
  }, run);
}

describe("Feishu app registration", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    renderQrTerminalMock.mockClear();
  });

  it("defaults unsafe begin polling lifetimes from provider responses", async () => {
    await beginRegistrationJson(
      {
        interval: Number.POSITIVE_INFINITY,
        expire_in: Number.POSITIVE_INFINITY,
      },
      async () => {
        await expect(beginAppRegistration("feishu")).resolves.toMatchObject({
          ...beginResult,
          expireIn: 600,
        });
      },
    );
  });

  it("ends the registration poll at its monotonic deadline when the wall clock rewinds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => Response.json({ error: "authorization_pending" }));
    mockRegistrationFetch({ fetchImpl: withFetchPreconnect(fetchMock) });
    // Settlement observer is attached before fake time advances, so the
    // recorded outcome can be asserted without leaving real timers behind.
    let outcome: string | undefined;
    const poll = pollAppRegistration({ ...pollParams, interval: 5, expireIn: 30 }).then(
      (result) => {
        outcome = `settled:${result.status}`;
      },
      () => {
        outcome = "settled:rejected";
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    // NTP correction or VM resume rewinds the wall clock mid-poll.
    vi.setSystemTime(Date.now() - 10 * 60_000);
    await vi.advanceTimersByTimeAsync(35_000);
    expect(outcome).toBe("settled:timeout");
    await poll;
    vi.useRealTimers();
  });

  it("clamps unsafe poll sleeps from provider intervals", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const fetchImpl = withFetchPreconnect(
      vi.fn(async () => {
        throw new Error("transient");
      }),
    );

    mockRegistrationFetch({ fetchImpl });
    const poll = pollAppRegistration({ ...pollParams, interval: 10_000_000, expireIn: 10_000_000 });
    await vi.advanceTimersByTimeAsync(0);

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);

    await vi.runOnlyPendingTimersAsync();
    await expect(poll).resolves.toEqual({ status: "timeout" });
  });

  it("stops polling promptly when abortSignal fires during the poll interval", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => Response.json({ error: "authorization_pending" }));
    const controller = new AbortController();
    let outcome: Awaited<ReturnType<typeof pollAppRegistration>> | undefined;
    mockRegistrationFetch({
      fetchImpl: withFetchPreconnect(fetchMock),
    });
    const poll = pollAppRegistration({
      ...pollParams,
      abortSignal: controller.signal,
    }).then((result) => {
      outcome = result;
    });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(outcome).toBeUndefined();

      controller.abort();
      await vi.advanceTimersByTimeAsync(0);

      expect(outcome).toEqual({ status: "timeout" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      controller.abort();
      // Join the poll even when a regression leaves its interval asleep after abort.
      await vi.advanceTimersByTimeAsync(30_000);
      await poll;
    }
  });

  it("prints scan-to-create QR codes with compact terminal rendering", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const url = "https://accounts.feishu.cn/verify?device_code=long-device-code";
    await printQrCode(url);
    expect(renderQrTerminalMock).toHaveBeenCalledWith(url, { small: true });
    expect(writeSpy).toHaveBeenCalledWith("terminal-qr\n");
  });

  it("times out registration POSTs when accounts never return headers", async () => {
    await withRegistrationServer(
      // Accept TCP but never write headers — idle body timers never start.
      (_req, _res) => {},
      async (options) => {
        const started = Date.now();
        mockRegistrationFetch({ ...options, timeoutMs: 80 });
        await expect(beginAppRegistration("feishu")).rejects.toMatchObject({
          name: "TimeoutError",
          message: "request timed out",
        });
        const elapsedMs = Date.now() - started;
        expect(elapsedMs).toBeGreaterThanOrEqual(60);
        expect(elapsedMs).toBeLessThan(2_000);
      },
    );
  });

  it("rejects Feishu API responses that exceed the 16 MiB JSON body cap", async () => {
    let clientClosed: Promise<void> | undefined;
    await withRegistrationServer(
      (_req, res) => {
        clientClosed = writeOversizedJson(
          res,
          FEISHU_JSON_MAX_BYTES,
          '{"device_code":"dev","padding":"',
        );
      },
      async () => {
        await expect(beginAppRegistration("feishu")).rejects.toThrow(
          /feishu\.api: JSON response exceeds \d+ bytes/,
        );
        await expect(clientClosed).resolves.toBeUndefined();
      },
    );
  });

  it("sends bound reads through the real SSRF guard before local socket redirect", async () => {
    const fetchCalls: string[] = [];
    await beginRegistrationJson({}, async (options) => {
      const recordingFetch: typeof fetch = withFetchPreconnect(async (input, init) => {
        fetchCalls.push(input instanceof Request ? input.url : input.toString());
        return await options.fetchImpl(input, init);
      });

      mockRegistrationFetch({ ...options, fetchImpl: recordingFetch });
      await expect(beginAppRegistration("feishu")).resolves.toMatchObject(beginResult);
    });

    expect(fetchCalls).toEqual(["https://accounts.feishu.cn/oauth/v1/app/registration"]);
  });
});
