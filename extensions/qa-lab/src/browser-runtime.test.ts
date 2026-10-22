import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  callQaBrowserRequest,
  qaBrowserAct,
  qaBrowserOpenTab,
  qaBrowserSnapshot,
  waitForQaBrowserReady,
} from "./browser-runtime.js";

function createEnv() {
  return {
    gateway: {
      call: vi.fn(async () => ({ ok: true })),
    },
  };
}

function expectRequest(
  env: ReturnType<typeof createEnv>,
  request: { method: string; path: string; query?: unknown; body?: unknown },
  timeoutMs = 20_000,
) {
  expect(env.gateway.call).toHaveBeenCalledWith(
    "browser.request",
    { query: undefined, body: undefined, ...request, timeoutMs },
    { timeoutMs },
  );
}

describe("browser-runtime", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("sends normalized browser.request payloads through the gateway", async () => {
    const env = createEnv();

    const result = await callQaBrowserRequest(env, {
      method: "GET",
      path: "/snapshot",
      query: {
        format: "ai",
        targetId: "tab-1",
        skip: undefined,
        limit: 50,
      },
      timeoutMs: 12_345,
    });

    expect(result).toEqual({ ok: true });
    expect(env.gateway.call).toHaveBeenCalledWith(
      "browser.request",
      {
        method: "GET",
        path: "/snapshot",
        query: {
          format: "ai",
          targetId: "tab-1",
          limit: "50",
        },
        body: undefined,
        timeoutMs: 12_345,
      },
      { timeoutMs: 12_345 },
    );
  });

  it("opens tabs through the browser proxy", async () => {
    const env = createEnv();

    await qaBrowserOpenTab(env, {
      url: "http://127.0.0.1:43124/control-ui/chat?session=test",
      profile: "openclaw",
    });

    expectRequest(env, {
      method: "POST",
      path: "/tabs/open",
      query: { profile: "openclaw" },
      body: { url: "http://127.0.0.1:43124/control-ui/chat?session=test" },
    });
  });

  it("captures snapshots with query options", async () => {
    const env = createEnv();

    await qaBrowserSnapshot(env, {
      targetId: "tab-1",
      interactive: true,
      labels: true,
      maxChars: 4_000,
    });

    expectRequest(env, {
      method: "GET",
      path: "/snapshot",
      query: {
        targetId: "tab-1",
        format: "ai",
        interactive: "true",
        labels: "true",
        maxChars: "4000",
      },
    });
  });

  it("runs browser act requests through /act", async () => {
    const env = createEnv();

    await qaBrowserAct(env, {
      profile: "openclaw",
      request: {
        kind: "type",
        ref: "12",
        text: "hello",
        submit: true,
      },
      timeoutMs: 9_000,
    });

    expectRequest(
      env,
      {
        method: "POST",
        path: "/act",
        query: { profile: "openclaw" },
        body: {
          kind: "type",
          ref: "12",
          text: "hello",
          submit: true,
        },
      },
      9_000,
    );
  });

  it("caps oversized browser request timeouts", async () => {
    const env = createEnv();

    await callQaBrowserRequest(env, {
      method: "GET",
      path: "/snapshot",
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });

    expectRequest(env, { method: "GET", path: "/snapshot" }, MAX_TIMER_TIMEOUT_MS);
  });

  it("waits until browser control reports a ready profile", async () => {
    const env = createEnv();
    env.gateway.call = vi
      .fn()
      .mockResolvedValueOnce({ enabled: true, running: false, cdpReady: false })
      .mockResolvedValueOnce({ enabled: true, running: true, cdpReady: true });

    const status = await waitForQaBrowserReady(env, {
      profile: "user",
      timeoutMs: 5_000,
      intervalMs: 1,
      sleepImpl: async () => {},
    });

    expect(status).toEqual({ enabled: true, running: true, cdpReady: true });
    expect(env.gateway.call).toHaveBeenNthCalledWith(
      1,
      "browser.request",
      {
        method: "GET",
        path: "/",
        query: { profile: "user" },
        body: undefined,
        timeoutMs: 5_000,
      },
      { timeoutMs: 5_000 },
    );
  });
});
