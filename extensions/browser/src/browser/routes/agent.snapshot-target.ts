import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

/**
 * Pick the target OpenClaw should report after a browser operation.
 *
 * Identity contract:
 * - The backend (Playwright page CDP session, extension relay, or Chrome MCP)
 *   owns the operation outcome. Route code never infers identity from tab
 *   lists, URL cardinality, sole remaining tabs, or newly appeared targets.
 * - When the backend reports an operation-owned target id, that is returned.
 * - When the backend reports nothing (page closed or detached), the acted-on
 *   identity is returned so callers require a fresh selection. This fail-safe
 *   deliberately rejects heuristic recovery to an unrelated sole survivor tab.
 *
 * Extension-relay profiles use Playwright `readPageTargetId` on the acted-on page
 * (same backend path as managed Playwright). A stable relay public CDP identity
 * contract is deferred to a separately approved browser-contract change.
 * Chrome MCP existing-session reports operation-owned ids via tab-list membership
 * after navigate/act; when the acted-on tab is gone, callers keep the stale id.
 */
export function resolveOperationTargetOutcome(opts: {
  actedOnTargetId: string;
  operationTargetId?: string | null;
}): string {
  const owned = normalizeOptionalString(opts.operationTargetId) ?? "";
  return owned || opts.actedOnTargetId;
}

/** Chrome MCP existing-session: tab-list membership is the backend-owned signal. */
export async function readChromeMcpOperationTargetId(params: {
  listTabs: () => Promise<Array<{ targetId: string }>>;
  actedOnTargetId: string;
}): Promise<string | null> {
  const tabs = await params.listTabs();
  return tabs.some((entry) => entry.targetId === params.actedOnTargetId)
    ? params.actedOnTargetId
    : null;
}
