import type { SourceIdentity } from "./ingestion-contract.js";
import type { MergeReport } from "./merge-write.js";
import type { LoadedRecord, Scope } from "./model.js";
import { CorrectInput, WithdrawInput, type Receipt } from "./mutation-contract.js";
import type { FileChange } from "./publication-files.js";
import type { ActivityOrigin } from "./session-activity.js";
import { Manifest } from "./store-manifest.js";
import type { SampleVault } from "./vault.js";
export const canonical = (x: unknown): string =>
  JSON.stringify(x, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).toSorted(([a], [b]) => a.localeCompare(b)))
      : v,
  );
export const scopeKey = (scope: Scope) =>
  scope.visibility === "conversation" ? `conversations/${scope.sessionId}` : "private";
export const blocked = () =>
  new Error(
    "Knowledge publication pending or conflicted; inspect mutation history and retry the original request. No partial catalog returned.",
  );
// `agentId` is the writing agent, fixed at acceptance so a resumed publication
// keeps its original author whoever resumes it.
export type Plan = {
  descriptors?: Record<string, string>;
  activity?: ActivityOrigin;
  rootIdentity: string;
  before: Manifest;
  after: Manifest;
  changes: FileChange[];
  actor: string;
  agentId?: string;
  scope: string;
  record: LoadedRecord;
  records?: LoadedRecord[];
  source?: SourceIdentity;
};
export type Prepared = {
  requiredDescriptors?: Record<string, string>;
  record: LoadedRecord;
  artifacts: Record<string, string>;
  previous?: LoadedRecord;
  data: Awaited<ReturnType<SampleVault["scan"]>>;
  snapshot: string;
  additional?: { before?: LoadedRecord; after: LoadedRecord }[];
  batch?: {
    items: NonNullable<Receipt["items"]>;
    source?: SourceIdentity;
    expectedPreviousRequestId?: string;
  };
  lifecycle?: CorrectInput | WithdrawInput;
  merge?: { operation: "merge" | "unmerge"; targetId: string; reason: string; report: MergeReport };
  extract?: { targetId: string; reason: string };
  annotation?: boolean;
  annotationReferences?: string[];
  metadataOnly?: boolean;
  annotationEvidence?: import("./model.js").Evidence[];
};
export type Row = {
  scope: string;
  request: string;
  intent: string;
  state: Receipt["state"];
  plan: string;
  receipt: string;
};
export type PublicationHook = (stage: string) => void;
/** A page-budget rejection before acceptance; operations that write page prose return its receipt. */
export class PageBudgetError extends Error {
  constructor(readonly receipt: Receipt) {
    super(receipt.message);
  }
}
