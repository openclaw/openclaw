// Msteams tests cover probe request-deadline behavior. Regression guard for
// the unbounded `await tokenProvider.getAccessToken(...)` calls at probe.ts:75
// and probe.ts:89. Other MS Teams paths (attachments/bot-framework.ts:252,
// attachments/graph.ts:258, monitor-handler/message-handler.ts:594/654/685)
// wrap the same SDK call with `withMSTeamsRequestDeadline` so stalled Azure AD
// cannot pin the call; the probe was the one missing site. This test exercises
// the real `probeMSTeams()` code path with a stalled-token injection and
// asserts that the call returns within the bounded deadline instead of
// hanging on the naked await.
//
// Test design: drive `withTimeout`'s internal `setTimeout` via
// `vi.useFakeTimers()` so each stalled case resolves in milliseconds instead
// of waiting 30 production seconds. `withTimeout` (from
// `@openclaw/fs-safe/dist/timing.js`) uses `setTimeout` + `clearTimeout`,
// which `vi.useFakeTimers()` mocks globally. A separate case asserts the
// production default deadline is exactly `MSTEAMS_REQUEST_TIMEOUT_MS = 30_000`
// so the production contract is not silently weakened.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MSTeamsConfig } from "../runtime-api.js";

const hostMockState = vi.hoisted(() => ({
  stallTokens: false as boolean,
  stallMode: "bot" as "bot" | "graph" | "both",
  observedTimeouts: [] as number[],
}));

vi.mock("@microsoft/teams.apps", () => ({
  App: class {
    tokenManager = {
      getBotToken: async () => {
        if (
          hostMockState.stallTokens &&
          (hostMockState.stallMode === "bot" || hostMockState.stallMode === "both")
        ) {
          // Never-resolving Promise simulates a stalled Azure AD token endpoint.
          return await new Promise<{ toString(): string }>(() => {});
        }
        return { toString: () => "bot-token" };
      },
      getGraphToken: async () => {
        if (
          hostMockState.stallTokens &&
          (hostMockState.stallMode === "graph" || hostMockState.stallMode === "both")
        ) {
          return await new Promise<{ toString(): string }>(() => {});
        }
        return { toString: () => "graph-token" };
      },
    };
  },
  ExpressAdapter: vi.fn(),
}));

vi.mock("@microsoft/teams.api", () => ({
  Client: function Client() {},
  cloudFromName: () => ({
    botScope: "https://api.botframework.com/.default",
    graphScope: "https://graph.microsoft.com/.default",
  }),
}));

// Capture the timeoutMs value used by the production `withTimeout` helper so we
// can assert the production default is the documented 30 seconds. We mock the
// public helper rather than `withTimeout` itself so the real deadline-then-race
// logic still runs under fake timers.
vi.mock("openclaw/plugin-sdk/text-utility-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/text-utility-runtime")>(
    "openclaw/plugin-sdk/text-utility-runtime",
  );
  return {
    ...actual,
    withTimeout: async <T>(promise: Promise<T>, timeoutMs: number, label?: string): Promise<T> => {
      hostMockState.observedTimeouts.push(timeoutMs);
      return actual.withTimeout(promise, timeoutMs, label);
    },
  };
});

import { probeMSTeams } from "./probe.js";

const VALID_CFG = {
  enabled: true,
  appId: "app",
  appPassword: "pw",
  tenantId: "tenant",
} as unknown as MSTeamsConfig;

const PRODUCTION_DEADLINE_MS = 30_000;

describe("msteams probe request-deadline", () => {
  beforeEach(() => {
    hostMockState.stallTokens = false;
    hostMockState.stallMode = "both";
    hostMockState.observedTimeouts.length = 0;
    vi.stubEnv("MSTEAMS_APP_ID", "");
    vi.stubEnv("MSTEAMS_APP_PASSWORD", "");
    vi.stubEnv("MSTEAMS_TENANT_ID", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  // Drives the real `withMSTeamsRequestDeadline` under fake timers so the
  // stalled SDK promise rejects via the 30s deadline instead of waiting 30
  // wall-clock seconds per case. `vi.advanceTimersByTimeAsync(PRODUCTION_DEADLINE_MS + 1_000)`
  // trips the inner `setTimeout` from `withTimeout`, which causes the
  // `Promise.race` to settle with the deadline-rejection error.
  async function probeStalled(mode: "bot" | "graph" | "both"): Promise<unknown> {
    hostMockState.stallTokens = true;
    hostMockState.stallMode = mode;
    vi.useFakeTimers();
    const probePromise = probeMSTeams(VALID_CFG);
    // Let the synchronous portion of probeMSTeams (App construction +
    // tokenProvider wiring + withMSTeamsRequestDeadline race registration)
    // complete on the microtask queue before advancing fake time.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(PRODUCTION_DEADLINE_MS + 1_000);
    return await probePromise;
  }

  it("returns a bounded probe result when the bot token stalls", async () => {
    const result = (await probeStalled("bot")) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/MS Teams Bot Framework probe token/);
    expect(result.error).toMatch(/timed out after 30000ms/);
  });

  it("returns a bounded probe result when the graph token stalls", async () => {
    const result = (await probeStalled("graph")) as {
      ok: boolean;
      error?: string;
      graph?: { ok: boolean; error?: string };
    };
    // Outer probe is `ok: true` (bot succeeded); graph field carries the bounded failure.
    expect(result.ok).toBe(true);
    expect(result.graph?.ok).toBe(false);
    expect(result.graph?.error).toMatch(/MS Teams Graph probe token/);
    expect(result.graph?.error).toMatch(/timed out after 30000ms/);
  });

  it("returns a bounded probe result when both tokens stall", async () => {
    const result = (await probeStalled("both")) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/MS Teams Bot Framework probe token/);
    expect(result.error).toMatch(/timed out after 30000ms/);
  });

  it("returns ok=true for a normal (non-stalled) probe", async () => {
    hostMockState.stallTokens = false;
    const result = await probeMSTeams(VALID_CFG);
    expect(result.ok).toBe(true);
  });

  it("uses the documented 30s production default deadline for both token acquisitions", async () => {
    // Run a normal probe and observe the two `withTimeout` calls. Both must use
    // the production default — not a weakened test value. The probe calls
    // `withMSTeamsRequestDeadline` twice in series (bot then graph); we expect
    // exactly two observed timeouts, both 30_000.
    hostMockState.stallTokens = false;
    await probeMSTeams(VALID_CFG);
    expect(hostMockState.observedTimeouts).toEqual([
      PRODUCTION_DEADLINE_MS,
      PRODUCTION_DEADLINE_MS,
    ]);
  });
});
