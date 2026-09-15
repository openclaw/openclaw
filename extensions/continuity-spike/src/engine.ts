import { createHash, randomUUID } from "node:crypto";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  AggregateStore,
  MAX_DECISIONS,
  MAX_TURNS,
  MAX_OPERATIONS,
  requireCondition,
  requireId,
  requireDirection,
  requireStep,
  requireRevision,
  requireSession,
  copy,
  defaultPolicy,
  updatePolicy,
} from "./state-helpers.js";
import type {
  ActivityPolicy,
  ActivityState,
  AdmittedOperation,
  DecisionRevision,
  DestinationState,
  DestinationStatus,
  Direction,
  EnrollActivity,
  OperationReceipt,
  OperationRecord,
  StepCount,
  TurnSnapshot,
} from "./types.js";

export { ContinuityError } from "./state-helpers.js";

const OPERATION_KEYS = [
  "id",
  "activityId",
  "destinationId",
  "runId",
  "decisionRevision",
  "direction",
  "step",
  "authorityGeneration",
  "attachmentGeneration",
  "expectedDestinationRevision",
  "hash",
];
const RECEIPT_KEYS = [
  "operationId",
  "operationHash",
  "activityId",
  "destinationId",
  "destinationRevision",
  "outcome",
  "reason",
  "artifactId",
];

function home(current: ActivityState | undefined): ActivityState {
  requireCondition(
    current?.kind === "home-activity" && current.schemaVersion === 1,
    "activity-not-enrolled",
  );
  requireCondition(
    current.decisions.length <= MAX_DECISIONS &&
      current.turns.length <= MAX_TURNS &&
      current.operations.length <= MAX_OPERATIONS,
    "invalid-aggregate-bounds",
  );
  return current;
}

function findTurn(state: ActivityState, runId: string): TurnSnapshot {
  const turn = state.turns.find((candidate) => candidate.runId === runId);
  requireCondition(turn, "turn-not-admitted");
  return turn;
}

function findOperation(state: ActivityState, operationId: string): OperationRecord {
  const record = state.operations.find((candidate) => candidate.operation.id === operationId);
  requireCondition(record, "operation-not-admitted");
  return record;
}

function canExecute(state: ActivityState): void {
  requireCondition(!state.stopped, "activity-stopped");
  requireCondition(state.attachment.connected, "attachment-disconnected");
  requireCondition(state.policy.execute, "home-execute-denied");
}

function liveTurn(state: ActivityState, runId: string): TurnSnapshot {
  canExecute(state);
  const turn = findTurn(state, runId);
  requireCondition(turn.state === "active", "turn-not-active");
  requireCondition(turn.sessionKey === state.sessionKey, "turn-session-mismatch");
  requireCondition(turn.authorityGeneration === state.authorityGeneration, "turn-authority-stale");
  requireCondition(
    turn.attachmentGeneration === state.attachment.generation,
    "turn-attachment-stale",
  );
  if (state.mode === "operation") {
    requireCondition(
      turn.decisionRevision === state.currentDecision.revision,
      "decision-superseded",
    );
  }
  return turn;
}

function isPending(record: OperationRecord): boolean {
  return (
    record.state === "admitted" ||
    record.state === "dispatched" ||
    record.state === "outcome-unknown"
  );
}

function refreshActivity(state: ActivityState): void {
  const currentOperations = state.operations.filter(
    (record) => record.operation.decisionRevision === state.currentDecision.revision,
  );
  const latestCurrent = currentOperations.at(-1);
  state.completedSteps = currentOperations
    .filter((record) => record.state === "succeeded")
    .map((record) => record.operation.step)
    .toSorted((a, b) => a - b);
  if (state.stopped) {
    state.status = "stopped";
    state.blockedReason = "operator-stop";
  } else if (state.operations.some((record) => record.state === "outcome-unknown")) {
    state.status = "blocked";
    state.blockedReason = "outcome-unknown";
  } else if (!state.attachment.connected || !state.policy.execute) {
    state.status = "blocked";
    state.blockedReason = !state.attachment.connected
      ? "attachment-disconnected"
      : "home-execute-denied";
  } else if (state.completedSteps.length === state.targetSteps) {
    state.status = "completed";
    state.blockedReason = null;
  } else if (latestCurrent?.state === "rejected") {
    state.status = "blocked";
    state.blockedReason = latestCurrent.receipt?.reason ?? "operation-rejected";
  } else if (
    state.operations.some((record) => isPending(record)) ||
    state.turns.some((turn) => turn.state === "active")
  ) {
    state.status = "running";
    state.blockedReason = null;
  } else {
    state.status = "pending";
    state.blockedReason = null;
  }
}

