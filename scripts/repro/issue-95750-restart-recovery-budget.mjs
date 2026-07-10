#!/usr/bin/env node
/**
 * Standalone repro for #95750 cross-boot restart-recovery budget.
 *
 * Drives the budget constants and behavioral contracts for:
 *   - main-session recoverStore (restartRecoveryAttempts fuse + guarded quarantine)
 *   - subagent orphan recovery (canonical subagentRecovery cumulative fuse)
 *
 * Contracts:
 *   - over-budget → quarantine/wedge (abortedLastRun cleared, transcript preserved)
 *   - attempts === MAX → still eligible (negative control)
 *   - success path → budget charge advances once (no double-charge on stale snapshot)
 *   - main quarantine only after ownership/routing/dedupe-capable candidate
 *   - successful main run lifecycle clears budget (documented contract)
 *
 * Run from repo root:
 *   node scripts/repro/issue-95750-restart-recovery-budget.mjs
 *
 * Exit 0 on PASS, non-zero on FAIL.
 */
import assert from "node:assert/strict";

// Main-session fuse (src/agents/main-session-restart-recovery.ts)
const MAX_RECOVERY_RETRIES = 3;
const MAX_RESTART_RECOVERY_ATTEMPTS = MAX_RECOVERY_RETRIES;
const RESTART_RECOVERY_BUDGET_QUARANTINE_REASON = "exceeded_restart_retry_budget";

// Subagent cumulative fuse (src/agents/subagent-recovery-state.ts)
const SUBAGENT_RECOVERY_MAX_CUMULATIVE_ATTEMPTS = 3;
const SUBAGENT_RECOVERY_MAX_AUTOMATIC_ATTEMPTS = 2;
const SUBAGENT_RECOVERY_REWEDGE_WINDOW_MS = 2 * 60_000;

