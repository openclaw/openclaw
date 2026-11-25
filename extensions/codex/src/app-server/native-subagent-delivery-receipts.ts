import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexNativeSubagentNotification } from "./native-subagent-notification.js";

type ReceiptParent = Readonly<{
  parentThreadId: string;
  deliveryReceipts: CodexNativeSubagentDeliveryReceipts;
}>;
type KnownReceiptChild<Parent extends ReceiptParent> = Readonly<{
  parent: Parent;
  deliveryReceipts: CodexNativeSubagentDeliveryReceipts;
  agentPaths: Set<string>;
}>;
export function buildCodexNativeSubagentAgentPathKey(
  parentThreadId: string,
  agentPath: string,
): string {
  return `${parentThreadId}\0${agentPath}`;
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
  private readonly outcomes = new Map<string, Outcome>();

  observe(receipts: CodexNativeSubagentNotification["receipts"]): string[] {
    for (const { id, agentPath, result } of receipts) {
      if (this.seen.has(id)) {
        continue;
      }
      this.seen.add(id);
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
      const match = matches.find(
        ([, outcome]) =>
          outcome.result === undefined ||
          outcome.result === receipt.result ||
          outcome.receiptResults.has(receipt.result),
      );
      // An unresolved predecessor can still own this receipt unless its exact
      // rendering was already accepted before the successor appeared.
      const ambiguous =
        match &&
        match[1].result === undefined &&
        !match[1].receiptResults.has(receipt.result) &&
        matches.length > 1;
      if (!match || ambiguous) {
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

export function observeCodexNativeSubagentDeliveryReceipts<Parent extends ReceiptParent>(params: {
  state: Parent;
  receipts: CodexNativeSubagentNotification["receipts"];
  knownChildren: Iterable<KnownReceiptChild<Parent>>;
  applyReceipts: (runIds: readonly string[]) => void;
}): void {
  const { state, receipts, knownChildren, applyReceipts } = params;
  const trackers = new Set([state.deliveryReceipts]);
  // A fresh parent can consume a receipt before history reveals its alias.
  // Observe that current receipt in retained assignment owners too; never copy
  // an earlier parent's unmatched receipt into the new parent's tracker.
  for (const known of knownChildren) {
    if (known.parent === state) {
      trackers.add(known.deliveryReceipts);
    }
  }
  for (const tracker of trackers) {
    applyReceipts(tracker.observe(receipts));
  }
}

function receiptResultKey(result: string | undefined): string | undefined {
  // Native receipt families can differ in whitespace; compare their result text consistently.
  return result?.replace(/\s+/g, " ").trim();
}
