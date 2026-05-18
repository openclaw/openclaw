// Agent OS WS13 — L1 proof: deterministic simulated scenarios A-G.
//
// Each scenario builds a fresh engine, drives metadata-only simulated hook
// envelopes (deliberately including content-bearing keys so redaction can be
// proven to drop them), then ASSERTS the required outcome. The functions are
// self-checking: a wrong/silent outcome yields scenario status "fail". This
// file is the L1 proof harness. Per the handoff command boundary it is NOT
// executed here; running it requires separate approval.

import { Ws13HookEngine } from "./hook-handlers.js";
import { runSelfCheck } from "./health.js";
import { Ws13ObligationStore } from "./obligation-store.js";
import { hasNoContentBearingEvidence } from "./privacy.js";
import {
  WS13_REQUIRED_HOOKS,
  type Ws13HookEnvelope,
  type Ws13ProofResult,
  type Ws13ScenarioLabel,
  type Ws13ScenarioResult,
  type Ws13TransitionEvidence,
} from "./types.js";

const WINDOW_MS = 5 * 60 * 1000;

// Content-bearing keys injected into fixtures purely to prove redaction. They
// must never appear in any recorded evidence.
const POISON = {
  content: "PROHIBITED_REPLY_BODY_TEXT",
  label: "PROHIBITED_HUMAN_TASK_LABEL",
  ctx: { transcript: "PROHIBITED_TRANSCRIPT" },
};

function transitionsFor(
  engine: Ws13HookEngine,
  scenario: Ws13ScenarioLabel,
): Ws13TransitionEvidence[] {
  return engine.store
    .transitionEvidence()
    .filter((t) => t.scenario === scenario);
}

function onlyObligationId(engine: Ws13HookEngine): string | undefined {
  const all = engine.store.allObligations();
  return all.length > 0 ? all[0]?.obligationId : undefined;
}

function env(
  scenario: Ws13ScenarioLabel,
  hookName: Ws13HookEnvelope["hookName"],
  payload: Record<string, unknown>,
): Ws13HookEnvelope {
  return {
    scenario,
    hookName,
    // Deterministic; engine timing uses its own simulated clock, not this.
    timestamp: "2026-05-17T00:00:00.000Z",
    payload,
  };
}

// ---------------------------------------------------------------------------
// Scenario A — native subagent one-shot, expected completion message
// ---------------------------------------------------------------------------
export function scenarioA(): Ws13ScenarioResult {
  const engine = new Ws13HookEngine({ windowMs: WINDOW_MS });
  const origin = { channel: "slack", accountId: "acct-1", to: "C123" };
  const notes: string[] = [];

  engine.onSubagentSpawning(
    env("A", "subagent_spawning", {
      childSessionKey: "child-A",
      agentId: "agent-x",
      mode: "run",
      requester: origin,
      threadRequested: false,
      ...POISON,
    }),
  );
  engine.onSubagentDeliveryTarget(
    env("A", "subagent_delivery_target", {
      childSessionKey: "child-A",
      requesterSessionKey: "req-A",
      requesterOrigin: origin,
      childRunId: "run-A",
      spawnMode: "run",
      expectsCompletionMessage: true,
    }),
  );
  engine.onSubagentSpawned(
    env("A", "subagent_spawned", {
      childSessionKey: "child-A",
      agentId: "agent-x",
      mode: "run",
      requester: origin,
      threadRequested: false,
      runId: "run-A",
    }),
  );
  engine.onSubagentEnded(
    env("A", "subagent_ended", {
      targetSessionKey: "child-A",
      targetKind: "subagent",
      reason: "completed",
      runId: "run-A",
      endedAt: engine.clock.nowMs(),
      outcome: "ok",
    }),
  );
  engine.onReplyDispatch(
    env("A", "reply_dispatch", {
      sessionKey: "req-A",
      runId: "run-parent-A",
      originatingChannel: "slack",
      originatingTo: "C123",
      sendPolicy: "allow",
      suppressUserDelivery: false,
      shouldRouteToOriginating: true,
      isTailDispatch: false,
      ...POISON,
    }),
  );
  engine.onMessageSending(
    env("A", "message_sending", {
      channel: "slack",
      accountId: "acct-1",
      to: "C123",
      ...POISON,
    }),
  );
  engine.onMessageSent(
    env("A", "message_sent", {
      channelId: "slack",
      accountId: "acct-1",
      to: "C123",
      success: true,
      messageId: "m-A",
      ...POISON,
    }),
  );

  const id = onlyObligationId(engine);
  const fin = id ? engine.evaluateClosure(id, "A") : undefined;

  const ok =
    fin?.status === "satisfied" &&
    (fin?.correlationStrength === "strong" ||
      fin?.correlationStrength === "exact") &&
    fin?.slackDeliveryClass === "mainline_proven";
  notes.push(
    ok
      ? "obligation satisfied via strong correlation + mainline_proven delivery"
      : `unexpected final status=${fin?.status} strength=${fin?.correlationStrength} slack=${fin?.slackDeliveryClass}`,
  );

  return {
    scenario: "A",
    status: ok ? "pass" : "fail",
    obligationId: id,
    correlationStrength: fin?.correlationStrength ?? "none",
    health: fin?.health ?? "unsupported_or_unhealthy",
    finalObligationStatus: fin?.status,
    slackDeliveryClass: fin?.slackDeliveryClass,
    alertCapability: fin?.alertCapability,
    statusTransitions: transitionsFor(engine, "A"),
    notes,
  };
}

