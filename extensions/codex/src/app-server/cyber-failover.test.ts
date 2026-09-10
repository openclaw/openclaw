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
  clearCodexCyberSessionSuppression,
  recordCodexCyberEscalation,
  reserveCodexCyberProbe,
  resolveCodexCyberFailoverConfig,
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

function refusalResult(category: string, provider = "openai") {
  return {
    currentAttemptAssistant: {
      role: "assistant",
      diagnostics: [{ type: "provider_refusal", details: { provider, category } }],
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
    // Another provider's cyber refusal must not reroute a prompt to OpenAI's tier.
    expect(isCodexCyberRefusalResult(refusalResult("cyber", "other-provider"))).toBe(false);
    // A previous turn's refusal must not escalate an attempt that produced no row.
    expect(
      isCodexCyberRefusalResult({
        lastAssistant: {
          role: "assistant",
          diagnostics: [
            { type: "provider_refusal", details: { provider: "openai", category: "cyber" } },
          ],
        },
      }),
    ).toBe(false);
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
      model: DAYBREAK,
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
      outcome: "suppressed",
      model: DAYBREAK,
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

describe("concurrency and damper release", () => {
  it("lets a proven target escalate again once the damper is cleared", () => {
    const SESSION = nextSession();
    const now = 1_000;
    recordCodexCyberEscalation({
      sessionKey: SESSION,
      outcome: "suppressed",
      model: DAYBREAK,
      cooloffMs: 600_000,
      now,
    });
    expect(
      planCodexCyberEscalation({
        config: config(),
        sessionKey: SESSION,
        currentModel: PRIMARY,
        replaySafe: true,
        now: now + 1,
      }),
    ).toEqual({ kind: "skip", reason: "cooling_off" });
    clearCodexCyberSessionSuppression(SESSION);
    expect(
      planCodexCyberEscalation({
        config: config(),
        sessionKey: SESSION,
        currentModel: PRIMARY,
        replaySafe: true,
        now: now + 2,
      }),
    ).toEqual({ kind: "escalate", model: DAYBREAK });
  });

  it("holds sibling sessions while one probe is in flight", () => {
    const workspace = { agentId: "agent-p", authProfileId: "profile-p" };
    const release = reserveCodexCyberProbe({ model: DAYBREAK, workspace });
    expect(
      planCodexCyberEscalation({
        config: config(),
        sessionKey: nextSession(),
        currentModel: PRIMARY,
        replaySafe: true,
        workspace,
      }),
    ).toEqual({ kind: "skip", reason: "probe_in_flight" });
    release();
    expect(
      planCodexCyberEscalation({
        config: config(),
        sessionKey: nextSession(),
        currentModel: PRIMARY,
        replaySafe: true,
        workspace,
      }),
    ).toEqual({ kind: "escalate", model: DAYBREAK });
  });
});

describe("workspace scoping", () => {
  it("keeps one workspace's authorization failure out of another's way", () => {
    const now = 1_000;
    recordCodexCyberEscalation({
      sessionKey: nextSession(),
      outcome: "unavailable",
      model: DAYBREAK,
      workspace: { agentId: "agent-a", authProfileId: "profile-a" },
      cooloffMs: 600_000,
      now,
    });
    expect(
      planCodexCyberEscalation({
        config: config(),
        sessionKey: nextSession(),
        currentModel: PRIMARY,
        replaySafe: true,
        workspace: { agentId: "agent-a", authProfileId: "profile-a" },
        now: now + 1,
      }),
    ).toEqual({ kind: "skip", reason: "target_unavailable" });
    // A different authenticated workspace may well be entitled.
    expect(
      planCodexCyberEscalation({
        config: config(),
        sessionKey: nextSession(),
        currentModel: PRIMARY,
        replaySafe: true,
        workspace: { agentId: "agent-b", authProfileId: "profile-b" },
        now: now + 1,
      }),
    ).toEqual({ kind: "escalate", model: DAYBREAK });
  });
});

describe("window bookkeeping", () => {
  it("keeps an unauthorized target suppressed for every session, through churn", () => {
    const now = 1_000;
    recordCodexCyberEscalation({
      sessionKey: "first-to-learn",
      outcome: "unavailable",
      model: DAYBREAK,
      cooloffMs: 600_000,
      now,
    });
    for (let index = 0; index < 400; index += 1) {
      recordCodexCyberEscalation({
        sessionKey: `filler-${index}`,
        outcome: "suppressed",
        model: DAYBREAK,
        cooloffMs: 600_000,
        now,
      });
    }
    // Authorization is an account-level fact, so a session that never saw the
    // failure still must not pay the reconnect ladder for it.
    expect(
      planCodexCyberEscalation({
        config: config(),
        sessionKey: "never-seen-before",
        currentModel: PRIMARY,
        replaySafe: true,
        now: now + 1,
      }),
    ).toEqual({ kind: "skip", reason: "target_unavailable" });
  });

  it("releases the target once its cooloff expires", () => {
    const now = 1_000;
    recordCodexCyberEscalation({
      sessionKey: "learner",
      outcome: "unavailable",
      model: DAYBREAK,
      cooloffMs: 600_000,
      now,
    });
    expect(
      planCodexCyberEscalation({
        config: config(),
        sessionKey: nextSession(),
        currentModel: PRIMARY,
        replaySafe: true,
        now: now + 600_001,
      }),
    ).toEqual({ kind: "escalate", model: DAYBREAK });
  });

  it("stays hard-bounded even when every live window is suppressed", () => {
    const now = 1_000;
    for (let index = 0; index < 400; index += 1) {
      recordCodexCyberEscalation({
        sessionKey: `hardcap-${index}`,
        outcome: "suppressed",
        model: DAYBREAK,
        cooloffMs: 600_000,
        now,
      });
    }
    // The newest suppression must survive; the map must not grow without bound
    // just because nothing has expired yet.
    expect(
      planCodexCyberEscalation({
        config: config(),
        sessionKey: "hardcap-399",
        currentModel: PRIMARY,
        replaySafe: true,
        now: now + 1,
      }),
    ).toEqual({ kind: "skip", reason: "cooling_off" });
    const survivors = Array.from({ length: 400 }, (_, index) =>
      planCodexCyberEscalation({
        config: config(),
        sessionKey: `hardcap-${index}`,
        currentModel: PRIMARY,
        replaySafe: true,
        now: now + 1,
      }),
    ).filter((plan) => plan.kind === "skip" && plan.reason === "cooling_off").length;
    expect(survivors).toBeLessThanOrEqual(256);
  });

  it("stays bounded when many sessions escalate", () => {
    const now = 1_000;
    for (let index = 0; index < 400; index += 1) {
      recordCodexCyberEscalation({
        sessionKey: `bounded-${index}`,
        outcome: "suppressed",
        model: DAYBREAK,
        cooloffMs: 600_000,
        now,
      });
    }
  });
});
