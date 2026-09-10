/**
 * Daybreak cyber-failover policy: what may escalate, once, and for how long.
 */
import { describe, expect, it } from "vitest";
import {
  isCodexCyberEscalationAnswered,
  isCodexCyberEscalationReplaySafe,
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
  it("refuses to replay a turn that already acted", () => {
    const SESSION = nextSession();
    expect(
      planCodexCyberEscalation({
        config: config(),
        sessionKey: SESSION,
        currentModel: PRIMARY,
        replaySafe: false,
      }),
    ).toEqual({ kind: "skip", reason: "not_replay_safe" });
  });

  it("reads replay safety only from an explicit safe verdict", () => {
    expect(isCodexCyberEscalationReplaySafe({ replayMetadata: { replaySafe: true } })).toBe(true);
    expect(isCodexCyberEscalationReplaySafe({ replayMetadata: { replaySafe: false } })).toBe(false);
    expect(isCodexCyberEscalationReplaySafe({})).toBe(false);
    expect(isCodexCyberEscalationReplaySafe(undefined)).toBe(false);
  });

  it("escalates a refused turn to the configured Daybreak model", () => {
    const SESSION = nextSession();
    expect(
      planCodexCyberEscalation({
        config: config(),
        sessionKey: SESSION,
        currentModel: PRIMARY,
        replaySafe: true,
      }),
    ).toEqual({ kind: "escalate", model: DAYBREAK });
  });

  it("does not escalate when the operator disabled it", () => {
    const SESSION = nextSession();
    expect(
      planCodexCyberEscalation({
        config: config({ mode: "off" }),
        replaySafe: true,
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
        replaySafe: true,
        sessionKey: SESSION,
        currentModel: DAYBREAK,
      }),
    ).toEqual({ kind: "skip", reason: "already_daybreak" });
    // Host refs may be provider-qualified.
    expect(
      planCodexCyberEscalation({
        config: config(),
        replaySafe: true,
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
        replaySafe: true,
        sessionKey: SESSION,
        currentModel: PRIMARY,
        now: now + 1,
      }),
    ).toEqual({ kind: "skip", reason: "cooling_off" });
    expect(
      planCodexCyberEscalation({
        config: config(),
        replaySafe: true,
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
        replaySafe: true,
        sessionKey: "other-session",
        currentModel: PRIMARY,
        now: 1_001,
      }),
    ).toEqual({ kind: "escalate", model: DAYBREAK });
  });
});

describe("escalation outcome", () => {
  it("counts only a real reply as answered", () => {
    expect(
      isCodexCyberEscalationAnswered({
        currentAttemptAssistant: { role: "assistant", stopReason: "stop" },
      }),
    ).toBe(true);
    // A transport failure is not a reply, even though it carries no refusal.
    expect(isCodexCyberEscalationAnswered({ promptError: "stream disconnected" })).toBe(false);
    expect(
      isCodexCyberEscalationAnswered({ lastAssistant: { role: "assistant", stopReason: "error" } }),
    ).toBe(false);
    expect(
      isCodexCyberEscalationAnswered({
        lastAssistant: { role: "assistant", stopReason: "aborted" },
      }),
    ).toBe(false);
    expect(isCodexCyberEscalationAnswered({})).toBe(false);
    expect(isCodexCyberEscalationAnswered(undefined)).toBe(false);
  });

  it("prefers the current attempt over an older assistant row", () => {
    expect(
      isCodexCyberEscalationAnswered({
        lastAssistant: { role: "assistant", stopReason: "stop" },
        currentAttemptAssistant: { role: "assistant", stopReason: "error" },
      }),
    ).toBe(false);
  });
});

describe("window bookkeeping", () => {
  it("never evicts a live suppression window to make room", () => {
    const now = 1_000;
    recordCodexCyberEscalation({
      sessionKey: "suppressed-first",
      outcome: "suppressed",
      cooloffMs: 600_000,
      now,
    });
    for (let index = 0; index < 400; index += 1) {
      recordCodexCyberEscalation({
        sessionKey: `filler-${index}`,
        outcome: "answered",
        cooloffMs: 600_000,
        now,
      });
    }
    // The unauthorized target must still be suppressed, or it would be retried
    // inside its cooloff.
    expect(
      planCodexCyberEscalation({
        config: config(),
        sessionKey: "suppressed-first",
        currentModel: PRIMARY,
        replaySafe: true,
        now: now + 1,
      }),
    ).toEqual({ kind: "skip", reason: "cooling_off" });
  });

  it("stays bounded when many sessions escalate", () => {
    const now = 1_000;
    for (let index = 0; index < 400; index += 1) {
      recordCodexCyberEscalation({
        sessionKey: `bounded-${index}`,
        outcome: "answered",
        cooloffMs: 600_000,
        now,
      });
    }
    // The newest session keeps its window; older ones are shed rather than kept
    // for the life of the process.
    expect(
      resolveCodexCyberStickyModel({
        config: config(),
        sessionKey: "bounded-399",
        currentModel: PRIMARY,
        now: now + 1,
      }),
    ).toBe(DAYBREAK);
    expect(
      resolveCodexCyberStickyModel({
        config: config(),
        sessionKey: "bounded-0",
        currentModel: PRIMARY,
        now: now + 1,
      }),
    ).toBeUndefined();
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
