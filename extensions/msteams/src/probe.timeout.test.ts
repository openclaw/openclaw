// Msteams tests cover probe request-deadline behavior. Regression guard for
// the unbounded `await tokenProvider.getAccessToken(...)` calls at probe.ts:75
// and probe.ts:89. Other MS Teams paths (attachments/bot-framework.ts:252,
// attachments/graph.ts:258, monitor-handler/message-handler.ts:594/654/685)
// wrap the same SDK call with `withMSTeamsRequestDeadline` so stalled Azure AD
// cannot pin the call; the probe was the one missing site. This test exercises
// the real `probeMSTeams()` code path with a stalled-token injection and
// asserts that the call returns within the bounded deadline instead of
// hanging on the naked await.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MSTeamsConfig } from "../runtime-api.js";

const hostMockState = vi.hoisted(() => ({
  stallTokens: false as boolean,
  stallMode: "bot" as "bot" | "graph" | "both",
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

import { probeMSTeams } from "./probe.js";

const VALID_CFG = {
  enabled: true,
  appId: "app",
  appPassword: "pw",
  tenantId: "tenant",
} as unknown as MSTeamsConfig;

describe("msteams probe request-deadline", () => {
  beforeEach(() => {
    hostMockState.stallTokens = false;
    hostMockState.stallMode = "both";
    vi.stubEnv("MSTEAMS_APP_ID", "");
    vi.stubEnv("MSTEAMS_APP_PASSWORD", "");
    vi.stubEnv("MSTEAMS_TENANT_ID", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Mirrors the pattern in error-body-boundary.test.ts: race the real probe
  // against a proof budget. If the probe wraps the SDK call with
  // withMSTeamsRequestDeadline (default MSTEAMS_REQUEST_TIMEOUT_MS = 30_000)
  // the race resolves inside the budget. If the await is naked the race hits
  // the budget and the test reports the elapsed wall-clock.
  async function probeWithBudget(
    mode: "bot" | "graph" | "both",
    proofBudgetMs: number,
  ): Promise<{ status: "resolved" | "budget-exceeded"; result: unknown; elapsedMs: number }> {
    hostMockState.stallTokens = true;
    hostMockState.stallMode = mode;
    const start = Date.now();
    const winner = await Promise.race<{ kind: "ok"; result: unknown } | { kind: "budget" }>([
      probeMSTeams(VALID_CFG).then((r) => ({ kind: "ok" as const, result: r })),
      new Promise<void>((resolve) => {
        setTimeout(() => resolve(), proofBudgetMs);
      }).then(() => ({ kind: "budget" as const })),
    ]);
    const elapsed = Date.now() - start;
    if (winner.kind === "ok") {
      return { status: "resolved", result: winner.result, elapsedMs: elapsed };
    }
    return { status: "budget-exceeded", result: null, elapsedMs: elapsed };
  }

  it("returns within the operation deadline when the bot token stalls", async () => {
    const out = await probeWithBudget("bot", 45_000);
    // The probe should be bounded by MSTEAMS_REQUEST_TIMEOUT_MS (30_000) plus
    // some setup overhead. After the fix, this is well under 45s.
    expect(out.status).toBe("resolved");
    expect(out.elapsedMs).toBeLessThan(45_000);
  });

  it("returns within the operation deadline when the graph token stalls", async () => {
    const out = await probeWithBudget("graph", 45_000);
    expect(out.status).toBe("resolved");
    expect(out.elapsedMs).toBeLessThan(45_000);
  });

  it("returns within the operation deadline when both tokens stall", async () => {
    const out = await probeWithBudget("both", 60_000);
    expect(out.status).toBe("resolved");
    expect(out.elapsedMs).toBeLessThan(60_000);
  });

  it("returns ok=true for a normal (non-stalled) probe", async () => {
    const result = await probeMSTeams(VALID_CFG);
    expect(result.ok).toBe(true);
  });
});