function normalizeRecoveryAttempts(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Pure-logic model of main-session recoverStore budget gate AFTER ownership guards.
 * Mirrors post-P1a control flow without spinning up the gateway.
 */
function evaluateMainCrossBootBudget(params) {
  const { entry, isRoutable = true, hasOwner = false, alreadyResumed = false } = params;
  if (entry.abortedLastRun !== true || entry.status !== "running") {
    return { action: "skip", reason: "not_interrupted" };
  }
  // Ownership / routing / dedupe — budget only after these (review P1a).
  if (!isRoutable) {
    return { action: "skip", reason: "not_routable" };
  }
  if (hasOwner) {
    return { action: "skip", reason: "has_owner" };
  }
  if (alreadyResumed) {
    return { action: "skip", reason: "deduped" };
  }
  const recoveryAttempts = normalizeRecoveryAttempts(entry.restartRecoveryAttempts);
  if (recoveryAttempts > MAX_RESTART_RECOVERY_ATTEMPTS) {
    return {
      action: "quarantine",
      reason: RESTART_RECOVERY_BUDGET_QUARANTINE_REASON,
      attempts: recoveryAttempts,
    };
  }
  return { action: "resume", attempts: recoveryAttempts };
}

/**
 * Revalidate under lock before writing quarantine (prod quarantine helper).
 */
function applyMainQuarantineUnderLock(entry, scanned) {
  if (!entry || entry.status !== "running" || entry.abortedLastRun !== true) {
    return { quarantined: false, entry };
  }
  if (
    scanned.sessionId != null &&
    entry.sessionId != null &&
    entry.sessionId !== scanned.sessionId
  ) {
    return { quarantined: false, entry };
  }
  const liveAttempts = normalizeRecoveryAttempts(entry.restartRecoveryAttempts);
  if (liveAttempts <= MAX_RESTART_RECOVERY_ATTEMPTS) {
    return { quarantined: false, entry };
  }
  return {
    quarantined: true,
    entry: {
      ...entry,
      abortedLastRun: false,
      restartRecoveryQuarantinedAt: new Date().toISOString(),
      restartRecoveryQuarantineReason: RESTART_RECOVERY_BUDGET_QUARANTINE_REASON,
      sessionId: entry.sessionId,
    },
  };
}

/**
 * On accepted main resume: charge budget once when priorAttempts === snapshot.
 */
function chargeMainAcceptedResume(entry, recoveryAttemptsSnapshot) {
  const priorAttempts = normalizeRecoveryAttempts(entry.restartRecoveryAttempts);
  const next = { ...entry, abortedLastRun: false };
  if (entry.restartRecoveryQuarantinedAt == null && priorAttempts === recoveryAttemptsSnapshot) {
    next.restartRecoveryAttempts = priorAttempts + 1;
  }
  return next;
}

function clearBudgetOnSuccess(entry) {
  const next = { ...entry };
  if (normalizeRecoveryAttempts(entry.restartRecoveryAttempts) > 0) {
    delete next.restartRecoveryAttempts;
  }
  if (entry.restartRecoveryQuarantinedAt != null) {
    delete next.restartRecoveryQuarantinedAt;
    delete next.restartRecoveryQuarantineReason;
  }
  return next;
}

/**
 * Pure-logic model of evaluateSubagentRecoveryGate cumulative + rapid fusion.
 */
function evaluateSubagentGate(entry, now) {
  const recovery = entry.subagentRecovery ?? {};
  if (typeof recovery.wedgedAt === "number" && recovery.wedgedAt > 0) {
    return {
      allowed: false,
      reason: recovery.wedgedReason || "wedged",
      shouldMarkWedged: false,
    };
  }
  const cumulative = normalizeRecoveryAttempts(recovery.automaticAttempts);
  if (cumulative > SUBAGENT_RECOVERY_MAX_CUMULATIVE_ATTEMPTS) {
    return {
      allowed: false,
      reason: `subagent orphan recovery blocked after ${cumulative} accepted resume attempts across boots`,
      shouldMarkWedged: true,
    };
  }
  const lastAttemptAt = recovery.lastAttemptAt;
  const recent =
    typeof lastAttemptAt === "number" &&
    Number.isFinite(lastAttemptAt) &&
    now - lastAttemptAt <= SUBAGENT_RECOVERY_REWEDGE_WINDOW_MS;
  const previous = recent ? cumulative : 0;
  if (previous >= SUBAGENT_RECOVERY_MAX_AUTOMATIC_ATTEMPTS) {
    return {
      allowed: false,
      reason: `subagent orphan recovery blocked after ${previous} rapid accepted resume attempts`,
      shouldMarkWedged: true,
    };
  }
  return { allowed: true, nextAttempt: cumulative + 1 };
}

function markSubagentAttempt(entry, attempt, now, runId) {
  const prior = normalizeRecoveryAttempts(entry.subagentRecovery?.automaticAttempts);
  const nextAttempts = Math.max(prior, Math.max(1, attempt));
  return {
    ...entry,
    abortedLastRun: false,
    subagentRecovery: {
      ...entry.subagentRecovery,
      automaticAttempts: nextAttempts,
      lastAttemptAt: now,
      lastRunId: runId,
    },
  };
}

function markSubagentWedged(entry, reason, now) {
  const prior = normalizeRecoveryAttempts(entry.subagentRecovery?.automaticAttempts);
  return {
    ...entry,
    abortedLastRun: false,
    subagentRecovery: {
      ...entry.subagentRecovery,
      automaticAttempts: Math.max(prior, SUBAGENT_RECOVERY_MAX_AUTOMATIC_ATTEMPTS),
      lastAttemptAt: entry.subagentRecovery?.lastAttemptAt ?? now,
      wedgedAt: now,
      wedgedReason: reason,
    },
  };
}

function main() {
  const cases = [];
  const now = Date.now();

  // 1) Main over-budget after guards → quarantine, transcript preserved
  {
    const entry = {
      sessionId: "sess-over",
      status: "running",
      abortedLastRun: true,
      restartRecoveryAttempts: 4,
    };
    const decision = evaluateMainCrossBootBudget({ entry });
    assert.equal(decision.action, "quarantine");
    const { quarantined, entry: out } = applyMainQuarantineUnderLock(entry, {
      sessionId: "sess-over",
    });
    assert.equal(quarantined, true);
    assert.equal(out.abortedLastRun, false);
    assert.equal(out.restartRecoveryQuarantineReason, RESTART_RECOVERY_BUDGET_QUARANTINE_REASON);
    assert.equal(typeof out.restartRecoveryQuarantinedAt, "string");
    assert.equal(out.sessionId, "sess-over");
    cases.push("main over-budget→quarantine (transcript preserved)");
  }

  // 1b) Main over-budget skipped when ownership guard fails (no quarantine attempt)
  {
    const entry = {
      sessionId: "sess-owned",
      status: "running",
      abortedLastRun: true,
      restartRecoveryAttempts: 4,
    };
    const decision = evaluateMainCrossBootBudget({ entry, hasOwner: true });
    assert.equal(decision.action, "skip");
    assert.equal(decision.reason, "has_owner");
    cases.push("main over-budget skipped when process still owns row (P1a guard order)");
  }

  // 1c) Stale snapshot: under-lock row no longer over budget → no-op
  {
    const live = {
      sessionId: "sess-stale",
      status: "running",
      abortedLastRun: true,
      restartRecoveryAttempts: 2,
    };
    const { quarantined } = applyMainQuarantineUnderLock(live, { sessionId: "sess-stale" });
    assert.equal(quarantined, false);
    cases.push("main quarantine revalidate under lock no-ops when no longer over budget");
  }

  // 2) Main attempts=3 boundary — still resumes
  {
    const entry = {
      sessionId: "sess-boundary",
      status: "running",
      abortedLastRun: true,
      restartRecoveryAttempts: 3,
    };
    const decision = evaluateMainCrossBootBudget({ entry });
    assert.equal(decision.action, "resume");
    cases.push("main attempts=3 still resumes (boundary / negative control)");
  }

  // 3) Main success path charges once; stale snapshot does not double-charge
  {
    let entry = {
      sessionId: "sess-charge",
      status: "running",
      abortedLastRun: true,
      restartRecoveryAttempts: 2,
    };
    const snapshot = normalizeRecoveryAttempts(entry.restartRecoveryAttempts);
    entry = chargeMainAcceptedResume(entry, snapshot);
    assert.equal(entry.restartRecoveryAttempts, 3);
    assert.equal(entry.abortedLastRun, false);

    const again = chargeMainAcceptedResume(
      { ...entry, abortedLastRun: true, restartRecoveryAttempts: 3 },
      snapshot,
    );
    assert.equal(again.restartRecoveryAttempts, 3);
    cases.push("main accepted resume charges once; stale snapshot does not double-charge");
  }

  // 4) Main successful lifecycle clears budget
  {
    const entry = {
      sessionId: "sess-done",
      restartRecoveryAttempts: 4,
      restartRecoveryQuarantinedAt: "2026-07-10T00:00:00.000Z",
      restartRecoveryQuarantineReason: RESTART_RECOVERY_BUDGET_QUARANTINE_REASON,
    };
    const cleared = clearBudgetOnSuccess(entry);
    assert.equal(cleared.restartRecoveryAttempts, undefined);
    assert.equal(cleared.restartRecoveryQuarantinedAt, undefined);
    assert.equal(cleared.restartRecoveryQuarantineReason, undefined);
    cases.push("main success→reset budget + quarantine");
  }

  // 5) Subagent attempts=3 dues outside rewedge window still resumes via subagentRecovery
  {
    const entry = {
      sessionId: "sub-boundary",
      abortedLastRun: true,
      subagentRecovery: {
        automaticAttempts: 3,
        lastAttemptAt: now - 10 * 60_000,
      },
    };
    const gate = evaluateSubagentGate(entry, now);
    assert.equal(gate.allowed, true);
    assert.equal(gate.nextAttempt, 4);
    cases.push("subagent cumulative=3 still resumes (canonical fuse boundary)");
  }

  // 6) Subagent over height cumulative → wedge/tombstone, transcript preserved
  {
    const entry = {
      sessionId: "sub-over",
      abortedLastRun: true,
      subagentRecovery: {
        automaticAttempts: 4,
        lastAttemptAt: now - 10 * 60_000,
      },
    };
    const gate = evaluateSubagentGate(entry, now);
    assert.equal(gate.allowed, false);
    assert.equal(gate.shouldMarkWedged, true);
    const wedged = markSubagentWedged(entry, gate.reason, now);
    assert.equal(wedged.abortedLastRun, false);
    assert.equal(typeof wedged.subagentRecovery.wedgedAt, "number");
    assert.equal(wedged.sessionId, "sub-over");
    cases.push("subagent over-budget→wedge (transcript preserved, no parallel restartRecovery*)");
  }

  // 7) Subagent charge once; stale pre-resume snapshot does not double charge
  {
    let entry = {
      sessionId: "sub-charge",
      abortedLastRun: true,
      subagentRecovery: {
        automaticAttempts: 1,
        lastAttemptAt: now - 10 * 60_000,
      },
    };
    const gate = evaluateSubagentGate(entry, now);
    assert.equal(gate.allowed, true);
    const snapshot = normalizeRecoveryAttempts(entry.subagentRecovery.automaticAttempts);
    // Apply charge only when live prior === snapshot
    const livePrior = normalizeRecoveryAttempts(entry.subagentRecovery.automaticAttempts);
    if (livePrior === snapshot) {
      entry = markSubagentAttempt(entry, gate.nextAttempt, now, "run-1");
    }
    assert.equal(entry.subagentRecovery.automaticAttempts, 2);

    // Stale snapshot against already-charged row
    const advanced = {
      ...entry,
      abortedLastRun: true,
      subagentRecovery: { automaticAttempts: 2, lastAttemptAt: now },
    };
    const priorLive = normalizeRecoveryAttempts(advanced.subagentRecovery.automaticAttempts);
    let next = advanced;
    if (priorLive === snapshot) {
      next = markSubagentAttempt(advanced, gate.nextAttempt, now, "run-1b");
    }
    assert.equal(next.subagentRecovery.automaticAttempts, 2);
    cases.push("subagent charge once; stale snapshot does not double-charge");
  }

  console.log("issue-95750-restart-recovery-budget: PASS");
  for (const c of cases) {
    console.log(`  ✓ ${c}`);
  }
  console.log(
    `constants: MAX_RECOVERY_RETRIES=${MAX_RECOVERY_RETRIES} ` +
      `MAX_RESTART_RECOVERY_ATTEMPTS=${MAX_RESTART_RECOVERY_ATTEMPTS} ` +
      `SUBAGENT_RECOVERY_MAX_CUMULATIVE_ATTEMPTS=${SUBAGENT_RECOVERY_MAX_CUMULATIVE_ATTEMPTS}`,
  );
}

try {
  main();
} catch (err) {
  console.error("issue-95750-restart-recovery-budget: FAIL");
  console.error(err);
  process.exit(1);
}
