import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AgentHarnessTaskRecord } from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { readCodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import { codexNativeSubagentNotifications } from "./native-subagent-notification.js";
import { codexNativeSubagentRunId, readNativeTaskAssignment } from "./native-subagent-task-ids.js";
import { isJsonObject, type CodexServerNotification } from "./protocol.js";

type ReceiptParent = Readonly<{
  parentThreadId: string;
  requesterSessionKey?: string;
  deliveryReceipts: CodexNativeSubagentDeliveryReceipts;
}>;
type KnownReceiptChild<Parent extends ReceiptParent> = Readonly<{
  parent: Parent;
  nativeParentThreadId: string;
  deliveryReceipts: CodexNativeSubagentDeliveryReceipts;
  agentPaths: Set<string>;
  pendingTurns: readonly Readonly<{ turnId: string }>[];
}>;
type ReceiptRecoveryCandidate<Parent extends ReceiptParent> = Readonly<{
  childThreadId: string;
  parentState: Parent;
  requesterSessionKey: string;
  deliveryReceipts: CodexNativeSubagentDeliveryReceipts;
}>;

export function buildCodexNativeSubagentAgentPathKey(
  parentThreadId: string,
  agentPath: string,
): string {
  return `${parentThreadId}\0${agentPath}`;
}

export function resolveCodexNativeSubagentReceiptOwner<Parent extends ReceiptParent>(params: {
  state: Parent;
  childThreadId: string;
  known: KnownReceiptChild<Parent> | undefined;
  candidates: Iterable<ReceiptRecoveryCandidate<Parent>>;
  isRetiredParent: (state: Parent) => boolean;
}): CodexNativeSubagentDeliveryReceipts {
  const { state, childThreadId, known, candidates, isRetiredParent } = params;
  if (known?.parent === state) {
    return known.deliveryReceipts;
  }
  // A history read may retain the receipt owner beyond foreground registration.
  for (const candidate of candidates) {
    if (
      candidate.childThreadId === childThreadId &&
      candidate.parentState.parentThreadId === state.parentThreadId &&
      candidate.requesterSessionKey === state.requesterSessionKey &&
      !isRetiredParent(candidate.parentState)
    ) {
      return candidate.deliveryReceipts;
    }
  }
  return state.deliveryReceipts;
}

export function registerCodexNativeSubagentReceiptAlias<Parent extends ReceiptParent>(params: {
  state: Parent;
  childThreadId: string;
  agentPath: string;
  known: KnownReceiptChild<Parent> | undefined;
  aliases: Map<string, string>;
}): string[] {
  const { state, childThreadId, agentPath, known, aliases } = params;
  if (known?.parent !== state) {
    return [];
  }
  const key = buildCodexNativeSubagentAgentPathKey(state.parentThreadId, agentPath);
  const existingChild = aliases.get(key);
  if (existingChild && existingChild !== childThreadId) {
    embeddedAgentLog.warn("Ignoring conflicting Codex native subagent agent path", {
      parentThreadId: state.parentThreadId,
      agentPath,
      existingChildThreadId: existingChild,
      attemptedChildThreadId: childThreadId,
    });
    return [];
  }
  aliases.set(key, childThreadId);
  known.agentPaths.add(agentPath);
  return known.deliveryReceipts.addAlias(childThreadId, agentPath);
}

type Receipt = { agentPath: string; result?: string };
type Outcome = {
  paths: Set<string>;
  result?: string;
  received: boolean;
  receiptResults: Set<string | undefined>;
};

/** Correlates native receipts with immutable assignments while a parent is registered. */
export class CodexNativeSubagentDeliveryReceipts {
  private readonly seen = new Set<string>();
  private readonly pending: Receipt[] = [];
  private outcomes = new Map<string, Outcome>();

  observe(notification: CodexServerNotification): string[] {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    const item = isJsonObject(params?.item) ? params.item : undefined;
    if (!item) {
      return [];
    }
    const nativeResults = codexNativeSubagentNotifications.fromNotification(notification);
    for (const agentPath of codexNativeSubagentNotifications.deliveredAgentPaths(notification)) {
      const id = `${notification.method}:${readString(item, "id") ?? JSON.stringify(item)}:${agentPath}`;
      if (this.seen.has(id)) {
        continue;
      }
      this.seen.add(id);
      let result = nativeResults.find((value) => value.agentPath === agentPath)?.result;
      if (item.type === "agent_message" && Array.isArray(item.content)) {
        const part = item.content[0];
        const text = isJsonObject(part) ? readString(part, "text") : undefined;
        result = text?.split("\nPayload:\n").slice(1).join("\nPayload:\n");
      } else if (isJsonObject(item.agentsStates)) {
        const child = item.agentsStates[agentPath];
        result = isJsonObject(child) ? readString(child, "message") : result;
      }
      this.pending.push({ agentPath, result: receiptResultKey(result) });
    }
    return this.match();
  }

  record(runId: string, paths: Iterable<string>, result: string): string[] {
    const outcome = this.getOutcome(runId, paths);
    outcome.result = receiptResultKey(result);
    this.outcomes.set(runId, outcome);
    return this.track(runId, []);
  }

  track(runId: string, paths: Iterable<string>): string[] {
    const outcome = this.getOutcome(runId);
    for (const path of paths) {
      outcome.paths.add(path);
    }
    this.outcomes.set(runId, outcome);
    const matched = this.match();
    return outcome.received ? [...new Set([...matched, runId])] : matched;
  }

  restore(
    assignments: Iterable<{ runId: string; paths: Iterable<string>; result?: string }>,
  ): string[] {
    const restored = new Map<string, Outcome>();
    for (const assignment of assignments) {
      const outcome = this.getOutcome(assignment.runId);
      for (const path of assignment.paths) {
        outcome.paths.add(path);
      }
      outcome.result ??= receiptResultKey(assignment.result);
      restored.set(assignment.runId, outcome);
    }
    // Prepare the complete oldest-first snapshot before matching. In-flight
    // native turns may not have task rows yet; retain their existing observations.
    for (const [runId, outcome] of this.outcomes) {
      if (!restored.has(runId)) {
        restored.set(runId, outcome);
      }
    }
    this.outcomes = restored;
    const matched = this.match();
    return [
      ...new Set([
        ...matched,
        ...[...restored].filter(([, value]) => value.received).map(([id]) => id),
      ]),
    ];
  }

  resumeAssignment(runId: string, pendingRunIds: readonly string[]): string[] {
    // The observed turn continues this assignment; its provisional receipt
    // boundary must not keep that assignment's own receipt ambiguous.
    for (const pendingRunId of pendingRunIds) {
      this.outcomes.delete(pendingRunId);
    }
    return this.track(runId, []);
  }

  addAlias(threadId: string, agentPath: string): string[] {
    for (const outcome of this.outcomes.values()) {
      if (outcome.paths.has(threadId)) {
        outcome.paths.add(agentPath);
      }
    }
    return this.match();
  }

  private getOutcome(runId: string, paths: Iterable<string> = []): Outcome {
    return (
      this.outcomes.get(runId) ?? {
        paths: new Set(paths),
        received: false,
        receiptResults: new Set(),
      }
    );
  }

  private match(): string[] {
    const received: string[] = [];
    for (let index = 0; index < this.pending.length;) {
      const receipt = this.pending[index]!;
      const matches = [...this.outcomes].filter(([, outcome]) =>
        outcome.paths.has(receipt.agentPath),
      );
      // Raw native receipts have no child turn ID. Prefer the oldest matching
      // result; a delayed predecessor receipt must never acknowledge its successor.
      let match: [string, Outcome] | undefined;
      for (const candidate of matches) {
        const outcome = candidate[1];
        if (
          (outcome.result !== undefined && outcome.result === receipt.result) ||
          outcome.receiptResults.has(receipt.result)
        ) {
          match = candidate;
          break;
        }
        if (outcome.result === undefined) {
          // An unresolved predecessor can still own this receipt.
          match = matches.length === 1 ? candidate : undefined;
          break;
        }
      }
      if (!match) {
        index += 1;
        continue;
      }
      // Different receipt families can repeat an identical predecessor result.
      // Without a child turn ID, preserve the successor's pending delivery.
      match[1].receiptResults.add(receipt.result);
      if (!match[1].received) {
        match[1].received = true;
        received.push(match[0]);
      }
      this.pending.splice(index, 1);
    }
    return received;
  }
}

export function restoreCodexNativeSubagentTaskReceipts<Parent extends ReceiptParent>(params: {
  state: Parent;
  taskRecords: readonly AgentHarnessTaskRecord[];
  knownChildren: ReadonlyMap<string, KnownReceiptChild<Parent>>;
  applyReceipts: (runIds: readonly string[]) => void;
}): void {
  const { state, taskRecords, knownChildren, applyReceipts } = params;
  const snapshots = new Map<
    CodexNativeSubagentDeliveryReceipts,
    Array<{ runId: string; paths: Iterable<string>; result?: string }>
  >();
  // The task runtime lists newest insertions first, including timestamp ties.
  for (const task of taskRecords
    .toReversed()
    .toSorted((a, b) => (a.startedAt ?? a.createdAt) - (b.startedAt ?? b.createdAt))) {
    if (task.requesterSessionKey !== state.requesterSessionKey) {
      continue;
    }
    const assignment = readNativeTaskAssignment(task);
    if (!assignment) {
      continue;
    }
    const known = knownChildren.get(assignment.childThreadId);
    const history = readCodexNativeSubagentHistoryOwner(task.detail);
    if (
      (known && known.parent !== state) ||
      (history
        ? history.parentThreadId !== (known?.nativeParentThreadId ?? state.parentThreadId)
        : known?.parent !== state)
    ) {
      continue;
    }
    const receipts = known?.deliveryReceipts ?? state.deliveryReceipts;
    const snapshot = snapshots.get(receipts) ?? [];
    snapshot.push({
      runId: assignment.runId,
      paths: known?.agentPaths ?? [assignment.childThreadId],
      ...(task.terminalSummary ? { result: task.terminalSummary } : {}),
    });
    snapshots.set(receipts, snapshot);
  }
  for (const [threadId, known] of knownChildren) {
    if (known.parent !== state || known.pendingTurns.length === 0) {
      continue;
    }
    const snapshot = snapshots.get(known.deliveryReceipts) ?? [];
    for (const turn of known.pendingTurns) {
      snapshot.push({
        runId: codexNativeSubagentRunId(threadId, turn.turnId),
        paths: known.agentPaths,
      });
    }
    snapshots.set(known.deliveryReceipts, snapshot);
  }
  for (const [receipts, snapshot] of snapshots) {
    applyReceipts(receipts.restore(snapshot));
  }
}

export function observeCodexNativeSubagentDeliveryReceipts<Parent extends ReceiptParent>(params: {
  state: Parent;
  notification: CodexServerNotification;
  knownChildren: Iterable<KnownReceiptChild<Parent>>;
  candidates: Iterable<ReceiptRecoveryCandidate<Parent>>;
  isRetiredParent: (state: Parent) => boolean;
  applyReceipts: (runIds: readonly string[]) => void;
}): void {
  const { state, notification, knownChildren, candidates, isRetiredParent, applyReceipts } = params;
  const trackers = new Set([state.deliveryReceipts]);
  // A fresh parent can consume a receipt before history reveals its alias.
  // Observe that current receipt in retained assignment owners too; never copy
  // an earlier parent's unmatched receipt into the new parent's tracker.
  for (const known of knownChildren) {
    if (known.parent === state) {
      trackers.add(known.deliveryReceipts);
    }
  }
  for (const candidate of candidates) {
    if (
      candidate.parentState.parentThreadId === state.parentThreadId &&
      candidate.requesterSessionKey === state.requesterSessionKey &&
      !isRetiredParent(candidate.parentState)
    ) {
      trackers.add(candidate.deliveryReceipts);
    }
  }
  for (const tracker of trackers) {
    applyReceipts(tracker.observe(notification));
  }
}

function receiptResultKey(result: string | undefined): string | undefined {
  // Task summaries collapse whitespace; keep comparison stable across restoration.
  return result?.replace(/\s+/g, " ").trim();
}
