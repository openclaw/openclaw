import { makeAgentAssistantMessage } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, expect, it, vi } from "vitest";
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
afterEach(() => vi.restoreAllMocks());

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

function expectVerdict(
  attempt: CodexCyberAttemptOutcome | undefined,
  expected: Partial<ReturnType<typeof readCodexCyberAttemptVerdict>>,
) {
  expect(readCodexCyberAttemptVerdict(attempt)).toMatchObject(expected);
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
  expectVerdict(refusal("cyber"), { cyberRefused: true, replaySafe: true });
  for (const attempt of [refusal("bio"), refusal("misalignment"), refusal("cyber", "other")]) {
    expectVerdict(attempt, { cyberRefused: false });
  }
  const previousRefusal = outcome({ lastAssistant: refusal("cyber").currentAttemptAssistant });
  for (const attempt of [previousRefusal, undefined]) {
    expectVerdict(attempt, { cyberRefused: false, replaySafe: false });
  }
});

it("counts only a real reply as answered", () => {
  const reply = makeAgentAssistantMessage({ content: [{ type: "text", text: "Reply" }] });
  const aborted = makeAgentAssistantMessage({ content: [], stopReason: "aborted" });
  expectVerdict(outcome({ currentAttemptAssistant: reply }), { answered: true });
  expectVerdict(
    outcome({ terminal: { kind: "failed", source: "prompt", error: "stream disconnected" } }),
    { answered: false, unavailable: false },
  );
  expectVerdict(
    outcome({ terminal: { kind: "aborted", source: "runtime" }, currentAttemptAssistant: aborted }),
    { answered: false },
  );
  expectVerdict(refusal("bio"), { answered: false });
  expectVerdict(outcome(), { answered: false });
});

it("reads an unauthorized target from the canonical terminal", () => {
  const error = new Error(
    "unexpected status 401 Unauthorized: not authorized to access this model.",
  );
  expectVerdict(outcome({ terminal: { kind: "failed", source: "prompt", error } }), {
    unavailable: true,
  });
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
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
  deny(workspace);
  clock.mockReturnValue(1_001);
  expect(planEscalation({ workspace })).toEqual({
    kind: "skip",
    reason: "target_unavailable",
  });
  clock.mockReturnValue(release === "expiry" ? 601_001 : 1_001);
  expect(
    planEscalation({
      workspace: release === "expiry" ? workspace : nextWorkspace(),
    }),
  ).toEqual({ kind: "escalate", model: DAYBREAK });
});

it("stays bounded as workspaces churn", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
  for (let index = 0; index < 400; index += 1) {
    deny({ agentId: `churn-${index}`, authProfileId: "p" });
  }
  clock.mockReturnValue(1_001);
  const live = Array.from({ length: 400 }, (_, index) =>
    planEscalation({
      workspace: { agentId: `churn-${index}`, authProfileId: "p" },
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

function deny(workspace: ReturnType<typeof nextWorkspace>) {
  recordCodexCyberTargetUnavailable({ model: DAYBREAK, workspace, cooloffMs: 600_000 });
}