function operationHash(operation: Omit<AdmittedOperation, "hash">): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "continuity-spike-operation-v1",
        operation.id,
        operation.activityId,
        operation.destinationId,
        operation.runId,
        operation.decisionRevision,
        operation.direction,
        operation.step,
        operation.authorityGeneration,
        operation.attachmentGeneration,
        operation.expectedDestinationRevision,
      ]),
    )
    .digest("hex");
}

function validateOperation(operation: AdmittedOperation): void {
  const keys = Object.keys(operation);
  requireCondition(
    keys.length === OPERATION_KEYS.length && keys.every((key) => OPERATION_KEYS.includes(key)),
    "invalid-operation",
  );
  for (const id of [operation.id, operation.activityId, operation.destinationId, operation.runId]) {
    requireId(id);
  }
  requireDirection(operation.direction);
  requireStep(operation.step);
  for (const revision of [
    operation.decisionRevision,
    operation.authorityGeneration,
    operation.attachmentGeneration,
    operation.expectedDestinationRevision,
  ]) {
    requireRevision(revision);
  }
  requireCondition(operation.hash === operationHash(operation), "operation-binding-mismatch");
}

function receiptMatches(operation: AdmittedOperation, receipt: OperationReceipt): void {
  const keys = Object.keys(receipt);
  requireCondition(
    keys.length === RECEIPT_KEYS.length && keys.every((key) => RECEIPT_KEYS.includes(key)),
    "invalid-receipt",
  );
  requireCondition(
    receipt.operationId === operation.id &&
      receipt.operationHash === operation.hash &&
      receipt.activityId === operation.activityId &&
      receipt.destinationId === operation.destinationId,
    "receipt-binding-mismatch",
  );
  requireRevision(receipt.destinationRevision);
  requireCondition(
    (receipt.outcome === "succeeded" &&
      receipt.reason === "artifact-written" &&
      receipt.artifactId === `artifact:${operation.id}` &&
      receipt.destinationRevision === operation.expectedDestinationRevision) ||
      (receipt.outcome === "rejected" &&
        (receipt.reason === "destination-revision-conflict" ||
          receipt.reason === "step-conflict") &&
        receipt.artifactId === null) ||
      (receipt.outcome === "cancelled" &&
        receipt.reason === "cancelled" &&
        receipt.artifactId === null),
    "invalid-receipt",
  );
}

/** Host-authorized fixture lifecycle, not a general agent-controlled authority service. */
export class ContinuityEngine extends AggregateStore<ActivityState> {
  enroll(input: EnrollActivity): ActivityState {
    requireId(input.id);
    requireId(input.destinationId);
    requireSession(input.sessionKey);
    requireCondition(
      input.mode === "next-turn" || input.mode === "operation",
      "invalid-consistency-mode",
    );
    const targetSteps = input.targetSteps ?? 1;
    requireStep(targetSteps);
    const objective = input.objective ?? "Complete the synthetic activity steps";
    requireCondition(
      typeof objective === "string" && objective.length > 0 && objective.length <= 160,
      "invalid-objective",
    );
    return this.mutate(input.id, (current) => {
      requireCondition(current === undefined, "activity-already-enrolled");
      const initial: DecisionRevision = {
        revision: 1,
        direction: "A",
        requestId: "initial-enrollment",
      };
      const state: ActivityState = {
        kind: "home-activity",
        schemaVersion: 1,
        id: input.id,
        sessionKey: input.sessionKey,
        destinationId: input.destinationId,
        objective,
        targetSteps,
        mode: input.mode,
        currentDecision: initial,
        decisions: [initial],
        turns: [],
        operations: [],
        policy: defaultPolicy(),
        authorityGeneration: 1,
        attachment: { connected: true, generation: 1, destinationRevision: 1 },
        stopped: false,
        completedSteps: [],
        status: "pending",
        blockedReason: null,
      };
      return { state, result: state };
    });
  }

  get(id: string): ActivityState {
    requireId(id);
    return copy(home(this.store.lookup(id)));
  }

  list(): ActivityState[] {
    return this.store
      .entries()
      .map((entry) => copy(home(entry.value)))
      .toSorted((a, b) => a.id.localeCompare(b.id));
  }

