/**
 * Daybreak cyber-failover policy: what may escalate, and for how long a
 * workspace that cannot use the target stops trying.
 */
import { describe, expect, it } from "vitest";
import {
  planCodexCyberEscalation,
  readCodexCyberAttemptVerdict,
  recordCodexCyberTargetUnavailable,
  reserveCodexCyberProbe,
  resolveCodexCyberFailoverConfig,
  type CodexCyberFailoverConfig,
} from "./cyber-failover.js";

const DAYBREAK = "gpt-daybreak-blue-latest";
const PRIMARY = "gpt-6-astra";

// The unavailable-target record is process-global and keyed by workspace, so
// each case uses its own workspace instead of a production reset hook.
let workspaceCounter = 0;
function nextWorkspace() {
  workspaceCounter += 1;
  return { agentId: `agent-${workspaceCounter}`, authProfileId: "profile" };
}

function config(overrides: Partial<CodexCyberFailoverConfig> = {}): CodexCyberFailoverConfig {
  return { mode: "auto", model: DAYBREAK, cooloffMs: 600_000, ...overrides };
}

function refusal(category: string, provider = "openai") {
  return {
    currentAttemptAssistant: {
      role: "assistant",
      stopReason: "error",
      diagnostics: [{ type: "provider_refusal", details: { provider, category } }],
    },
    replayMetadata: { replaySafe: true },
  };
}

describe("config", () => {
  it("defaults to automatic Daybreak Blue escalation with a cooloff", () => {
    expect(resolveCodexCyberFailoverConfig(undefined)).toEqual({
      mode: "auto",
      model: DAYBREAK,
      cooloffMs: 600_000,
    });
  });

  it("reads operator overrides from the codex app-server config", () => {
    expect(
      resolveCodexCyberFailoverConfig({
        appServer: { cyberFailover: { mode: "off", model: "gpt-daybreak-red-latest" } },
      }),
    ).toEqual({ mode: "off", model: "gpt-daybreak-red-latest", cooloffMs: 600_000 });
  });
});

describe("attempt verdict", () => {
  it("escalates only OpenAI's own cyber refusal on this attempt", () => {
    expect(readCodexCyberAttemptVerdict(refusal("cyber")).cyberRefused).toBe(true);
    expect(readCodexCyberAttemptVerdict(refusal("bio")).cyberRefused).toBe(false);
    expect(readCodexCyberAttemptVerdict(refusal("misalignment")).cyberRefused).toBe(false);
    // Another provider's cyber refusal must not reroute a prompt to OpenAI's tier.
    expect(readCodexCyberAttemptVerdict(refusal("cyber", "other")).cyberRefused).toBe(false);
    // A previous turn's row must not escalate an attempt that produced none.
    expect(
      readCodexCyberAttemptVerdict({
        lastAssistant: {
          role: "assistant",
          diagnostics: [
            { type: "provider_refusal", details: { provider: "openai", category: "cyber" } },
          ],
        },
      }).cyberRefused,
    ).toBe(false);
    expect(readCodexCyberAttemptVerdict(undefined).cyberRefused).toBe(false);
  });

  it("treats a missing replay verdict as unsafe", () => {
    expect(readCodexCyberAttemptVerdict({ replayMetadata: { replaySafe: true } }).replaySafe).toBe(
      true,
    );
    expect(readCodexCyberAttemptVerdict({ replayMetadata: { replaySafe: false } }).replaySafe).toBe(
      false,
    );
    expect(readCodexCyberAttemptVerdict({}).replaySafe).toBe(false);
  });

  it("counts only a real reply as answered", () => {
    expect(
      readCodexCyberAttemptVerdict({
        currentAttemptAssistant: { role: "assistant", stopReason: "stop" },
      }).answered,
    ).toBe(true);
    // A transport failure is not a reply, even carrying no refusal.
    expect(readCodexCyberAttemptVerdict({ promptError: "stream disconnected" }).answered).toBe(
      false,
    );
    expect(
      readCodexCyberAttemptVerdict({
        currentAttemptAssistant: { role: "assistant", stopReason: "aborted" },
      }).answered,
    ).toBe(false);
    // A bio or misalignment refusal is still a refusal, never an answer.
    expect(readCodexCyberAttemptVerdict(refusal("bio")).answered).toBe(false);
    expect(readCodexCyberAttemptVerdict({}).answered).toBe(false);
  });

  it("reads an unauthorized target from the attempt outcome", () => {
    expect(
      readCodexCyberAttemptVerdict({
        currentAttemptAssistant: {
          role: "assistant",
          errorMessage: "unexpected status 401 Unauthorized: not authorized to access this model.",
        },
      }).unavailable,
    ).toBe(true);
    expect(
      readCodexCyberAttemptVerdict({
        promptError: "unexpected status 403 Forbidden: Cyber access program is not authorized",
      }).unavailable,
    ).toBe(true);
    expect(readCodexCyberAttemptVerdict({ promptError: "stream disconnected" }).unavailable).toBe(
      false,
    );
  });
});