// ---------------------------------------------------------------------------
// Scenario B — native subagent completes but no parent closure delivered
// ---------------------------------------------------------------------------
export function scenarioB(): Ws13ScenarioResult {
  const engine = new Ws13HookEngine({ windowMs: WINDOW_MS });
  const origin = { channel: "slack", accountId: "acct-1", to: "C200" };
  const notes: string[] = [];

  engine.onSubagentSpawning(
    env("B", "subagent_spawning", {
      childSessionKey: "child-B",
      agentId: "agent-x",
      mode: "run",
      requester: origin,
      threadRequested: false,
    }),
  );
  engine.onSubagentDeliveryTarget(
    env("B", "subagent_delivery_target", {
      childSessionKey: "child-B",
      requesterSessionKey: "req-B",
      requesterOrigin: origin,
      childRunId: "run-B",
      spawnMode: "run",
      expectsCompletionMessage: true,
    }),
  );
  engine.onSubagentSpawned(
    env("B", "subagent_spawned", {
      childSessionKey: "child-B",
      agentId: "agent-x",
      mode: "run",
      requester: origin,
      threadRequested: false,
      runId: "run-B",
    }),
  );
  engine.onSubagentEnded(
    env("B", "subagent_ended", {
      targetSessionKey: "child-B",
      targetKind: "subagent",
      reason: "completed",
      runId: "run-B",
      endedAt: engine.clock.nowMs(),
      outcome: "ok",
    }),
  );
  // No reply_dispatch, no message_sending, no message_sent: orphaned closure.
  engine.clock.advance(WINDOW_MS + 1000);

  const id = onlyObligationId(engine);
  const fin = id ? engine.evaluateClosure(id, "B") : undefined;

  // Equality to missing_closure_alert_required already excludes "satisfied".
  const ok = fin?.status === "missing_closure_alert_required";
  notes.push(
    ok
      ? "missing closure detected after bounded window; no silent success"
      : `unexpected final status=${fin?.status}`,
  );

  return {
    scenario: "B",
    status: ok ? "pass" : "fail",
    obligationId: id,
    correlationStrength: fin?.correlationStrength ?? "none",
    health: fin?.health ?? "unsupported_or_unhealthy",
    finalObligationStatus: fin?.status,
    alertCapability: fin?.alertCapability,
    statusTransitions: transitionsFor(engine, "B"),
    notes,
  };
}