  acceptDecision(id: string, direction: Direction, requestId: string): DecisionRevision {
    requireDirection(direction);
    requireId(requestId);
    return this.mutate(id, (current) => {
      const state = home(current);
      const prior = state.decisions.find((decision) => decision.requestId === requestId);
      if (prior) {
        requireCondition(prior.direction === direction, "decision-idempotency-conflict");
        return { state, result: prior };
      }
      requireCondition(!state.stopped, "activity-stopped");
      requireCondition(state.decisions.length < MAX_DECISIONS, "decision-capacity-exhausted");
      const decision = { revision: state.currentDecision.revision + 1, direction, requestId };
      state.currentDecision = decision;
      state.decisions.push(decision);
      // In operation mode locally controllable releases are cancelled; already
      // dispatched effects may finish. Next-turn mode retains active A snapshots.
      if (state.mode === "operation") {
        for (const record of state.operations) {
          if (record.state === "admitted") {
            record.state = "cancelled";
          }
        }
      }
      refreshActivity(state);
      return { state, result: decision };
    });
  }

  beginTurn(id: string, sessionKey: string, runId: string): TurnSnapshot {
    requireSession(sessionKey);
    requireId(runId);
    return this.mutate(id, (current) => {
      const state = home(current);
      canExecute(state);
      requireCondition(state.sessionKey === sessionKey, "turn-session-mismatch");
      const prior = state.turns.find((turn) => turn.runId === runId);
      if (prior) {
        requireCondition(prior.sessionKey === sessionKey, "turn-idempotency-conflict");
        requireCondition(prior.state === "active", "turn-not-active");
        return { state, result: liveTurn(state, runId) };
      }
      requireCondition(state.turns.length < MAX_TURNS, "turn-capacity-exhausted");
      const turn: TurnSnapshot = {
        runId,
        sessionKey,
        decisionRevision: state.currentDecision.revision,
        direction: state.currentDecision.direction,
        authorityGeneration: state.authorityGeneration,
        attachmentGeneration: state.attachment.generation,
        state: "active",
      };
      state.turns.push(turn);
      refreshActivity(state);
      return { state, result: turn };
    });
  }

  proposeOperation(
    id: string,
    runId: string,
    input: { direction: Direction; step: StepCount },
  ): AdmittedOperation {
    requireId(runId);
    requireDirection(input.direction);
    requireStep(input.step);
    return this.mutate(id, (current) => {
      const state = home(current);
      const turn = liveTurn(state, runId);
      requireCondition(turn.direction === input.direction, "proposal-direction-mismatch");
      requireCondition(input.step <= state.targetSteps, "proposal-step-out-of-scope");
      const prior = state.operations.find(
        (record) => record.operation.runId === runId && record.operation.step === input.step,
      );
      if (prior) {
        requireCondition(
          prior.operation.direction === input.direction,
          "operation-idempotency-conflict",
        );
        requireCondition(prior.state !== "outcome-unknown", "reconciliation-required");
        requireCondition(
          prior.state !== "cancelled" && prior.state !== "rejected",
          "operation-terminal",
        );
        return { state, result: prior.operation };
      }
      requireCondition(
        !state.operations.some((record) => isPending(record)),
        "reconciliation-required",
      );
      const completed = state.operations.filter(
        (record) =>
          record.state === "succeeded" &&
          record.operation.decisionRevision === turn.decisionRevision,
      );
      requireCondition(input.step === completed.length + 1, "proposal-step-not-ready");
      requireCondition(state.operations.length < MAX_OPERATIONS, "operation-capacity-exhausted");
      const payload = {
        id: randomUUID(),
        activityId: id,
        destinationId: state.destinationId,
        runId,
        decisionRevision: turn.decisionRevision,
        direction: input.direction,
        step: input.step,
        authorityGeneration: state.authorityGeneration,
        attachmentGeneration: state.attachment.generation,
        expectedDestinationRevision: state.attachment.destinationRevision,
      };
      const operation: AdmittedOperation = { ...payload, hash: operationHash(payload) };
      state.operations.push({ operation, state: "admitted", receipt: null });
      refreshActivity(state);
      return { state, result: operation };
    });
  }

  markDispatched(id: string, operationId: string): AdmittedOperation {
    requireId(operationId);
    return this.mutate(id, (current) => {
      const state = home(current);
      canExecute(state);
      const record = findOperation(state, operationId);
      requireCondition(record.state === "admitted", "operation-not-ready-for-dispatch");
      requireCondition(
        record.operation.authorityGeneration === state.authorityGeneration,
        "operation-authority-stale",
      );
      requireCondition(
        record.operation.attachmentGeneration === state.attachment.generation,
        "operation-attachment-stale",
      );
      record.state = "dispatched";
      refreshActivity(state);
      return { state, result: record.operation };
    });
  }

  markUnknown(id: string, operationId: string): void {
    requireId(operationId);
    this.mutate(id, (current) => {
      const state = home(current);
      const record = findOperation(state, operationId);
      requireCondition(isPending(record), "operation-terminal");
      record.state = "outcome-unknown";
      refreshActivity(state);
      return { state, result: undefined };
    });
  }

