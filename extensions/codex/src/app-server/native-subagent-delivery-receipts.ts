import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { codexNativeSubagentNotifications } from "./native-subagent-notification.js";
import { isJsonObject, type CodexServerNotification } from "./protocol.js";

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
  private readonly unacknowledged = new Map<string, Map<string, Receipt>>();
  private readonly compacting = new Set<string>();

  discardUnacknowledged(threadId: string, turnId?: string): void {
    const prefix = `${threadId}\0`;
    for (const key of new Set([...this.unacknowledged.keys(), ...this.compacting])) {
      if (turnId ? key === `${prefix}${turnId}` : key.startsWith(prefix)) {
        this.unacknowledged.delete(key);
        this.compacting.delete(key);
      }
    }
  }

  observe(notification: CodexServerNotification): string[] {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    const item = isJsonObject(params?.item) ? params.item : undefined;
    const threadId = readString(params, "threadId");
    const turnId = readString(params, "turnId");
    const samplingKey = threadId && turnId ? `${threadId}\0${turnId}` : undefined;
    if (samplingKey && item?.type === "contextCompaction") {
      // Replacing history invalidates unsampled evidence, never accepted receipts.
      this.unacknowledged.delete(samplingKey);
      if (notification.method === "item/started") {
        this.compacting.add(samplingKey);
      } else if (notification.method === "item/completed") {
        this.compacting.delete(samplingKey);
      }
      return [];
    }
    if (notification.method === "rawResponse/completed") {
      if (!samplingKey || !readString(params, "responseId") || this.compacting.has(samplingKey)) {
        return [];
      }
      const sampled = this.unacknowledged.get(samplingKey);
      this.unacknowledged.delete(samplingKey);
      for (const [id, receipt] of sampled ?? []) {
        if (!this.seen.has(id)) {
          this.seen.add(id);
          this.pending.push(receipt);
        }
      }
      return this.match();
    }
    if (!item) {
      return [];
    }
    const nativeResults = codexNativeSubagentNotifications.fromNotification(notification);
    for (const agentPath of codexNativeSubagentNotifications.deliveredAgentPaths(notification)) {
      const id = `${notification.method}:${readString(item, "id") ?? JSON.stringify(item)}:${agentPath}`;
      if (this.seen.has(id)) {
        continue;
      }
      let result = nativeResults.find((value) => value.agentPath === agentPath)?.result;
      if (item.type === "agent_message" && Array.isArray(item.content)) {
        const part = item.content[0];
        const text = isJsonObject(part) ? readString(part, "text") : undefined;
        result = text?.split("\nPayload:\n").slice(1).join("\nPayload:\n");
      } else if (isJsonObject(item.agentsStates)) {
        const child = item.agentsStates[agentPath];
        result = isJsonObject(child) ? readString(child, "message") : result;
      }
      const receipt = { agentPath, result: receiptResultKey(result) };
      if (notification.method === "rawResponseItem/completed") {
        // Input arrival is not proof of a successful native sampling response.
        if (samplingKey && !this.compacting.has(samplingKey)) {
          let batch = this.unacknowledged.get(samplingKey);
          if (!batch) {
            batch = new Map();
            this.unacknowledged.set(samplingKey, batch);
          }
          batch.set(id, receipt);
        }
      } else {
        // Preserve the existing matching-terminal V1 tool-output contract.
        this.seen.add(id);
        this.pending.push(receipt);
      }
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
  notification: CodexServerNotification;
  knownChildren: Iterable<KnownReceiptChild<Parent>>;
  applyReceipts: (runIds: readonly string[]) => void;
  allowConsumption?: boolean;
}): void {
  const { state, notification, knownChildren, applyReceipts } = params;
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
    if (params.allowConsumption === false) {
      const nativeParams = isJsonObject(notification.params) ? notification.params : undefined;
      const turn = isJsonObject(nativeParams?.turn) ? nativeParams.turn : undefined;
      const turnId = readString(nativeParams, "turnId") ?? readString(turn, "id");
      if (turnId) {
        tracker.discardUnacknowledged(state.parentThreadId, turnId);
      }
    } else {
      applyReceipts(tracker.observe(notification));
    }
  }
}

function receiptResultKey(result: string | undefined): string | undefined {
  // Native receipt families can differ in whitespace; compare their result text consistently.
  return result?.replace(/\s+/g, " ").trim();
}