// ---------------------------------------------------------------------------
// Scenario C — ACP / session-spawn non-inline delegated run (tracked)
// ---------------------------------------------------------------------------
export function scenarioC(): Ws13ScenarioResult {
  const engine = new Ws13HookEngine({ windowMs: WINDOW_MS });
  const origin = { channel: "slack", accountId: "acct-1", to: "C777" };
  const notes: string[] = [];

  engine.onSubagentSpawning(
    env("C", "subagent_spawning", {
      childSessionKey: "child-C",
      agentId: "agent-acp",
      mode: "run",
      requester: origin,
      threadRequested: false,
    }),
  );
  engine.onSubagentDeliveryTarget(
    env("C", "subagent_delivery_target", {
      childSessionKey: "child-C",
      requesterSessionKey: "req-C",
      requesterOrigin: origin,
      childRunId: "run-C",
      spawnMode: "run",
      expectsCompletionMessage: true,
    }),
  );
  engine.onSubagentSpawned(
    env("C", "subagent_spawned", {
      childSessionKey: "child-C",
      agentId: "agent-acp",
      mode: "run",
      requester: origin,
      threadRequested: false,
      runId: "run-C",
    }),
  );
  engine.onSubagentEnded(
    env("C", "subagent_ended", {
      targetSessionKey: "child-C",
      targetKind: "acp",
      reason: "completed",
      runId: "run-C",
      endedAt: engine.clock.nowMs(),
      outcome: "ok",
    }),
  );
  engine.onReplyDispatch(
    env("C", "reply_dispatch", {
      sessionKey: "req-C",
      runId: "run-parent-C",
      originatingChannel: "slack",
      originatingTo: "C777",
      sendPolicy: "allow",
      suppressUserDelivery: false,
      shouldRouteToOriginating: true,
    }),
  );
  engine.onMessageSending(
    env("C", "message_sending", {
      channel: "slack",
      accountId: "acct-1",
      to: "C777",
    }),
  );
  engine.onMessageSent(
    env("C", "message_sent", {
      channelId: "slack",
      accountId: "acct-1",
      to: "C777",
      success: true,
      messageId: "m-C",
    }),
  );

  const id = onlyObligationId(engine);
  const fin = id ? engine.evaluateClosure(id, "C") : undefined;

  // Required: tracked + correlated, OR explicitly unsupported/unhealthy.
  // No silent pass.
  const tracked =
    fin?.status === "satisfied" &&
    (fin?.correlationStrength === "strong" ||
      fin?.correlationStrength === "exact");
  const explicitlyUnsupported = fin?.status === "unsupported_or_unhealthy";
  const ok = tracked || explicitlyUnsupported;
  notes.push(
    tracked
      ? "non-inline ACP run tracked and satisfied via strong correlation"
      : explicitlyUnsupported
        ? "ACP path explicitly classified unsupported_or_unhealthy"
        : `silent/unexpected ACP status=${fin?.status}`,
  );

  return {
    scenario: "C",
    status: ok ? (tracked ? "pass" : "unsupported") : "fail",
    obligationId: id,
    correlationStrength: fin?.correlationStrength ?? "none",
    health: fin?.health ?? "unsupported_or_unhealthy",
    finalObligationStatus: fin?.status,
    slackDeliveryClass: fin?.slackDeliveryClass,
    alertCapability: fin?.alertCapability,
    statusTransitions: transitionsFor(engine, "C"),
    notes,
  };
}

