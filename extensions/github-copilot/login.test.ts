import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  );
  return { ...actual, fetchWithSsrFGuard: mocks.fetchWithSsrFGuard };
});

import { runGitHubCopilotDeviceFlow } from "./login.js";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

const VALID_DEVICE_CODE_BODY = {
  device_code: "dev-code-abc123",
  user_code: "ABCD-1234",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
};

function guardResponse(body: unknown, status = 200, url = DEVICE_CODE_URL) {
  return {
    response: body instanceof Response ? body : Response.json(body, { status }),
    finalUrl: url,
    release: vi.fn(async () => {}),
  };
}

function mockPoll(body: unknown) {
  mocks.fetchWithSsrFGuard
    .mockResolvedValueOnce(guardResponse(VALID_DEVICE_CODE_BODY))
    .mockResolvedValueOnce(guardResponse(body, 200, ACCESS_TOKEN_URL));
}

afterEach(() => {
  mocks.fetchWithSsrFGuard.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function runDeviceFlowAfterFirstPoll(
  io: Parameters<typeof runGitHubCopilotDeviceFlow>[0] = {
    showCode: vi.fn(async () => {}),
  },
  domain?: string,
) {
  vi.useFakeTimers();
  const result = runGitHubCopilotDeviceFlow(io, domain);
  return Promise.all([result, vi.advanceTimersByTimeAsync(5_000)]).then(
    ([flowResult]) => flowResult,
  );
}

describe("runGitHubCopilotDeviceFlow", () => {
  it("bounds requests and returns authorized status and access token on successful flow", async () => {
    let callIdx = 0;
    const requestTimeouts: Array<number | undefined> = [];
    const controller = new AbortController();
    mocks.fetchWithSsrFGuard.mockImplementation(async (params) => {
      callIdx += 1;
      requestTimeouts.push(params.timeoutMs);
      expect(params.signal).toBe(controller.signal);
      if (callIdx === 1) {
        expect(params.url).toBe(DEVICE_CODE_URL);
        return guardResponse(VALID_DEVICE_CODE_BODY);
      }
      expect(params.url).toBe(ACCESS_TOKEN_URL);
      return guardResponse(
        { access_token: "ghu_tok_xyz", token_type: "bearer" },
        200,
        ACCESS_TOKEN_URL,
      );
    });

    const showCode = vi.fn(async () => {});
    const result = await runDeviceFlowAfterFirstPoll({
      showCode,
      signal: controller.signal,
    });

    expect(result).toEqual({
      status: "authorized",
      accessToken: "ghu_tok_xyz",
    });
    expect(showCode).toHaveBeenCalledWith({
      verificationUrl: "https://github.com/login/device",
      userCode: "ABCD-1234",
      expiresInMs: expect.any(Number),
    });
    expect(callIdx).toBe(2);
    expect(requestTimeouts).toEqual([30_000, 30_000]);
  });

  it.each([
    ["access_denied", "access_denied"],
    ["expired_token", "expired"],
  ])("maps terminal response %s to %s", async (error, status) => {
    mockPoll({ error });
    await expect(runDeviceFlowAfterFirstPoll()).resolves.toEqual({ status });
  });
  it("does not dispatch the initial request after authority is revoked", async () => {
    const dispatch = vi.fn();
    mocks.fetchWithSsrFGuard.mockImplementation(async (params) => {
      params.beforeRequest?.();
      dispatch();
      throw new Error("Request dispatched after authority was revoked");
    });

    await expect(
      runGitHubCopilotDeviceFlow({
        showCode: vi.fn(),
        assertCurrent: () => {
          throw new Error("Login revoked");
        },
      }),
    ).rejects.toThrow("Login revoked");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([
    { stage: "showCode", interval: 0, expectedPolls: 0 },
    { stage: "pending response", interval: 1, expectedPolls: 1 },
  ])(
    "stops polling when authority is revoked during $stage",
    async ({ stage, interval, expectedPolls }) => {
      vi.useFakeTimers();
      let current = true;
      let tokenPolls = 0;
      mocks.fetchWithSsrFGuard.mockImplementation(async (params) => {
        params.beforeRequest?.();
        if (params.url === DEVICE_CODE_URL) {
          return guardResponse({ ...VALID_DEVICE_CODE_BODY, interval });
        }
        tokenPolls += 1;
        if (stage === "pending response" && tokenPolls === 1) {
          current = false;
          return guardResponse({ error: "authorization_pending" }, 200, ACCESS_TOKEN_URL);
        }
        return guardResponse(
          { access_token: "ghu_tok_xyz", token_type: "bearer" },
          200,
          ACCESS_TOKEN_URL,
        );
      });

      const rejection = expect(
        runGitHubCopilotDeviceFlow({
          showCode: async () => {
            if (stage === "showCode") {
              current = false;
            }
          },
          assertCurrent: () => {
            if (!current) {
              throw new Error("Login revoked");
            }
          },
        }),
      ).rejects.toThrow("Login revoked");
      await vi.advanceTimersByTimeAsync((expectedPolls + 1) * 1_000);

      await rejection;
      expect(tokenPolls).toBe(expectedPolls);
    },
  );
  it("cancels the unread device token body before throwing on non-OK", async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: "server_error" })));
      },
      cancel() {
        canceled = true;
      },
    });
    mockPoll(
      new Response(body, {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(runDeviceFlowAfterFirstPoll()).rejects.toThrow(
      "GitHub device token failed: HTTP 401",
    );
    expect(canceled).toBe(true);
  });

  it("rejects a malformed access token response", async () => {
    mockPoll({ access_token: null, token_type: "bearer" });

    await expect(runDeviceFlowAfterFirstPoll()).rejects.toThrow(
      "GitHub device flow returned an invalid access token",
    );
  });
  it("bounds oversized access token bodies and cancels the stream", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let readCount = 0;
    let canceled = false;
    // Stop well before consuming the 64 MiB source body.
    const oversizedBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (readCount >= 64) {
          controller.close();
          return;
        }
        readCount += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        canceled = true;
      },
    });
    mockPoll(
      new Response(oversizedBody, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(runDeviceFlowAfterFirstPoll()).rejects.toThrow("github-copilot.device-flow");
    expect(readCount).toBeLessThan(64);
    expect(canceled).toBe(true);
  });
  it("rejects a verification URL whose host does not match the configured domain", async () => {
    const GHE_DOMAIN = "acme.ghe.com";
    mocks.fetchWithSsrFGuard.mockImplementation(async () =>
      guardResponse(
        {
          ...VALID_DEVICE_CODE_BODY,
          verification_uri: "https://github.com/login/device",
        },
        200,
        `https://${GHE_DOMAIN}/login/device/code`,
      ),
    );

    await expect(
      runGitHubCopilotDeviceFlow({ showCode: vi.fn(async () => {}) }, GHE_DOMAIN),
    ).rejects.toThrow("unexpected verification URL");
  });
  it.each([
    {
      name: "default interval and cumulative slow_down",
      interval: undefined,
      responses: [
        { error: "authorization_pending" },
        { error: "slow_down", interval: 7 },
        { error: "slow_down" },
      ],
      steps: [
        { delay: 4_999, times: [] },
        { delay: 1, times: [5_000] },
        { delay: 5_000, times: [5_000, 10_000] },
        { delay: 10_000, times: [5_000, 10_000, 20_000] },
        { delay: 15_000, times: [5_000, 10_000, 20_000, 35_000] },
      ],
    },
    {
      name: "server-provided slow_down interval",
      interval: 2,
      responses: [{ error: "slow_down", interval: 7 }],
      steps: [
        { delay: 2_000, times: [2_000] },
        { delay: 6_999, times: [2_000] },
        { delay: 1, times: [2_000, 9_000] },
      ],
    },
  ])("respects $name", async ({ interval, responses, steps }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T00:00:00Z"));
    const startedAt = Date.now();
    const pollTimes: number[] = [];
    const pollResponses = [
      ...responses,
      { access_token: "test-access-token", token_type: "bearer" },
    ];
    mocks.fetchWithSsrFGuard.mockImplementation(async (params) => {
      if (params.url === DEVICE_CODE_URL) {
        const { interval: _interval, ...withoutInterval } = VALID_DEVICE_CODE_BODY;
        return guardResponse({
          ...withoutInterval,
          ...(interval === undefined ? {} : { interval }),
        });
      }
      pollTimes.push(Date.now());
      return guardResponse(pollResponses.shift(), 200, ACCESS_TOKEN_URL);
    });

    const result = runGitHubCopilotDeviceFlow({
      showCode: vi.fn(async () => {}),
    });

    for (const { delay, times } of steps) {
      await vi.advanceTimersByTimeAsync(delay);
      expect(pollTimes).toEqual(times.map((elapsed) => startedAt + elapsed));
    }

    await expect(result).resolves.toEqual({
      status: "authorized",
      accessToken: "test-access-token",
    });
  });

  it.each([{ clockStepMs: -20 * 60_000 }, { clockStepMs: 20 * 60_000 }])(
    "keeps the full authorization window across a $clockStepMs ms wall-clock step",
    async ({ clockStepMs }) => {
      // advanceTimersByTimeAsync drives the faked monotonic clock and timers;
      // setSystemTime moves Date.now() independently of them. The token
      // endpoint never authorizes, so the flow must end on the monotonic
      // 15-minute budget exactly, regardless of wall-clock steps.
      vi.useFakeTimers();
      vi.setSystemTime(0);
      let polls = 0;

      mocks.fetchWithSsrFGuard.mockImplementation(async (params) => {
        if (params.url === DEVICE_CODE_URL) {
          return guardResponse(VALID_DEVICE_CODE_BODY);
        }
        polls += 1;
        return guardResponse({ error: "authorization_pending" }, 200, ACCESS_TOKEN_URL);
      });

      let settled = false;
      const observing = runGitHubCopilotDeviceFlow({
        showCode: vi.fn(async () => {}),
      }).then(
        (value) => {
          settled = true;
          return { value };
        },
        (error: unknown) => {
          settled = true;
          return { error };
        },
      );
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(polls).toBe(0);

        // The first poll lands after the initial 5-second interval.
        await vi.advanceTimersByTimeAsync(5_000);
        expect(polls).toBe(1);
        expect(settled).toBe(false);

        // Step the wall clock mid-flow; the monotonic deadline must not move.
        vi.setSystemTime(clockStepMs);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(polls).toBe(2);
        expect(settled).toBe(false);

        // The window must survive to the full monotonic budget.
        await vi.advanceTimersByTimeAsync(15 * 60_000 - 10_000 - 1);
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toBe(true);
        await expect(observing).resolves.toEqual({
          value: { status: "expired" },
        });

        const completedRequests = polls;
        await vi.advanceTimersByTimeAsync(30_000);
        expect(polls).toBe(completedRequests);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        await observing.catch(() => {});
        vi.useRealTimers();
      }
    },
  );
});
