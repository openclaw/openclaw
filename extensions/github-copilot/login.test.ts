import { oversizedJsonResponse } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelTrackedTextResponse } from "../test-support/streaming-error-response.js";

const guardFetch = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: guardFetch,
}));

import { runGitHubCopilotDeviceFlow } from "./login.js";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const authorized = { access_token: "ghu_tok_xyz", token_type: "bearer" };
const quietIO = () => ({ showCode: vi.fn(async () => {}) });

const VALID_DEVICE_CODE_BODY = {
  device_code: "dev-code-abc123",
  user_code: "ABCD-1234",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
};

function guardResponse(body: unknown, status = 200) {
  return {
    response: body instanceof Response ? body : Response.json(body, { status }),
    release: vi.fn(async () => {}),
  };
}

function mockPoll(body: unknown) {
  guardFetch
    .mockResolvedValueOnce(guardResponse(VALID_DEVICE_CODE_BODY))
    .mockResolvedValueOnce(guardResponse(body));
}

afterEach(() => {
  guardFetch.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function runDeviceFlowAfterFirstPoll(
  io: Parameters<typeof runGitHubCopilotDeviceFlow>[0] = quietIO(),
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
    const controller = new AbortController();
    guardFetch.mockImplementation(async (params) => {
      expect(params.signal).toBe(controller.signal);
      expect(params.timeoutMs).toBe(30_000);
      return params.url === DEVICE_CODE_URL
        ? guardResponse(VALID_DEVICE_CODE_BODY)
        : guardResponse(authorized);
    });

    const showCode = vi.fn(async () => {});
    const result = await runDeviceFlowAfterFirstPoll({ showCode, signal: controller.signal });

    expect(result).toEqual({ status: "authorized", accessToken: "ghu_tok_xyz" });
    expect(showCode).toHaveBeenCalledWith({
      verificationUrl: "https://github.com/login/device",
      userCode: "ABCD-1234",
      expiresInMs: expect.any(Number),
    });
    expect(guardFetch.mock.calls.map(([params]) => params.url)).toEqual([
      DEVICE_CODE_URL,
      ACCESS_TOKEN_URL,
    ]);
  });
  it.each([
    { stage: "initial request", interval: 0, expectedPolls: 0 },
    { stage: "showCode", interval: 0, expectedPolls: 0 },
    { stage: "pending response", interval: 1, expectedPolls: 1 },
  ])(
    "stops polling when authority is revoked during $stage",
    async ({ stage, interval, expectedPolls }) => {
      vi.useFakeTimers();
      let current = stage !== "initial request";
      let tokenPolls = 0;
      const dispatch = vi.fn();
      guardFetch.mockImplementation(async (params) => {
        params.beforeRequest?.();
        dispatch();
        if (params.url === DEVICE_CODE_URL) {
          return guardResponse({ ...VALID_DEVICE_CODE_BODY, interval });
        }
        tokenPolls += 1;
        if (stage === "pending response" && tokenPolls === 1) {
          current = false;
          return guardResponse({ error: "authorization_pending" });
        }
        return guardResponse(authorized);
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
      expect(dispatch).toHaveBeenCalledTimes(stage === "initial request" ? 0 : expectedPolls + 1);
    },
  );
  it("cancels the unread device token body before throwing on non-OK", async () => {
    const tracked = cancelTrackedTextResponse(JSON.stringify({ error: "server_error" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
    mockPoll(tracked.response);

    await expect(runDeviceFlowAfterFirstPoll()).rejects.toThrow(
      "GitHub device token failed: HTTP 401",
    );
    expect(tracked.wasCanceled()).toBe(true);
  });

  it("rejects a malformed access token response", async () => {
    mockPoll({ access_token: null, token_type: "bearer" });

    await expect(runDeviceFlowAfterFirstPoll()).rejects.toThrow(
      "GitHub device flow returned an invalid access token",
    );
  });
  it("bounds oversized access token bodies and cancels the stream", async () => {
    const body = oversizedJsonResponse({ chunkCount: 64, chunkSize: 1024 * 1024 });
    mockPoll(body.response);
    await expect(runDeviceFlowAfterFirstPoll()).rejects.toThrow("github-copilot.device-flow");
    expect(body.getReadCount()).toBeLessThan(64);
    expect(body.wasCanceled()).toBe(true);
  });
  it("rejects a verification URL whose host does not match the configured domain", async () => {
    guardFetch.mockImplementation(async () => guardResponse(VALID_DEVICE_CODE_BODY));

    await expect(runGitHubCopilotDeviceFlow(quietIO(), "acme.ghe.com")).rejects.toThrow(
      "unexpected verification URL",
    );
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
      delays: [4_999, 1, 5_000, 10_000, 15_000],
      times: [5_000, 10_000, 20_000, 35_000],
    },
    {
      name: "server-provided slow_down interval",
      interval: 2,
      responses: [{ error: "slow_down", interval: 7 }],
      delays: [2_000, 6_999, 1],
      times: [2_000, 9_000],
    },
  ])("respects $name", async ({ interval, responses, delays, times }) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const pollTimes: number[] = [];
    const pollResponses = [
      ...responses,
      { access_token: "test-access-token", token_type: "bearer" },
    ];
    guardFetch.mockImplementation(async (params) => {
      if (params.url === DEVICE_CODE_URL) {
        const { interval: _interval, ...withoutInterval } = VALID_DEVICE_CODE_BODY;
        return guardResponse({
          ...withoutInterval,
          ...(interval === undefined ? {} : { interval }),
        });
      }
      pollTimes.push(Date.now());
      return guardResponse(pollResponses.shift());
    });

    const result = runGitHubCopilotDeviceFlow(quietIO());

    let elapsed = 0;
    for (const delay of delays) {
      await vi.advanceTimersByTimeAsync(delay);
      elapsed += delay;
      expect(pollTimes).toEqual(times.filter((time) => time <= elapsed));
    }

    await expect(result).resolves.toEqual({
      status: "authorized",
      accessToken: "test-access-token",
    });
  });

  it.each([{ clockStepMs: -20 * 60_000 }, { clockStepMs: 20 * 60_000 }])(
    "keeps the full authorization window across a $clockStepMs ms wall-clock step",
    async ({ clockStepMs }) => {
      // Timers advance the monotonic deadline independently of Date.now().
      vi.useFakeTimers();
      vi.setSystemTime(0);
      let polls = 0;

      guardFetch.mockImplementation(async (params) => {
        if (params.url === DEVICE_CODE_URL) {
          return guardResponse(VALID_DEVICE_CODE_BODY);
        }
        polls += 1;
        return guardResponse({ error: "authorization_pending" });
      });

      let settled = false;
      const observing = runGitHubCopilotDeviceFlow(quietIO())
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        )
        .finally(() => {
          settled = true;
        });
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(polls).toBe(0);

        await vi.advanceTimersByTimeAsync(5_000);
        expect({ polls, settled }).toEqual({ polls: 1, settled: false });

        vi.setSystemTime(clockStepMs);
        await vi.advanceTimersByTimeAsync(5_000);
        expect({ polls, settled }).toEqual({ polls: 2, settled: false });

        await vi.advanceTimersByTimeAsync(15 * 60_000 - 10_000 - 1);
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toBe(true);
        await expect(observing).resolves.toEqual({ value: { status: "expired" } });

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
