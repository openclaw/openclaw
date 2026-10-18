import { makeAgentAssistantMessage } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it } from "vitest";
import {
  planCodexCyberEscalation,
  readCodexCyberAttemptVerdict,
  recordCodexCyberTargetUnavailable,
  reserveCodexCyberProbe,
  resolveCodexCyberFailoverConfig,
  type CodexCyberFailoverConfig,
  type CodexCyberAttemptOutcome,
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

function planEscalation(overrides: Partial<Parameters<typeof planCodexCyberEscalation>[0]> = {}) {
  return planCodexCyberEscalation({
    config: config(),
    currentModel: PRIMARY,
    replaySafe: true,
    workspace: nextWorkspace(),
    ...overrides,
  });
}

function outcome(overrides: Partial<CodexCyberAttemptOutcome> = {}): CodexCyberAttemptOutcome {
  return {
    terminal: { kind: "ok" },
    lastAssistant: undefined,
    replayMetadata: { replaySafe: false, hadPotentialSideEffects: false },
    ...overrides,
  };
}

function verdict(overrides: Partial<CodexCyberAttemptOutcome> = {}) {
  return readCodexCyberAttemptVerdict(outcome(overrides));
}

function refusal(category: string, provider = "openai") {
  return outcome({
    currentAttemptAssistant: makeAgentAssistantMessage({
      content: [],
      stopReason: "error",
      diagnostics: [{ type: "provider_refusal", timestamp: 0, details: { provider, category } }],
    }),
    replayMetadata: { replaySafe: true, hadPotentialSideEffects: false },
  });
}

it.each([undefined, { mode: "off", model: "gpt-daybreak-red-latest" }] as const)(
  "resolves operator config %j",
  (overrides) => {
    const input = overrides && { appServer: { cyberFailover: overrides } };
    expect(resolveCodexCyberFailoverConfig(input)).toEqual(config(overrides));
  },
);

it("escalates only OpenAI's own cyber refusal on this attempt", () => {
  expect(readCodexCyberAttemptVerdict(refusal("cyber"))).toMatchObject({
    cyberRefused: true,
    replaySafe: true,
  });
  expect(readCodexCyberAttemptVerdict(refusal("bio")).cyberRefused).toBe(false);
  expect(readCodexCyberAttemptVerdict(refusal("misalignment")).cyberRefused).toBe(false);
  expect(readCodexCyberAttemptVerdict(refusal("cyber", "other")).cyberRefused).toBe(false);
  expect(verdict({ lastAssistant: refusal("cyber").currentAttemptAssistant })).toMatchObject({
    cyberRefused: false,
    replaySafe: false,
  });
  expect(readCodexCyberAttemptVerdict(undefined)).toMatchObject({
    cyberRefused: false,
    replaySafe: false,
  });
});

it("counts only a real reply as answered", () => {
  expect(
    verdict({
      currentAttemptAssistant: makeAgentAssistantMessage({
        content: [{ type: "text", text: "Reply" }],
      }),
    }).answered,
  ).toBe(true);
  expect(
    verdict({ terminal: { kind: "failed", source: "prompt", error: "stream disconnected" } }),
  ).toMatchObject({ answered: false, unavailable: false });
  expect(
    verdict({
      terminal: { kind: "aborted", source: "runtime" },
      currentAttemptAssistant: makeAgentAssistantMessage({ content: [], stopReason: "aborted" }),
    }).answered,
  ).toBe(false);
  expect(readCodexCyberAttemptVerdict(refusal("bio")).answered).toBe(false);
  expect(verdict().answered).toBe(false);
});

it("reads an unauthorized target from the canonical terminal", () => {
  const error = new Error(
    "unexpected status 401 Unauthorized: not authorized to access this model.",
  );
  expect(verdict({ terminal: { kind: "failed", source: "prompt", error } }).unavailable).toBe(true);
});

it.each([
  [{ replaySafe: false }, "not_replay_safe"],
  [{ config: config({ mode: "off" }) }, "disabled"],
] as const)("skips escalation for %j", (params, reason) => {
  expect(planEscalation(params)).toEqual({ kind: "skip", reason });
});

it("does not escalate a turn already running on Daybreak", () => {
  const workspace = nextWorkspace();
  for (const currentModel of [DAYBREAK, `openai/${DAYBREAK}`]) {
    expect(planEscalation({ currentModel, workspace })).toEqual({
      kind: "skip",
      reason: "already_daybreak",
    });
  }
});

it.each(["expiry", "other workspace"] as const)("releases a denial for %s", (release) => {
  const workspace = nextWorkspace();
  const now = 1_000;
  deny(workspace, now);
  expect(planEscalation({ workspace, now: now + 1 })).toEqual({
    kind: "skip",
    reason: "target_unavailable",
  });
  expect(
    planEscalation({
      workspace: release === "expiry" ? workspace : nextWorkspace(),
      now: now + (release === "expiry" ? 600_001 : 1),
    }),
  ).toEqual({ kind: "escalate", model: DAYBREAK });
});

it("stays bounded as workspaces churn", () => {
  const now = 1_000;
  for (let index = 0; index < 400; index += 1) {
    deny({ agentId: `churn-${index}`, authProfileId: "p" }, now);
  }
  const live = Array.from({ length: 400 }, (_, index) =>
    planEscalation({
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
  expect(planEscalation({ workspace })).toEqual({ kind: "skip", reason: "probe_in_flight" });
  release();
  expect(planEscalation({ workspace })).toEqual({ kind: "escalate", model: DAYBREAK });
});

function deny(workspace: ReturnType<typeof nextWorkspace>, now: number) {
  recordCodexCyberTargetUnavailable({ model: DAYBREAK, workspace, cooloffMs: 600_000, now });
}
