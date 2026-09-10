/**
 * Daybreak cyber-failover policy: what may escalate, once, and for how long.
 */
import { describe, expect, it } from "vitest";
import {
  isCodexCyberRefusalResult,
  isCodexDaybreakUnavailableResult,
  planCodexCyberEscalation,
  recordCodexCyberEscalation,
  resolveCodexCyberFailoverConfig,
  resolveCodexCyberStickyModel,
  type CodexCyberFailoverConfig,
} from "./cyber-failover.js";

const DAYBREAK = "gpt-daybreak-blue-latest";
const PRIMARY = "gpt-6-astra";

// The escalation window is process-global and keyed by session, so each case
// uses its own key instead of reaching for a production reset hook.
let sessionCounter = 0;
function nextSession(): string {
  sessionCounter += 1;
  return `session-${sessionCounter}`;
}

function refusalResult(category: string) {
  return {
    lastAssistant: {
      role: "assistant",
      diagnostics: [{ type: "provider_refusal", details: { provider: "openai", category } }],
    },
  };
}

function config(overrides: Partial<CodexCyberFailoverConfig> = {}): CodexCyberFailoverConfig {
  return { mode: "auto", model: DAYBREAK, cooloffMs: 600_000, ...overrides };
}

describe("cyber failover config", () => {
  it("defaults to automatic Daybreak Blue escalation with a cooloff", () => {
    const resolved = resolveCodexCyberFailoverConfig(undefined);
    expect(resolved).toEqual({
      mode: "auto",
      model: DAYBREAK,
      cooloffMs: 600_000,
    });
  });

  it("reads operator overrides from the codex app-server config", () => {
    const resolved = resolveCodexCyberFailoverConfig({
      appServer: { cyberFailover: { mode: "off", model: "gpt-daybreak-red-latest" } },
    });
    expect(resolved).toEqual({
      mode: "off",
      model: "gpt-daybreak-red-latest",
      cooloffMs: 600_000,
    });
  });
});

describe("cyber refusal detection", () => {
  it("matches only the cyber refusal category", () => {
    expect(isCodexCyberRefusalResult(refusalResult("cyber"))).toBe(true);
    expect(isCodexCyberRefusalResult(refusalResult("bio"))).toBe(false);
    expect(isCodexCyberRefusalResult(refusalResult("misalignment"))).toBe(false);
    expect(isCodexCyberRefusalResult({ lastAssistant: { role: "assistant" } })).toBe(false);
    expect(isCodexCyberRefusalResult(undefined)).toBe(false);
  });

  it("reads an unauthorized Daybreak target from the attempt outcome", () => {
    expect(
      isCodexDaybreakUnavailableResult({
        lastAssistant: {
          role: "assistant",
          errorMessage:
            "unexpected status 401 Unauthorized: You are not authorized to access this model.",
        },
      }),
    ).toBe(true);
    expect(
      isCodexDaybreakUnavailableResult({
        promptError:
          "unexpected status 403 Forbidden: The requested Cyber access program is not authorized",
      }),
    ).toBe(true);
    expect(isCodexDaybreakUnavailableResult({ promptError: "stream disconnected" })).toBe(false);
  });
});

describe("escalation planning", () => {
  it("escalates a refused turn to the configured Daybreak model", () => {
    const SESSION = nextSession();
    expect(
      planCodexCyberEscalation({ config: config(), sessionKey: SESSION, currentModel: PRIMARY }),
    ).toEqual({ kind: "escalate", model: DAYBREAK });
  });

  it("does not escalate when the operator disabled it", () => {
    const SESSION = nextSession();
    expect(
      planCodexCyberEscalation({
        config: config({ mode: "off" }),
        sessionKey: SESSION,
        currentModel: PRIMARY,
      }),
    ).toEqual({ kind: "skip", reason: "disabled" });
  });

  it("does not escalate a turn already running on Daybreak", () => {
    const SESSION = nextSession();
    expect(
      planCodexCyberEscalation({
        config: config(),
        sessionKey: SESSION,
        currentModel: DAYBREAK,
      }),
    ).toEqual({ kind: "skip", reason: "already_daybreak" });
    // Host refs may be provider-qualified.
    expect(
      planCodexCyberEscalation({
        config: config(),
        sessionKey: SESSION,
        currentModel: `openai/${DAYBREAK}`,
      }),
    ).toEqual({ kind: "skip", reason: "already_daybreak" });
  });

  it("attempts escalation at most once inside the cooloff window", () => {
    const SESSION = nextSession();
    const now = 1_000;
    recordCodexCyberEscalation({
      sessionKey: SESSION,
      outcome: "suppressed",
      cooloffMs: 600_000,
      now,
    });
    expect(
      planCodexCyberEscalation({
        config: config(),
        sessionKey: SESSION,
        currentModel: PRIMARY,
        now: now + 1,
      }),
    ).toEqual({ kind: "skip", reason: "cooling_off" });
    expect(
      planCodexCyberEscalation({
        config: config(),
        sessionKey: SESSION,
        currentModel: PRIMARY,
        now: now + 600_001,
      }),
    ).toEqual({ kind: "escalate", model: DAYBREAK });
  });

  it("keeps sessions independent", () => {
    const SESSION = nextSession();
    recordCodexCyberEscalation({
      sessionKey: SESSION,
      outcome: "answered",
      cooloffMs: 600_000,
      now: 1_000,
    });
    expect(
      planCodexCyberEscalation({
        config: config(),
        sessionKey: "other-session",
        currentModel: PRIMARY,
        now: 1_001,
      }),
    ).toEqual({ kind: "escalate", model: DAYBREAK });
  });
});

describe("sticky routing inside the window", () => {
  it("pre-routes follow-up turns only after Daybreak actually answered", () => {
    const SESSION = nextSession();
    const now = 1_000;
    recordCodexCyberEscalation({
      sessionKey: SESSION,
      outcome: "answered",
      cooloffMs: 600_000,
      now,
    });
    expect(
      resolveCodexCyberStickyModel({
        config: config(),
        sessionKey: SESSION,
        currentModel: PRIMARY,
        now: now + 1,
      }),
    ).toBe(DAYBREAK);
  });

  it("never pre-routes after a suppressed escalation", () => {
    const SESSION = nextSession();
    const now = 1_000;
    recordCodexCyberEscalation({
      sessionKey: SESSION,
      outcome: "suppressed",
      cooloffMs: 600_000,
      now,
    });
    expect(
      resolveCodexCyberStickyModel({
        config: config(),
        sessionKey: SESSION,
        currentModel: PRIMARY,
        now: now + 1,
      }),
    ).toBeUndefined();
  });

  it("reverts to the selected model once the window expires", () => {
    const SESSION = nextSession();
    const now = 1_000;
    recordCodexCyberEscalation({
      sessionKey: SESSION,
      outcome: "answered",
      cooloffMs: 600_000,
      now,
    });
    expect(
      resolveCodexCyberStickyModel({
        config: config(),
        sessionKey: SESSION,
        currentModel: PRIMARY,
        now: now + 600_001,
      }),
    ).toBeUndefined();
  });

  it("stays inert when escalation is disabled", () => {
    const SESSION = nextSession();
    recordCodexCyberEscalation({
      sessionKey: SESSION,
      outcome: "answered",
      cooloffMs: 600_000,
      now: 1_000,
    });
    expect(
      resolveCodexCyberStickyModel({
        config: config({ mode: "off" }),
        sessionKey: SESSION,
        currentModel: PRIMARY,
        now: 1_001,
      }),
    ).toBeUndefined();
  });
});
