import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { withTimeout } from "./app-server/timeout.js";
import { CODEX_CATALOG_MAX_ROWS } from "./session-catalog-limits.js";
import {
  CatalogParamsError,
  CODEX_APP_SERVER_THREADS_LIST_COMMAND,
  CODEX_SESSION_CATALOG_MAX_PAGE_LIMIT,
  NODE_INVOKE_TIMEOUT_MS,
  unwrapNodeInvokePayload,
  parseCatalogPage,
} from "./session-catalog-parsing.js";
import type { CodexSessionCatalogSession } from "./session-catalog-types.js";

export async function lookupNodeCodexCatalogRecord(params: {
  agentId: string;
  runtime: PluginRuntime;
  nodeId: string;
  threadId: string;
  sourceHomeId?: string;
}): Promise<
  | {
      kind: "found";
      record: CodexSessionCatalogSession;
      sourceHomeId?: string;
      canContinueCodex?: boolean;
    }
  | { kind: "missing" | "cursor-cycle" }
> {
  const deadline = performance.now() + NODE_INVOKE_TIMEOUT_MS;
  const unverified = () =>
    new CatalogParamsError("Codex session eligibility could not be verified");
  const remaining = () => {
    const timeoutMs = Math.ceil(deadline - performance.now());
    if (timeoutMs <= 0) {
      throw unverified();
    }
    return timeoutMs;
  };
  let cursor: string | undefined;
  let sourceHomeId = params.sourceHomeId;
  let firstPage = true;
  const seenCursors = new Set<string>();
  for (;;) {
    const timeoutMs = remaining();
    const raw = await withTimeout(
      params.runtime.nodes.invoke({
        nodeId: params.nodeId,
        command: CODEX_APP_SERVER_THREADS_LIST_COMMAND,
        params: {
          agentId: params.agentId,
          ...(sourceHomeId ? { sourceHomeId } : {}),
          limit: CODEX_SESSION_CATALOG_MAX_PAGE_LIMIT,
          ...(cursor ? { cursor } : {}),
        },
        timeoutMs,
        scopes: ["operator.write"],
      }),
      timeoutMs,
      "Codex session eligibility could not be verified",
      unverified,
    );
    remaining();
    const page = parseCatalogPage(unwrapNodeInvokePayload(raw));
    if ((!firstPage || sourceHomeId !== undefined) && page.sourceHomeId !== sourceHomeId) {
      throw new CatalogParamsError(
        "Codex session source home changed; refresh the catalog and retry",
      );
    }
    sourceHomeId = page.sourceHomeId;
    firstPage = false;
    const record = page.sessions.find((candidate) => candidate.threadId === params.threadId);
    if (record) {
      return { kind: "found", record, sourceHomeId, canContinueCodex: page.canContinueCodex };
    }
    const nextCursor = page.nextCursor?.trim();
    if (!nextCursor) {
      break;
    }
    if (seenCursors.has(nextCursor)) {
      return { kind: "cursor-cycle" };
    }
    seenCursors.add(nextCursor);
    if (seenCursors.size > CODEX_CATALOG_MAX_ROWS) {
      const oldest = seenCursors.values().next().value;
      if (oldest !== undefined) {
        seenCursors.delete(oldest);
      }
    }
    cursor = nextCursor;
  }
  return { kind: "missing" };
}