describe("escalation planning", () => {
  it("escalates a refused turn to the configured Daybreak model", () => {
    expect(
      planCodexCyberEscalation({
        config: config(),
        currentModel: PRIMARY,
        replaySafe: true,
        workspace: nextWorkspace(),
      }),
    ).toEqual({ kind: "escalate", model: DAYBREAK });
  });

  it("refuses to replay a turn that already acted", () => {
    expect(
      planCodexCyberEscalation({
        config: config(),
        currentModel: PRIMARY,
        replaySafe: false,
        workspace: nextWorkspace(),
      }),
    ).toEqual({ kind: "skip", reason: "not_replay_safe" });
  });

  it("does not escalate when the operator disabled it", () => {
    expect(
      planCodexCyberEscalation({
        config: config({ mode: "off" }),
        currentModel: PRIMARY,
        replaySafe: true,
        workspace: nextWorkspace(),
      }),
    ).toEqual({ kind: "skip", reason: "disabled" });
  });

  it("does not escalate a turn already running on Daybreak", () => {
    const workspace = nextWorkspace();
    for (const currentModel of [DAYBREAK, `openai/${DAYBREAK}`]) {
      expect(
        planCodexCyberEscalation({ config: config(), currentModel, replaySafe: true, workspace }),
      ).toEqual({ kind: "skip", reason: "already_daybreak" });
    }
  });
});

describe("unauthorized targets", () => {
  it("stops every session in the workspace, then releases on expiry", () => {
    const workspace = nextWorkspace();
    const now = 1_000;
    recordCodexCyberTargetUnavailable({
      model: DAYBREAK,
      workspace,
      cooloffMs: 600_000,
      now,
    });
    // A session that never saw the failure still must not pay for it.
    expect(
      planCodexCyberEscalation({
        config: config(),
        currentModel: PRIMARY,
        replaySafe: true,
        workspace,
        now: now + 1,
      }),
    ).toEqual({ kind: "skip", reason: "target_unavailable" });
    expect(
      planCodexCyberEscalation({
        config: config(),
        currentModel: PRIMARY,
        replaySafe: true,
        workspace,
        now: now + 600_001,
      }),
    ).toEqual({ kind: "escalate", model: DAYBREAK });
  });

  it("keeps one workspace's denial out of another's way", () => {
    const denied = nextWorkspace();
    const entitled = nextWorkspace();
    const now = 1_000;
    recordCodexCyberTargetUnavailable({
      model: DAYBREAK,
      workspace: denied,
      cooloffMs: 600_000,
      now,
    });
    expect(
      planCodexCyberEscalation({
        config: config(),
        currentModel: PRIMARY,
        replaySafe: true,
        workspace: entitled,
        now: now + 1,
      }),
    ).toEqual({ kind: "escalate", model: DAYBREAK });
  });

  it("stays bounded as workspaces churn", () => {
    const now = 1_000;
    for (let index = 0; index < 400; index += 1) {
      recordCodexCyberTargetUnavailable({
        model: DAYBREAK,
        workspace: { agentId: `churn-${index}`, authProfileId: "p" },
        cooloffMs: 600_000,
        now,
      });
    }
    const live = Array.from({ length: 400 }, (_, index) =>
      planCodexCyberEscalation({
        config: config(),
        currentModel: PRIMARY,
        replaySafe: true,
        workspace: { agentId: `churn-${index}`, authProfileId: "p" },
        now: now + 1,
      }),
    ).filter((plan) => plan.kind === "skip").length;
    expect(live).toBeGreaterThan(0);
    expect(live).toBeLessThanOrEqual(256);
  });

  it("holds siblings while one probe is in flight", () => {
    const workspace = nextWorkspace();
    const release = reserveCodexCyberProbe({ model: DAYBREAK, workspace });
    expect(
      planCodexCyberEscalation({
        config: config(),
        currentModel: PRIMARY,
        replaySafe: true,
        workspace,
      }),
    ).toEqual({ kind: "skip", reason: "probe_in_flight" });
    release();
    expect(
      planCodexCyberEscalation({
        config: config(),
        currentModel: PRIMARY,
        replaySafe: true,
        workspace,
      }),
    ).toEqual({ kind: "escalate", model: DAYBREAK });
  });
});
