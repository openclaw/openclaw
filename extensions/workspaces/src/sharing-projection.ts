import type { WorkspaceChangeRequest, WorkspaceWidgetProposal } from "./change-requests.js";
import type { WorkspaceTab, WorkspaceWidget } from "./schema.js";

export type SharedWorkspaceChangeRequest = Omit<WorkspaceChangeRequest, "proposalSha256">;

const SHARED_SAFE_WIDGET_KINDS = new Set([
  "builtin:markdown",
  "builtin:stat-card",
  "builtin:table",
]);

type SharedWidgetInput = WorkspaceWidget | WorkspaceWidgetProposal;

function projectWidget<T extends SharedWidgetInput>(widget: T): T {
  const bindings = Object.values(widget.bindings ?? {});
  if (
    SHARED_SAFE_WIDGET_KINDS.has(widget.kind) &&
    bindings.every((binding) => binding.source === "static")
  ) {
    return {
      ...widget,
      ...(widget.bindings ? { bindings: { ...widget.bindings } } : {}),
    };
  }
  return {
    id: widget.id,
    kind: "builtin:markdown",
    title: widget.title ?? "Unavailable widget",
    grid: { ...widget.grid },
    collapsed: widget.collapsed,
    hidden: widget.hidden,
    ...("createdBy" in widget ? { createdBy: widget.createdBy } : {}),
    props: { markdown: "This widget is unavailable in a shared workspace view." },
  } as unknown as T;
}

export function projectSharedTab(tab: WorkspaceTab): WorkspaceTab {
  return { ...tab, widgets: tab.widgets.map(projectWidget) };
}

export function projectSharedChangeRequest(
  request: WorkspaceChangeRequest,
): SharedWorkspaceChangeRequest {
  return {
    id: request.id,
    isolationDomainId: request.isolationDomainId,
    workspaceId: request.workspaceId,
    tabId: request.tabId,
    requester: { ...request.requester },
    baseTabRevision: request.baseTabRevision,
    idempotencyKey: request.idempotencyKey,
    proposal: {
      ...request.proposal,
      widgets: request.proposal.widgets.map(projectWidget),
    },
    state: request.state,
    createdAt: request.createdAt,
    ...(request.decider ? { decider: { ...request.decider } } : {}),
    ...(request.decidedAt ? { decidedAt: request.decidedAt } : {}),
    ...(request.decisionReason ? { decisionReason: request.decisionReason } : {}),
    ...(request.cancelledAt ? { cancelledAt: request.cancelledAt } : {}),
  };
}
