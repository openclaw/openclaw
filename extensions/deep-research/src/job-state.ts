import { createHash } from "node:crypto";
import type { OpenClawPluginApi, PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import type { ResearchRequest, ResearchResult } from "./contract.js";
import type { ResearchExecution } from "./execution.js";
import type { ResearchAdapterSnapshot } from "./managed-contract.js";

export type ResearchJob = {
  version: 1;
  id: string;
  request: ResearchRequest;
  sessionKey: string;
  sessionId: string;
  agentId: string;
  createdAt: number;
  deadlineAt: number;
  state:
    | "queued"
    | "running"
    | "paused"
    | "submitting"
    | "indeterminate"
    | "completed"
    | "partial"
    | "cancelled"
    | "failed";
  progress: string;
  publicationId?: string;
  publishedAt?: number;
  handle?: ResearchAdapterSnapshot["handle"];
  result?: ResearchResult;
  cancelRequested?: boolean;
};
export type Step = { state: "started" } | { state: "done"; value: unknown } | { state: "failed" };
export const retentionMs = 7 * 24 * 60 * 60_000;
export const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export const terminal = (job: ResearchJob) =>
  ["completed", "partial", "cancelled", "failed", "indeterminate"].includes(job.state);
// Optional properties are omitted at the JSON persistence boundary. Inputs and receipts
// are validated JSON data; the state store deliberately rejects explicit undefined fields.
export function retainedJson<T>(value: T): T {
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- JSON encoding must omit undefined; structuredClone preserves fields rejected by the state store.
  return JSON.parse(JSON.stringify(value)) as T;
}
/** Feature-owned persistence bounds and namespaces; never a source of execution authority. */
export class ResearchState {
  constructor(
    private readonly api: OpenClawPluginApi,
    private readonly scheduler: PluginServiceSchedulerV1,
  ) {}
  open<T>(
    kind: "jobs" | "steps" | "cancellations",
    context: ResearchExecution,
    assertCurrent = context.assertInvocationCurrent,
  ) {
    if (!context.sessionKey || !context.sessionId || !context.agentId) {
      throw new Error("Research requires a current conversation generation.");
    }
    return this.api.runtime.state.openKeyedStoreV2<T>(
      {
        namespace: this.namespace(kind, context),
        maxEntries: kind === "steps" ? 4096 : 32,
        overflowPolicy: "reject-new",
      },
      { assertCurrent },
    );
  }
  private namespace(kind: "jobs" | "steps" | "cancellations", context: ResearchExecution) {
    return `research-${kind}-v1-${hash(`${context.agentId}\n${context.sessionKey}\n${context.sessionId}`)}`;
  }
  async retainStartOutcome(job: ResearchJob, handle?: ResearchAdapterSnapshot["handle"]) {
    const assertCurrent = () => this.scheduler.signal.throwIfAborted();
    const context = { ...job, assertInvocationCurrent: assertCurrent };
    const store = this.open<ResearchJob>("jobs", context);
    const observed = await store.observe(job.id);
    assertCurrent();
    const latest = observed.value;
    if (
      !latest ||
      latest.id !== job.id ||
      latest.agentId !== job.agentId ||
      latest.sessionKey !== job.sessionKey ||
      latest.sessionId !== job.sessionId ||
      latest.state !== "submitting" ||
      latest.handle ||
      latest.result ||
      latest.publicationId
    ) {
      throw new Error("Research receipt no longer belongs to the pending submission.");
    }
    // Only definite submission bookkeeping may outlive the source borrow. An
    // absent handle here means proven not sent, never an unknown transport result.
    // No report, request, policy, or target is copied from the response/caller.
    if (handle) {
      latest.handle = handle;
    }
    latest.state = "paused";
    latest.progress = handle
      ? "Provider receipt recorded for reconciliation."
      : "Provider request was not sent.";
    const result = await store.compareAndApply(job.id, observed.comparison, {
      operation: "update",
      action: "set",
      value: retainedJson(latest),
      ttlMs: retentionMs,
    });
    assertCurrent();
    if (result.status === "conflict") {
      throw new Error("Research receipt raced with newer job state.");
    }
    return latest;
  }
}
