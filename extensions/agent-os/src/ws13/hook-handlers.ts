// Agent OS WS13 — L1 proof: metadata-only simulated hook handlers.
//
// Each handler accepts a simulated hook envelope whose payload structurally
// mirrors the real OpenClaw plugin event but carries metadata only. Payloads
// are re-redacted on ingest (defense in depth). The engine never sends a live
// message, never activates runtime, and never marks an obligation "satisfied"
// on child completion alone — closure requires correlated, delivered, non-
// suppressed, mainline-correct visible closure inside the bounded window.

import { correlate } from "./correlation.js";
import { classifyAlertCapability } from "./health.js";
import {
  Ws13Clock,
  Ws13ObligationStore,
  Ws13StoreUnavailableError,
} from "./obligation-store.js";
import {
  deliveryObservationFromPayload,
  dispatchObservationFromPayload,
  messageSendingObservationFromPayload,
  originFromPayload,
  redactEnvelope,
} from "./privacy.js";
import type {
  Ws13ClosureWindowConfig,
  Ws13HookEnvelope,
  Ws13ObligationRecord,
  Ws13ObligationStatus,
  Ws13TransitionEvidence,
} from "./types.js";

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;

function isoFromMaybeEpoch(
  value: unknown,
  fallbackIso: string,
): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return fallbackIso;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export class Ws13HookEngine {
  readonly store: Ws13ObligationStore;
  readonly clock: Ws13Clock;
  readonly windowMs: number;

  constructor(opts?: {
    store?: Ws13ObligationStore;
    clock?: Ws13Clock;
    windowMs?: number;
  }) {
    this.store = opts?.store ?? new Ws13ObligationStore();
    this.clock = opts?.clock ?? new Ws13Clock();
    this.windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
  }

  closureWindowConfig(): Ws13ClosureWindowConfig {
    return { verificationWindowMs: this.windowMs };
  }

  private evidence(
    partial: Omit<Ws13TransitionEvidence, "evidenceId" | "timestamp">,
  ): void {
    this.store.recordEvidence({
      evidenceId: this.safeNextId("evi"),
      timestamp: this.clock.nowIso(),
      ...partial,
    });
  }

  private safeNextId(prefix: string): string {
    try {
      return this.store.nextId(prefix);
    } catch {
      // Store unavailable: still produce a deterministic, opaque id so the
      // store-unavailable transition can itself be recorded.
      return `${prefix}-unavailable`;
    }
  }

  // Wrap a store mutation so a store-unavailable failure becomes a loud,
  // recorded unhealthy transition instead of a silent pass.
  private guarded<T>(
    scenario: Ws13HookEnvelope["scenario"],
    hookName: Ws13TransitionEvidence["hookName"],
    fn: () => T,
  ): T | undefined {
    try {
      return fn();
    } catch (err) {
      if (err instanceof Ws13StoreUnavailableError) {
        this.evidence({
          scenario,
          hookName,
          health: "unhealthy_store_unavailable",
          status: "unsupported",
          errorCategoryOnly: "store_unavailable",
        });
        return undefined;
      }
      throw err;
    }
  }

  // --- subagent_spawning -------------------------------------------------
  onSubagentSpawning(envelope: Ws13HookEnvelope): void {
    const { payload, scenario } = redactEnvelope(envelope);
    this.guarded(scenario, "subagent_spawning", () => {
      const childSessionKey = str(payload.childSessionKey);
      const obligationId = this.store.nextId("obl");
      const origin = originFromPayload(payload);
      const record: Ws13ObligationRecord = {
        obligationId,
        childSessionKey,
        requesterSessionKey: undefined,
        origin,
        spawnMode: str(payload.mode),
        createdAt: this.clock.nowIso(),
        status: "candidate",
        health: "healthy_simulated",
        evidenceRefs: [],
        correlationStrength: "none",
        explicitThreadDeliveryRequested: payload.threadRequested === true,
      };
      this.store.createObligation(record);
      this.evidence({
        scenario,
        hookName: "subagent_spawning",
        obligationId,
        to: "candidate",
        status: "inconclusive",
        correlationStrength: "none",
        health: "healthy_simulated",
      });
    });
  }

  // --- subagent_delivery_target -----------------------------------------
  onSubagentDeliveryTarget(envelope: Ws13HookEnvelope): void {
    const { payload, scenario } = redactEnvelope(envelope);
    this.guarded(scenario, "subagent_delivery_target", () => {
      const childSessionKey = str(payload.childSessionKey);
      const found = this.store.findByChild({ childSessionKey });
      if (!found) return;

      const expectsCompletionMessage =
        bool(payload.expectsCompletionMessage) ?? false;
      const origin = originFromPayload(payload);
      const from = found.status;
      const nextStatus: Ws13ObligationStatus = expectsCompletionMessage
        ? "pending"
        : "no_obligation_inline";

      this.store.updateObligation(found.obligationId, {
        requesterSessionKey: str(payload.requesterSessionKey),
        childRunId: str(payload.childRunId),
        origin: origin.channel ? origin : found.origin,
        spawnMode: str(payload.spawnMode) ?? found.spawnMode,
        expectsCompletionMessage,
        status: nextStatus,
      });
      this.evidence({
        scenario,
        hookName: "subagent_delivery_target",
        obligationId: found.obligationId,
        from,
        to: nextStatus,
        status:
          nextStatus === "no_obligation_inline" ? "pass" : "inconclusive",
        health: "healthy_simulated",
      });
    });
  }

  // --- subagent_spawned --------------------------------------------------
  onSubagentSpawned(envelope: Ws13HookEnvelope): void {
    const { payload, scenario } = redactEnvelope(envelope);
    this.guarded(scenario, "subagent_spawned", () => {
      const childSessionKey = str(payload.childSessionKey);
      const childRunId = str(payload.runId);
      const found =
        this.store.findByChild({ childRunId, childSessionKey }) ?? undefined;
      if (!found) return;

      const origin = found.origin;
      const orphaned = !origin || !origin.channel || !origin.to;
      this.store.updateObligation(found.obligationId, {
        childRunId: found.childRunId ?? childRunId,
        health: orphaned ? "unsupported_or_unhealthy" : found.health,
      });
      this.evidence({
        scenario,
        hookName: "subagent_spawned",
        obligationId: found.obligationId,
        from: found.status,
        to: found.status,
        status: orphaned ? "unsupported" : "inconclusive",
        health: orphaned ? "unsupported_or_unhealthy" : "healthy_simulated",
      });
    });
  }

  // --- subagent_ended ----------------------------------------------------
  onSubagentEnded(envelope: Ws13HookEnvelope): void {
    const { payload, scenario } = redactEnvelope(envelope);
    this.guarded(scenario, "subagent_ended", () => {
      const runId = str(payload.runId);
      const targetSessionKey = str(payload.targetSessionKey);
      const found = this.store.findByChild({
        childRunId: runId,
        childSessionKey: targetSessionKey,
      });
      if (!found) return;

      // Inline / stream-to-parent: a child end does NOT create a missing
      // completion-message obligation. Keep the inline classification.
      if (
        found.status === "no_obligation_inline" ||
        found.expectsCompletionMessage === false
      ) {
        this.store.updateObligation(found.obligationId, {
          endedAt: isoFromMaybeEpoch(payload.endedAt, this.clock.nowIso()),
        });
        this.evidence({
          scenario,
          hookName: "subagent_ended",
          obligationId: found.obligationId,
          from: found.status,
          to: "no_obligation_inline",
          status: "pass",
          health: "healthy_simulated",
        });
        return;
      }

      const endedAt = isoFromMaybeEpoch(payload.endedAt, this.clock.nowIso());
      const outcome = str(payload.outcome);
      const targetKind = str(payload.targetKind);

      let status: Ws13ObligationStatus;
      switch (outcome) {
        case "ok":
          status = "child_completed";
          break;
        case "error":
          status = "child_failed";
          break;
        case "timeout":
          status = "child_timeout";
          break;
        case "killed":
          status = "child_killed";
          break;
        case "reset":
        case "deleted":
          // Lifecycle cleanup, not delegated-task completion.
          status = "unsupported_completion_path";
          break;
        default:
          // No clear terminal outcome (deferred/suppressed). Unsupported,
          // never silently "completed".
          status = "unsupported_completion_path";
      }

      const closureDueAt = new Date(
        Date.parse(endedAt) + this.windowMs,
      ).toISOString();

      this.store.updateObligation(found.obligationId, {
        status,
        endedAt,
        closureDueAt,
        health:
          status === "unsupported_completion_path"
            ? "unsupported_or_unhealthy"
            : found.health,
        errorCategoryOnly:
          targetKind === "acp" && status === "unsupported_completion_path"
            ? "correlation_insufficient"
            : found.errorCategoryOnly,
      });
      this.evidence({
        scenario,
        hookName: "subagent_ended",
        obligationId: found.obligationId,
        from: found.status,
        to: status,
        status:
          status === "unsupported_completion_path" ? "unsupported" : "inconclusive",
        health:
          status === "unsupported_completion_path"
            ? "unsupported_or_unhealthy"
            : "healthy_simulated",
      });
    });
  }

  // --- reply_dispatch ----------------------------------------------------
  onReplyDispatch(envelope: Ws13HookEnvelope): void {
    const { payload, scenario } = redactEnvelope(envelope);
    this.guarded(scenario, "reply_dispatch", () => {
      const observationId = this.store.nextId("disp");
      const observation = dispatchObservationFromPayload(
        observationId,
        payload,
        this.clock.nowIso(),
      );
      this.store.recordDispatch(observation);

      const found =
        this.store.findByChild({
          childRunId: observation.runId,
        }) ??
        this.store
          .allObligations()
          .find(
            (o) =>
              (observation.sessionKey &&
                o.requesterSessionKey === observation.sessionKey) ||
              (o.origin?.channel === observation.originatingChannel &&
                o.origin?.to === observation.originatingTo),
          );
      if (!found) return;

      const suppressed =
        observation.suppressUserDelivery === true ||
        observation.sendPolicy === "deny";
      const nextStatus: Ws13ObligationStatus = suppressed
        ? "dispatch_suppressed"
        : "dispatch_observed";

      this.store.updateObligation(found.obligationId, {
        status:
          found.status === "satisfied" ? "satisfied" : nextStatus,
        health: suppressed
          ? "unhealthy_correlation_insufficient"
          : found.health,
        errorCategoryOnly: suppressed
          ? "suppressed_delivery"
          : found.errorCategoryOnly,
      });
      this.evidence({
        scenario,
        hookName: "reply_dispatch",
        obligationId: found.obligationId,
        from: found.status,
        to: nextStatus,
        status: suppressed ? "fail" : "inconclusive",
        errorCategoryOnly: suppressed ? "suppressed_delivery" : undefined,
        health: suppressed
          ? "unhealthy_correlation_insufficient"
          : "healthy_simulated",
      });
    });
  }

  // --- message_sent ------------------------------------------------------
  onMessageSent(envelope: Ws13HookEnvelope): void {
    const { payload, scenario } = redactEnvelope(envelope);
    this.guarded(scenario, "message_sent", () => {
      const observationId = this.store.nextId("recv");
      const observation = deliveryObservationFromPayload(
        observationId,
        payload,
        this.clock.nowIso(),
      );
      this.store.recordDelivery(observation);

      // message_sent carries no sessionKey/runId (source Blocker 1), so this
      // can only correlate by destination; closure is finalized in evaluate.
      const found = this.store
        .allObligations()
        .find(
          (o) =>
            o.origin?.channel === observation.channel &&
            o.origin?.to === observation.to,
        );
      if (found && observation.success) {
        this.store.updateObligation(found.obligationId, {
          status:
            found.status === "satisfied"
              ? "satisfied"
              : "delivery_observed",
        });
        this.evidence({
          scenario,
          hookName: "message_sent",
          obligationId: found.obligationId,
          from: found.status,
          to: "delivery_observed",
          status: "inconclusive",
          health: "healthy_simulated",
        });
      }
    });
  }

  // --- message_sending (optional, metadata only) ------------------------
  onMessageSending(envelope: Ws13HookEnvelope): void {
    const { payload, scenario } = redactEnvelope(envelope);
    this.guarded(scenario, "message_sending", () => {
      const observationId = this.store.nextId("send");
      const observation = messageSendingObservationFromPayload(
        observationId,
        payload,
        this.clock.nowIso(),
      );
      // Used ONLY for Slack mainline-vs-thread classification. Never reads,
      // stores, rewrites, cancels, or persists message content.
      this.store.recordMessageSending(observation);
      this.evidence({
        scenario,
        hookName: "message_sending",
        status: "inconclusive",
        health: "healthy_simulated",
      });
    });
  }

  // --- closure evaluation / bounded window -------------------------------
  // Finalizes an obligation: satisfied | missing_closure_alert_required |
  // unsupported_or_unhealthy | (still pending if window not elapsed).
  evaluateClosure(
    obligationId: string,
    scenario?: Ws13HookEnvelope["scenario"],
  ): Ws13ObligationRecord | undefined {
    return this.guarded(scenario, "closure_window", () => {
      const obligation = this.store.getObligation(obligationId);
      if (!obligation) return undefined;

      // Inline / stream-to-parent: no completion-message obligation.
      if (obligation.status === "no_obligation_inline") {
        this.evidence({
          scenario,
          hookName: "closure_window",
          obligationId,
          from: obligation.status,
          to: "no_obligation_inline",
          status: "pass",
          health: "healthy_simulated",
        });
        return obligation;
      }

      const result = correlate({
        obligation,
        dispatches: this.store.dispatchObservations(),
        deliveries: this.store.deliveryObservations(),
        messageSendings: this.store.messageSendingObservations(),
        nowMs: this.clock.nowMs(),
        windowMs: this.windowMs,
      });

      // Completion is "observed" only if subagent_ended set endedAt. A
      // persistent session that suppresses subagent_ended never sets it.
      const completionObserved = Boolean(obligation.endedAt);
      const dueBaseIso =
        obligation.closureDueAt ??
        new Date(
          Date.parse(obligation.endedAt ?? obligation.createdAt) +
            this.windowMs,
        ).toISOString();
      const windowElapsed = this.clock.nowMs() >= Date.parse(dueBaseIso);

      let status: Ws13ObligationStatus = obligation.status;
      let health = obligation.health;

      if (result.closureSatisfied) {
        status = "satisfied";
        health = "healthy_simulated";
      } else if (obligation.status === "unsupported_completion_path") {
        status = "unsupported_or_unhealthy";
        health = "unsupported_or_unhealthy";
      } else if (windowElapsed && !completionObserved) {
        // Expected a completion message but the child completion moment was
        // never observable inside the window.
        if (obligation.spawnMode === "session") {
          // Persistent session-mode: subagent_ended suppressed on normal
          // completion (source caveat). Unsupported, never silently passed.
          status = "unsupported_or_unhealthy";
          health = "unsupported_or_unhealthy";
        } else {
          status = "missing_closure_alert_required";
          health = "unhealthy_correlation_insufficient";
        }
      } else if (windowElapsed) {
        // Completion observed but no correlated, mainline-proven visible
        // closure inside the bounded window. Weak correlation also lands
        // here — it is never accepted as a final pass.
        status = "missing_closure_alert_required";
        health =
          result.slackDeliveryClass === "indeterminate" ||
          result.slackDeliveryClass === "thread_unexpected"
            ? "unsupported_or_unhealthy"
            : "unhealthy_correlation_insufficient";
      }
      // else: window not elapsed yet — remains pending (interim inconclusive)

      const alertCapability = classifyAlertCapability({
        replyDispatchAvailable: true,
        approvedPluginSendApiAvailable: false,
        hasActiveDispatchContext: result.dispatchObserved,
      });

      this.store.updateObligation(obligationId, {
        status,
        health,
        correlationStrength: result.strength,
        slackDeliveryClass: result.slackDeliveryClass,
        alertCapability,
        errorCategoryOnly:
          status === "missing_closure_alert_required"
            ? "correlation_insufficient"
            : obligation.errorCategoryOnly,
      });

      this.evidence({
        scenario,
        hookName: "closure_window",
        obligationId,
        from: obligation.status,
        to: status,
        status:
          status === "satisfied"
            ? "pass"
            : status === "missing_closure_alert_required"
              ? "fail"
              : status === "unsupported_or_unhealthy"
                ? "unsupported"
                : "inconclusive",
        correlationStrength: result.strength,
        health,
        errorCategoryOnly:
          status === "missing_closure_alert_required"
            ? "correlation_insufficient"
            : undefined,
      });

      return this.store.getObligation(obligationId);
    });
  }
}