// ---------------------------------------------------------------------------
// Scenario D — inline delivery / stream-to-parent path
// ---------------------------------------------------------------------------
export function scenarioD(): Ws13ScenarioResult {
  const engine = new Ws13HookEngine({ windowMs: WINDOW_MS });
  const origin = { channel: "slack", accountId: "acct-1", to: "C888" };
  const notes: string[] = [];

  engine.onSubagentSpawning(
    env("D", "subagent_spawning", {
      childSessionKey: "child-D",
      agentId: "agent-inline",
      mode: "run",
      requester: origin,
      threadRequested: false,
    }),
  );
  engine.onSubagentDeliveryTarget(
    env("D", "subagent_delivery_target", {
      childSessionKey: "child-D",
      requesterSessionKey: "req-D",
      requesterOrigin: origin,
      childRunId: "run-D",
      spawnMode: "run",
      expectsCompletionMessage: false,
    }),
  );
  engine.onSubagentEnded(
    env("D", "subagent_ended", {
      targetSessionKey: "child-D",
      targetKind: "subagent",
      reason: "completed",
      runId: "run-D",
      endedAt: engine.clock.nowMs(),
      outcome: "ok",
    }),
  );
  engine.clock.advance(WINDOW_MS + 1000);

  const id = onlyObligationId(engine);
  const fin = id ? engine.evaluateClosure(id, "D") : undefined;

  // no_obligation_inline is mutually exclusive with the alert/satisfied states.
  const ok = fin?.status === "no_obligation_inline";
  notes.push(
    ok
      ? "inline path classified no_obligation_inline; no false missing-closure alert"
      : `unexpected inline status=${fin?.status}`,
  );

  return {
    scenario: "D",
    status: ok ? "pass" : "fail",
    obligationId: id,
    correlationStrength: fin?.correlationStrength ?? "none",
    health: fin?.health ?? "unsupported_or_unhealthy",
    finalObligationStatus: fin?.status,
    statusTransitions: transitionsFor(engine, "D"),
    notes,
  };
}

// ---------------------------------------------------------------------------
// Scenario E — persistent session mode (subagent_ended suppressed)
// ---------------------------------------------------------------------------
export function scenarioE(): Ws13ScenarioResult {
  const engine = new Ws13HookEngine({ windowMs: WINDOW_MS });
  const origin = { channel: "slack", accountId: "acct-1", to: "C999" };
  const notes: string[] = [];

  engine.onSubagentSpawning(
    env("E", "subagent_spawning", {
      childSessionKey: "child-E",
      agentId: "agent-persistent",
      mode: "session",
      requester: origin,
      threadRequested: false,
    }),
  );
  engine.onSubagentDeliveryTarget(
    env("E", "subagent_delivery_target", {
      childSessionKey: "child-E",
      requesterSessionKey: "req-E",
      requesterOrigin: origin,
      childRunId: "run-E",
      spawnMode: "session",
      expectsCompletionMessage: true,
    }),
  );
  // Persistent session: subagent_ended is suppressed on normal completion.
  engine.clock.advance(WINDOW_MS + 1000);

  const id = onlyObligationId(engine);
  const fin = id ? engine.evaluateClosure(id, "E") : undefined;

  const ok =
    fin?.status === "unsupported_or_unhealthy" &&
    fin?.health === "unsupported_or_unhealthy";
  notes.push(
    ok
      ? "persistent session with suppressed subagent_ended → unsupported_or_unhealthy (not silently passed)"
      : `unexpected persistent-session status=${fin?.status} health=${fin?.health}`,
  );

  return {
    scenario: "E",
    status: ok ? "unsupported" : "fail",
    obligationId: id,
    correlationStrength: fin?.correlationStrength ?? "none",
    health: fin?.health ?? "unsupported_or_unhealthy",
    finalObligationStatus: fin?.status,
    statusTransitions: transitionsFor(engine, "E"),
    notes,
  };
}

