import { createHash } from "node:crypto";
import {
  validateWorkspaceDoc,
  type WorkspaceDoc,
  type WorkspaceTab,
  type WorkspaceWidget,
} from "./schema.js";

export const MAX_CHANGE_REQUEST_PROPOSAL_BYTES = 128 * 1024;
export const MAX_CHANGE_REQUEST_REASON_BYTES = 2 * 1024;

export type WorkspaceRequester =
  | Readonly<{ principalId: string; kind: "human" }>
  | Readonly<{
      principalId: string;
      kind: "agent";
      delegationId?: string;
      sponsorPrincipalId?: string;
    }>;

export type WorkspaceHumanPrincipal = Readonly<{ principalId: string; kind: "human" }>;
export type WorkspaceWidgetProposal = Omit<WorkspaceWidget, "createdBy">;
export type WorkspaceTabProposal = Omit<
  WorkspaceTab,
  "id" | "revision" | "createdBy" | "widgets"
> & {
  widgets: WorkspaceWidgetProposal[];
};
export type WorkspaceChangeRequestState =
  | "pending"
  | "approved"
  | "rejected"
  | "cancelled"
  | "conflict";

export type WorkspaceChangeRequest = Readonly<{
  id: string;
  isolationDomainId: string;
  workspaceId: string;
  tabId: string;
  requester: WorkspaceRequester;
  baseTabRevision: number;
  idempotencyKey: string;
  proposal: WorkspaceTabProposal;
  proposalSha256: string;
  state: WorkspaceChangeRequestState;
  createdAt: string;
  decider?: WorkspaceHumanPrincipal;
  decidedAt?: string;
  decisionReason?: string;
  cancelledAt?: string;
}>;

export type CreateWorkspaceChangeRequestInput = Readonly<{
  id: string;
  tabId: string;
  requester: WorkspaceRequester;
  baseTabRevision: number;
  idempotencyKey: string;
  proposal: unknown;
}>;

export type CancelWorkspaceChangeRequestInput = Readonly<{
  id: string;
  requester: WorkspaceRequester;
}>;

export type DecideWorkspaceChangeRequestInput = Readonly<{
  id: string;
  decision: "approved" | "rejected";
  decider: WorkspaceHumanPrincipal;
  reason?: string;
}>;

export type WorkspaceChangeRequestDecisionResult = Readonly<{
  request: WorkspaceChangeRequest;
  doc: WorkspaceDoc;
  applied: boolean;
}>;

export type WorkspaceChangeRequestListFilter = Readonly<{
  tabId?: string;
  state?: WorkspaceChangeRequestState;
  requesterPrincipalId?: string;
}>;

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REQUESTER_KINDS = new Set(["human", "agent"]);
const REQUEST_STATES = new Set<WorkspaceChangeRequestState>([
  "pending",
  "approved",
  "rejected",
  "cancelled",
  "conflict",
]);
const TAB_PROPOSAL_KEYS = new Set(["slug", "title", "icon", "hidden", "widgets"]);
const WIDGET_PROPOSAL_KEYS = new Set([
  "id",
  "kind",
  "title",
  "grid",
  "collapsed",
  "hidden",
  "bindings",
  "props",
]);

function assertRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertBoundedText(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (value.includes("\0") || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${label} is too long`);
  }
  return value;
}

export function validateChangeRequestId(value: unknown, label = "change request id"): string {
  const id = assertBoundedText(value, label, 64);
  if (!REQUEST_ID_PATTERN.test(id)) {
    throw new Error(`${label} is invalid`);
  }
  return id;
}

export function validateChangeRequestRequester(value: unknown): WorkspaceRequester {
  const requester = assertRecord(value, "requester");
  for (const key of Object.keys(requester)) {
    if (!["principalId", "kind", "delegationId", "sponsorPrincipalId"].includes(key)) {
      throw new Error(`requester.${key} is not allowed`);
    }
  }
  const principalId = assertBoundedText(requester.principalId, "requester principal id", 256);
  if (typeof requester.kind !== "string" || !REQUESTER_KINDS.has(requester.kind)) {
    throw new Error("requester kind is invalid");
  }
  const delegationId =
    requester.delegationId === undefined
      ? undefined
      : assertBoundedText(requester.delegationId, "delegation id", 256);
  const sponsorPrincipalId =
    requester.sponsorPrincipalId === undefined
      ? undefined
      : assertBoundedText(requester.sponsorPrincipalId, "sponsor principal id", 256);
  if (requester.kind === "human") {
    if (delegationId !== undefined || sponsorPrincipalId !== undefined) {
      throw new Error("human requester cannot carry delegation provenance");
    }
    return { principalId, kind: "human" };
  }
  if ((delegationId === undefined) !== (sponsorPrincipalId === undefined)) {
    throw new Error("agent delegation and sponsor provenance must be provided together");
  }
  return {
    principalId,
    kind: "agent",
    ...(delegationId === undefined ? {} : { delegationId, sponsorPrincipalId }),
  };
}

export function validateHumanDecider(value: unknown): WorkspaceHumanPrincipal {
  const decider = assertRecord(value, "decider");
  if (Object.keys(decider).some((key) => key !== "principalId" && key !== "kind")) {
    throw new Error("decider contains an unsupported field");
  }
  if (decider.kind !== "human") {
    throw new Error("change request decider must be human");
  }
  return {
    principalId: assertBoundedText(decider.principalId, "decider principal id", 256),
    kind: "human",
  };
}

export function validateIdempotencyKey(value: unknown): string {
  return assertBoundedText(value, "idempotency key", 128);
}

export function validateDecisionReason(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return assertBoundedText(value, "decision reason", MAX_CHANGE_REQUEST_REASON_BYTES);
}

function requesterActor(requester: WorkspaceRequester): "user" | `agent:${string}` {
  return requester.kind === "human" ? "user" : `agent:${requester.principalId}`;
}

function proposalFromCanonicalTab(tab: WorkspaceTab): WorkspaceTabProposal {
  const { id: _id, revision: _revision, createdBy: _createdBy, widgets, ...content } = tab;
  return {
    ...content,
    widgets: widgets.map(({ createdBy: _widgetCreatedBy, ...widget }) => widget),
  };
}

function assertProposalShape(value: unknown): Record<string, unknown> {
  const proposal = assertRecord(value, "proposal");
  for (const key of Object.keys(proposal)) {
    if (!TAB_PROPOSAL_KEYS.has(key)) {
      if (key === "id" || key === "revision" || key === "createdBy" || key === "widgetsRegistry") {
        throw new Error(`proposal contains forbidden field: ${key}`);
      }
      throw new Error(`proposal.${key} is not allowed`);
    }
  }
  if (!Array.isArray(proposal.widgets)) {
    throw new Error("proposal.widgets must be an array");
  }
  for (const [index, proposedWidget] of proposal.widgets.entries()) {
    const widget = assertRecord(proposedWidget, `proposal.widgets[${index}]`);
    for (const key of Object.keys(widget)) {
      if (!WIDGET_PROPOSAL_KEYS.has(key)) {
        if (key === "createdBy") {
          throw new Error(`proposal contains forbidden field: widgets[${index}].createdBy`);
        }
        throw new Error(`proposal.widgets[${index}].${key} is not allowed`);
      }
    }
  }
  return proposal;
}

/** Validates hostile proposal input by projecting it into the canonical document schema. */
export function reconcileChangeRequestProposal(params: {
  proposal: unknown;
  current: WorkspaceDoc;
  tab: WorkspaceTab;
  requester: WorkspaceRequester;
}): { proposal: WorkspaceTabProposal; doc: WorkspaceDoc } {
  const proposal = assertProposalShape(params.proposal);
  const existingWidgets = new Map(params.tab.widgets.map((widget) => [widget.id, widget]));
  const widgets = (proposal.widgets as Record<string, unknown>[]).map((widget) =>
    Object.assign({}, widget, {
      createdBy:
        existingWidgets.get(typeof widget.id === "string" ? widget.id : "")?.createdBy ??
        requesterActor(params.requester),
    }),
  );
  const candidateTab = {
    ...proposal,
    id: params.tab.id,
    revision: params.tab.revision,
    createdBy: params.tab.createdBy,
    widgets,
  };
  const nextSlug = typeof proposal.slug === "string" ? proposal.slug : params.tab.slug;
  const doc = validateWorkspaceDoc({
    ...params.current,
    tabs: params.current.tabs.map((tab) => (tab.id === params.tab.id ? candidateTab : tab)),
    prefs: {
      tabOrder: params.current.prefs.tabOrder.map((slug) =>
        slug === params.tab.slug ? nextSlug : slug,
      ),
    },
  });
  const canonicalTab = doc.tabs.find((tab) => tab.id === params.tab.id);
  if (!canonicalTab) {
    throw new Error(`workspace tab not found: ${params.tab.id}`);
  }
  const canonicalProposal = proposalFromCanonicalTab(canonicalTab);
  if (
    Buffer.byteLength(JSON.stringify(canonicalProposal), "utf8") > MAX_CHANGE_REQUEST_PROPOSAL_BYTES
  ) {
    throw new Error("change request proposal exceeds 128 KB");
  }
  return { proposal: canonicalProposal, doc };
}

export function hashChangeRequestProposal(proposal: WorkspaceTabProposal): string {
  return createHash("sha256").update(JSON.stringify(proposal), "utf8").digest("hex");
}

export function parseChangeRequestState(value: string): WorkspaceChangeRequestState {
  if (!REQUEST_STATES.has(value as WorkspaceChangeRequestState)) {
    throw new Error(`invalid persisted change request state: ${value}`);
  }
  return value as WorkspaceChangeRequestState;
}