  settleReceipt(id: string, receipt: OperationReceipt): ActivityState {
    return this.mutate(id, (current) => {
      const state = home(current);
      requireCondition(state.policy.statusRead, "home-status-denied");
      const record = findOperation(state, receipt.operationId);
      receiptMatches(record.operation, receipt);
      if (record.receipt) {
        requireCondition(
          Object.entries(record.receipt).every(
            // SAFETY: receiptMatches validates the exact closed set of OperationReceipt keys before this comparison.
            ([key, value]) => receipt[key as keyof OperationReceipt] === value,
          ),
          "receipt-conflict",
        );
      } else {
        requireCondition(
          record.state !== "cancelled" || receipt.outcome === "cancelled",
          "operation-cancelled-locally",
        );
        record.receipt = copy(receipt);
        record.state = receipt.outcome;
      }
      refreshActivity(state);
      return { state, result: state };
    });
  }

  requestCancellation(id: string, operationId: string): AdmittedOperation {
    requireId(operationId);
    return this.mutate(id, (current) => {
      const state = home(current);
      requireCondition(state.policy.cancel, "home-cancel-denied");
      const record = findOperation(state, operationId);
      requireCondition(isPending(record) || record.state === "cancelled", "operation-terminal");
      if (record.state === "admitted") {
        record.state = "cancelled";
      }
      // Dispatched/unknown work remains unresolved until the destination records
      // a terminal cancellation (or reports the already-committed effect).
      refreshActivity(state);
      return { state, result: record.operation };
    });
  }

  finishTurn(id: string, runId: string): ActivityState {
    requireId(runId);
    return this.mutate(id, (current) => {
      const state = home(current);
      const turn = findTurn(state, runId);
      if (turn.state === "active") {
        turn.state = "finished";
      }
      // A completion is a fact about A; only receipts under the CURRENT
      // revision can discharge the current commitment.
      refreshActivity(state);
      return { state, result: state };
    });
  }

  stop(id: string): ActivityState {
    return this.mutate(id, (current) => {
      const state = home(current);
      if (!state.stopped) {
        state.authorityGeneration += 1;
      }
      state.stopped = true;
      for (const turn of state.turns) {
        if (turn.state === "active") {
          turn.state = "stopped";
        }
      }
      for (const record of state.operations) {
        if (record.state === "admitted") {
          record.state = "cancelled";
        }
      }
      refreshActivity(state);
      return { state, result: state };
    });
  }

  setPolicy(id: string, patch: Partial<ActivityPolicy>): ActivityState {
    return this.mutate(id, (current) => {
      const state = home(current);
      state.policy = updatePolicy(state.policy, patch);
      state.authorityGeneration += 1;
      for (const record of state.operations) {
        if (record.state === "admitted") {
          record.state = "cancelled";
        }
      }
      refreshActivity(state);
      return { state, result: state };
    });
  }

  setAttachment(
    id: string,
    update: { connected: boolean; destinationRevision?: number },
  ): ActivityState {
    requireCondition(typeof update.connected === "boolean", "invalid-attachment");
    if (update.destinationRevision !== undefined) {
      requireRevision(update.destinationRevision);
    }
    return this.mutate(id, (current) => {
      const state = home(current);
      state.attachment.connected = update.connected;
      state.attachment.generation += 1;
      if (update.destinationRevision !== undefined) {
        state.attachment.destinationRevision = update.destinationRevision;
      }
      for (const record of state.operations) {
        if (record.state === "admitted") {
          record.state = "cancelled";
        }
      }
      refreshActivity(state);
      return { state, result: state };
    });
  }

  /** Call only under exclusive startup custody; not concurrently with live runs. */
  recover(): ActivityState[] {
    return this.list().map((activity) =>
      this.mutate(activity.id, (current) => {
        const state = home(current);
        for (const turn of state.turns) {
          if (turn.state === "active") {
            turn.state = "interrupted";
          }
        }
        for (const record of state.operations) {
          if (isPending(record)) {
            record.state = "outcome-unknown";
          }
        }
        refreshActivity(state);
        return { state, result: state };
      }),
    );
  }
}

function destination(
  current: DestinationState | undefined,
  destinationId: string,
): DestinationState {
  requireCondition(
    current?.kind === "destination-activity" && current.schemaVersion === 1,
    "destination-not-enrolled",
  );
  requireCondition(current.destinationId === destinationId, "destination-identity-mismatch");
  requireCondition(
    current.records.length <= MAX_OPERATIONS && current.artifacts.length <= MAX_OPERATIONS,
    "invalid-aggregate-bounds",
  );
  return current;
}