// ---------------------------------------------------------------------------
// Scenario F — Slack mainline closure (strict, four sub-cases)
// ---------------------------------------------------------------------------
function runSlackCase(opts: {
  to: string;
  threadRequested: boolean;
  emitMessageSending: boolean;
  sendingThreadId?: string;
}): ReturnType<Ws13HookEngine["evaluateClosure"]> {
  const engine = new Ws13HookEngine({ windowMs: WINDOW_MS });
  const origin = { channel: "slack", accountId: "acct-1", to: opts.to };

  engine.onSubagentSpawning(
    env("F", "subagent_spawning", {
      childSessionKey: `child-F-${opts.to}`,
      agentId: "agent-x",
      mode: "run",
      requester: origin,
      threadRequested: opts.threadRequested,
    }),
  );
  engine.onSubagentDeliveryTarget(
    env("F", "subagent_delivery_target", {
      childSessionKey: `child-F-${opts.to}`,
      requesterSessionKey: `req-F-${opts.to}`,
      requesterOrigin: origin,
      childRunId: `run-F-${opts.to}`,
      spawnMode: "run",
      expectsCompletionMessage: true,
    }),
  );
  engine.onSubagentSpawned(
    env("F", "subagent_spawned", {
      childSessionKey: `child-F-${opts.to}`,
      agentId: "agent-x",
      mode: "run",
      requester: origin,
      threadRequested: opts.threadRequested,
      runId: `run-F-${opts.to}`,
    }),
  );
  engine.onSubagentEnded(
    env("F", "subagent_ended", {
      targetSessionKey: `child-F-${opts.to}`,
      targetKind: "subagent",
      reason: "completed",
      runId: `run-F-${opts.to}`,
      endedAt: engine.clock.nowMs(),
      outcome: "ok",
    }),
  );
  engine.onReplyDispatch(
    env("F", "reply_dispatch", {
      sessionKey: `req-F-${opts.to}`,
      runId: `run-parent-F-${opts.to}`,
      originatingChannel: "slack",
      originatingTo: opts.to,
      sendPolicy: "allow",
      suppressUserDelivery: false,
      shouldRouteToOriginating: true,
    }),
  );
  if (opts.emitMessageSending) {
    engine.onMessageSending(
      env("F", "message_sending", {
        channel: "slack",
        accountId: "acct-1",
        to: opts.to,
        ...(opts.sendingThreadId ? { threadId: opts.sendingThreadId } : {}),
      }),
    );
  }
  engine.onMessageSent(
    env("F", "message_sent", {
      channelId: "slack",
      accountId: "acct-1",
      to: opts.to,
      success: true,
      messageId: `m-F-${opts.to}`,
      ...(opts.sendingThreadId ? { threadId: opts.sendingThreadId } : {}),
    }),
  );
  engine.clock.advance(WINDOW_MS + 1000);
  const all = engine.store.allObligations();
  return all[0]
    ? engine.evaluateClosure(all[0].obligationId, "F")
    : undefined;
}

export function scenarioF(): Ws13ScenarioResult {
  const notes: string[] = [];

  const mainline = runSlackCase({
    to: "F-MAIN",
    threadRequested: false,
    emitMessageSending: true,
  });
  const indeterminate = runSlackCase({
    to: "F-IND",
    threadRequested: false,
    emitMessageSending: false,
  });
  const threadUnexpected = runSlackCase({
    to: "F-THRX",
    threadRequested: false,
    emitMessageSending: true,
    sendingThreadId: "T-UNEXPECTED",
  });
  const threadRequested = runSlackCase({
    to: "F-THRR",
    threadRequested: true,
    emitMessageSending: true,
    sendingThreadId: "T-REQUESTED",
  });

  const c1 =
    mainline?.status === "satisfied" &&
    mainline?.slackDeliveryClass === "mainline_proven";
  const c2 =
    indeterminate?.status !== "satisfied" &&
    indeterminate?.slackDeliveryClass === "indeterminate";
  const c3 =
    threadUnexpected?.status !== "satisfied" &&
    threadUnexpected?.slackDeliveryClass === "thread_unexpected";
  const c4 =
    threadRequested?.status === "satisfied" &&
    threadRequested?.slackDeliveryClass === "thread_explicitly_requested";

  notes.push(
    `mainline_proven→satisfied=${c1}`,
    `message_sent-only→indeterminate,not satisfied=${c2}`,
    `unrequested thread→thread_unexpected,not satisfied=${c3}`,
    `requested thread→thread_explicitly_requested,satisfied=${c4}`,
  );

  const ok = c1 && c2 && c3 && c4;
  return {
    scenario: "F",
    status: ok ? "pass" : "fail",
    correlationStrength: mainline?.correlationStrength ?? "none",
    health: ok ? "healthy_simulated" : "unsupported_or_unhealthy",
    finalObligationStatus: mainline?.status,
    slackDeliveryClass: mainline?.slackDeliveryClass,
    statusTransitions: [],
    notes,
  };
}