/** Separate namespace/host authority. The ONLY effect is an atomic synthetic artifact. */
export class DestinationFixture extends AggregateStore<DestinationState> {
  constructor(
    store: PluginStateSyncKeyedStore<DestinationState>,
    private readonly destinationId: string,
  ) {
    super(store);
    requireId(destinationId);
  }

  enroll(input: { id: string; targetSteps?: StepCount }): DestinationState {
    const targetSteps = input.targetSteps ?? 1;
    requireStep(targetSteps);
    return this.mutate(input.id, (current) => {
      requireCondition(current === undefined, "destination-already-enrolled");
      const state: DestinationState = {
        kind: "destination-activity",
        schemaVersion: 1,
        id: input.id,
        destinationId: this.destinationId,
        revision: 1,
        targetSteps,
        policy: defaultPolicy(),
        records: [],
        artifacts: [],
      };
      return { state, result: state };
    });
  }

  get(id: string): DestinationState {
    requireId(id);
    return copy(destination(this.store.lookup(id), this.destinationId));
  }

  list(): DestinationState[] {
    return this.store
      .entries()
      .map((entry) => copy(destination(entry.value, this.destinationId)))
      .toSorted((a, b) => a.id.localeCompare(b.id));
  }

  private resolve(operation: AdmittedOperation, action: "execute" | "cancel"): OperationReceipt {
    validateOperation(operation);
    requireCondition(
      operation.destinationId === this.destinationId,
      "operation-destination-mismatch",
    );
    return this.mutate(operation.activityId, (current) => {
      const state = destination(current, this.destinationId);
      requireCondition(state.policy[action], `destination-${action}-denied`);
      const prior = state.records.find((record) => record.operation.id === operation.id);
      if (prior) {
        requireCondition(prior.operation.hash === operation.hash, "operation-idempotency-conflict");
        return { state, result: prior.receipt };
      }
      requireCondition(state.records.length < MAX_OPERATIONS, "destination-capacity-exhausted");
      let outcome: OperationReceipt["outcome"] = "succeeded";
      let reason: OperationReceipt["reason"] = "artifact-written";
      if (action === "cancel") {
        outcome = "cancelled";
        reason = "cancelled";
      } else if (operation.expectedDestinationRevision !== state.revision) {
        outcome = "rejected";
        reason = "destination-revision-conflict";
      } else if (
        operation.step > state.targetSteps ||
        operation.step !==
          state.artifacts.filter(
            (artifact) => artifact.decisionRevision === operation.decisionRevision,
          ).length +
            1
      ) {
        outcome = "rejected";
        reason = "step-conflict";
      }
      const artifactId = outcome === "succeeded" ? `artifact:${operation.id}` : null;
      const receipt: OperationReceipt = {
        operationId: operation.id,
        operationHash: operation.hash,
        activityId: operation.activityId,
        destinationId: this.destinationId,
        destinationRevision: state.revision,
        outcome,
        reason,
        artifactId,
      };
      if (artifactId) {
        state.artifacts.push({
          id: artifactId,
          operationId: operation.id,
          operationHash: operation.hash,
          activityId: operation.activityId,
          direction: operation.direction,
          decisionRevision: operation.decisionRevision,
          step: operation.step,
          text: `Synthetic ${operation.direction} step ${operation.step} for ${operation.activityId}`,
        });
      }
      state.records.push({ operation: copy(operation), receipt });
      return { state, result: receipt };
    });
  }

  execute(operation: AdmittedOperation): OperationReceipt {
    return this.resolve(copy(operation), "execute");
  }

  cancel(operation: AdmittedOperation): OperationReceipt {
    return this.resolve(copy(operation), "cancel");
  }

  status(id: string, operationId: string): DestinationStatus {
    requireId(operationId);
    const state = this.get(id);
    requireCondition(state.policy.statusRead, "destination-status-denied");
    const record = state.records.find((candidate) => candidate.operation.id === operationId);
    return record ? { outcome: "found", receipt: copy(record.receipt) } : { outcome: "not-found" };
  }

  setPolicy(id: string, patch: Partial<ActivityPolicy>): DestinationState {
    return this.mutate(id, (current) => {
      const state = destination(current, this.destinationId);
      state.policy = updatePolicy(state.policy, patch);
      state.revision += 1;
      return { state, result: state };
    });
  }

  changeState(id: string): DestinationState {
    return this.mutate(id, (current) => {
      const state = destination(current, this.destinationId);
      state.revision += 1;
      return { state, result: state };
    });
  }
}