// ---------------------------------------------------------------------------
// Scenario G — hook unavailable / plugin inactive / store unavailable
// ---------------------------------------------------------------------------
export function scenarioG(): Ws13ScenarioResult {
  const notes: string[] = [];
  const all = [...WS13_REQUIRED_HOOKS];

  const missing = runSelfCheck({
    pluginActive: true,
    storeAvailable: true,
    availableHooks: ["subagent_spawning"],
  });
  const storeDown = runSelfCheck({
    pluginActive: true,
    storeAvailable: false,
    availableHooks: all,
  });
  const inactive = runSelfCheck({
    pluginActive: false,
    storeAvailable: true,
    availableHooks: all,
  });
  const healthy = runSelfCheck({
    pluginActive: true,
    storeAvailable: true,
    availableHooks: all,
  });

  // Runtime store-unavailable: a hook on an unavailable store must produce a
  // loud, recorded unhealthy transition — never a silent created obligation.
  const engineG = new Ws13HookEngine({
    store: new Ws13ObligationStore({ available: false }),
  });
  engineG.onSubagentSpawning(
    env("G", "subagent_spawning", {
      childSessionKey: "child-G",
      agentId: "agent-x",
      mode: "run",
      requester: { channel: "slack", accountId: "acct-1", to: "CG" },
      threadRequested: false,
    }),
  );
  const gEvidence = engineG.store
    .transitionEvidence()
    .some(
      (t) =>
        t.health === "unhealthy_store_unavailable" &&
        t.errorCategoryOnly === "store_unavailable",
    );

  const c1 =
    missing.health === "unhealthy_required_hook_missing" &&
    missing.missingHooks.length > 0 &&
    !missing.enforcementActive;
  const c2 =
    storeDown.health === "unhealthy_store_unavailable" &&
    !storeDown.enforcementActive;
  const c3 =
    inactive.health === "unhealthy_plugin_inactive" &&
    !inactive.enforcementActive;
  const c4 =
    healthy.health === "healthy_simulated" && healthy.enforcementActive;

  notes.push(
    `missing required hooks→unhealthy_required_hook_missing,enforcement off=${c1}`,
    `store unavailable→unhealthy_store_unavailable,enforcement off=${c2}`,
    `plugin inactive→unhealthy_plugin_inactive,enforcement off=${c3}`,
    `all present→healthy_simulated,enforcement on=${c4}`,
    `runtime store-unavailable produced loud unhealthy transition=${gEvidence}`,
  );

  const ok = c1 && c2 && c3 && c4 && gEvidence;
  return {
    scenario: "G",
    status: ok ? "pass" : "fail",
    correlationStrength: "none",
    health: "unhealthy_required_hook_missing",
    statusTransitions: engineG.store
      .transitionEvidence()
      .filter((t) => t.scenario === "G"),
    notes,
  };
}

// ---------------------------------------------------------------------------
// Aggregate runner
// ---------------------------------------------------------------------------
export function runWs13Scenarios(): Ws13ProofResult {
  const results: Ws13ScenarioResult[] = [
    scenarioA(),
    scenarioB(),
    scenarioC(),
    scenarioD(),
    scenarioE(),
    scenarioF(),
    scenarioG(),
  ];

  // "fail" is the only disqualifying status. "unsupported" is an accepted
  // non-silent classification (handoff acceptance criteria).
  const anyFail = results.some((r) => r.status === "fail");
  const anyInconclusive = results.some((r) => r.status === "inconclusive");
  const overallStatus = anyFail
    ? "fail"
    : anyInconclusive
      ? "inconclusive"
      : "pass";

  const proof: Ws13ProofResult = {
    generatedAt: new Date().toISOString(),
    executionMode: "simulated_metadata_only",
    privacyMode: "metadata_only_content_dropped",
    closureWindow: { verificationWindowMs: WINDOW_MS },
    requiredHooks: WS13_REQUIRED_HOOKS,
    results,
    overallStatus,
  };

  // Defensive privacy invariant: nothing content-bearing in the proof object.
  if (!hasNoContentBearingEvidence(proof)) {
    throw new Error("ws13_privacy_violation_content_in_evidence");
  }
  return proof;
}
