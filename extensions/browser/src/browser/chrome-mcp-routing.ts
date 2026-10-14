// Serializes Chrome MCP operations and maps opaque targets/snapshot refs.
import { randomUUID } from "node:crypto";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { createAsyncLock } from "openclaw/plugin-sdk/async-lock-runtime";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  CHROME_MCP_SESSION_TARGET_PREFIX,
  CHROME_MCP_SNAPSHOT_REF_PREFIX,
  MCP_REQUEST_TIMEOUT_CODE,
  STALE_SELECTED_PAGE_ERROR,
  ChromeMcpReconnectRequiredError,
  type ChromeMcpCallOptions,
  type ChromeMcpOptionsInput,
  type ChromeMcpOperationOptions,
  type ChromeMcpRoutingState,
  type ChromeMcpSession,
  type ChromeMcpSessionLease,
  type ChromeMcpStructuredPage,
  type ChromeMcpTargetOperation,
  type ChromeMcpToolResult,
  type NormalizedChromeMcpProfileOptions,
} from "./chrome-mcp-contracts.js";
import { redactChromeMcpProfileLabelForDiagnostic } from "./chrome-mcp-diagnostics.js";
import { normalizeChromeMcpOptions } from "./chrome-mcp-options.js";
import {
  extractChromeMcpToolError,
  extractSnapshot,
  extractStructuredPages,
  formatChromeMcpToolErrorMessage,
} from "./chrome-mcp-result.js";
import { getChromeMcpSessionOwner } from "./chrome-mcp-session.js";
import type { ChromeMcpSnapshotNode } from "./chrome-mcp.snapshot.js";
import { BrowserProfileUnavailableError, BrowserTabNotFoundError } from "./errors.js";

export function getChromeMcpRoutingState(session: ChromeMcpSession): ChromeMcpRoutingState {
  // Routing state lives exactly as long as one stdio subprocess. The compact
  // nonce expires old handles/refs; the lock keeps remote actions aligned with
  // local mappings and snapshot refs.
  session.routing ??= {
    sessionNonce: randomUUID().replaceAll("-", "").slice(0, 12),
    withOperationLock: createAsyncLock(),
    targetIdByPageId: new Map(),
    nextTargetHandleId: 1,
    snapshotsByTarget: new Map(),
    nextSnapshotRefId: 1,
  };
  return session.routing;
}

async function withChromeMcpOperationLock<T>(
  session: ChromeMcpSession,
  options: ChromeMcpOperationOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const signal = options.signal;
  if (signal?.aborted) {
    throw signal.reason ?? new Error("aborted");
  }

  let started = false;
  let cancelled = false;
  let cancelReason: Error | undefined;
  const queued = getChromeMcpRoutingState(session).withOperationLock(async () => {
    if (cancelled) {
      throw cancelReason ?? new Error("Chrome MCP operation cancelled before it started.");
    }
    started = true;
    if (signal?.aborted) {
      throw signal.reason ?? new Error("aborted");
    }
    return await operation();
  });

  const timeoutMs = options.timeoutMs;
  if (!signal && !(timeoutMs !== undefined && timeoutMs > 0)) {
    return await queued;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const cancelBeforeStart = new Promise<never>((_resolve, reject) => {
    const cancel = (reason: unknown) => {
      if (started || cancelled) {
        return;
      }
      cancelled = true;
      cancelReason = toErrorObject(reason, "Chrome MCP operation cancelled");
      reject(cancelReason);
    };
    if (signal) {
      abortListener = () => cancel(signal.reason ?? new Error("aborted"));
      signal.addEventListener("abort", abortListener, { once: true });
    }
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timer = setTimeout(
        () =>
          cancel(
            new Error(
              `Chrome MCP operation timed out after ${timeoutMs}ms while waiting for another operation.`,
            ),
          ),
        timeoutMs,
      );
      timer.unref?.();
    }
  });

  try {
    return await Promise.race([queued, cancelBeforeStart]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
    if (cancelled) {
      void queued.catch(() => {});
    }
  }
}

/** UID-only MCP actions cannot distinguish collisions between renderer documents. */
function validateChromeMcpSnapshotRefs(root: ChromeMcpSnapshotNode) {
  const documents = new Map<
    string,
    { document: ChromeMcpSnapshotNode; documentUid?: string; nodes: ChromeMcpSnapshotNode[] }
  >();
  const pending = [{ node: root, document: root, documentUid: normalizeOptionalString(root.id) }];
  for (let current = pending.pop(); current; current = pending.pop()) {
    const role = current.node.role?.trim().toLowerCase();
    const document = role === "rootwebarea" ? current.node : current.document;
    const documentUid =
      role === "rootwebarea" ? normalizeOptionalString(current.node.id) : current.documentUid;
    const uid = normalizeOptionalString(current.node.id);
    if (uid) {
      const previous = documents.get(uid);
      if (previous && previous.document !== document) {
        throw new Error(
          "Chrome MCP returned ambiguous element IDs across documents. " +
            "The snapshot and its refs were discarded. " +
            "Use a managed browser profile for this page; ref-free screenshots remain available.",
        );
      }
      if (previous) {
        previous.nodes.push(current.node);
      } else {
        documents.set(uid, { document, documentUid, nodes: [current.node] });
      }
    }
    for (const child of current.node.children?.toReversed() ?? []) {
      pending.push({
        node: child,
        document: role === "iframe" ? current.node : document,
        documentUid: role === "iframe" ? undefined : documentUid,
      });
    }
  }
  return documents;
}

export function registerChromeMcpSnapshot(
  session: ChromeMcpSession,
  targetId: string,
  result: ChromeMcpToolResult,
): { root: ChromeMcpSnapshotNode; documentUid: string } {
  const root = extractSnapshot(result);
  const documentUid = normalizeOptionalString(root.id);
  if (!documentUid || root.role?.trim().toLowerCase() !== "rootwebarea") {
    throw new Error("Chrome MCP snapshot did not contain a top-level document uid");
  }
  const documents = validateChromeMcpSnapshotRefs(root);
  const routing = getChromeMcpRoutingState(session);
  const refs = new Map<string, { uid: string; documentUid?: string }>();

  // Validation collects aliases in snapshot order before claiming ref IDs.
  // Normalization created this operation-owned tree; rewrite all aliases together.
  for (const [uid, binding] of documents) {
    const id = `${CHROME_MCP_SNAPSHOT_REF_PREFIX}${routing.sessionNonce}:${routing.nextSnapshotRefId}`;
    routing.nextSnapshotRefId += 1;
    refs.set(id, { uid, documentUid: binding.documentUid });
    for (const node of binding.nodes) {
      node.id = id;
    }
  }
  routing.snapshotsByTarget.set(targetId, { documentUid, refs });
  return { root, documentUid };
}

export function resolveChromeMcpSnapshotRef(
  session: ChromeMcpSession,
  targetId: string,
  refId: string,
) {
  const resolved = getChromeMcpRoutingState(session)
    .snapshotsByTarget.get(targetId)
    ?.refs.get(refId);
  if (!resolved) {
    throw new Error(`Unknown ref "${refId}". Run a new snapshot and use a ref from that snapshot.`);
  }
  return resolved;
}

async function callTool(
  profileName: string,
  profileOptions: NormalizedChromeMcpProfileOptions,
  name: string,
  args: Record<string, unknown>,
  options: ChromeMcpCallOptions,
  lease: ChromeMcpSessionLease,
): Promise<ChromeMcpToolResult> {
  const timeoutMs = options.timeoutMs;
  const signal = options.signal;
  if (signal?.aborted) {
    throw signal.reason ?? new Error("aborted");
  }
  // SDK-owned cancellation removes its request correlation entry. An outer race would return
  // early while leaving the underlying MCP request pending after a target-browser crash.
  const request = { name, arguments: args };
  const rawCall = (
    (timeoutMs !== undefined && timeoutMs > 0) || signal
      ? lease.session.client.callTool(request, undefined, {
          ...(timeoutMs !== undefined && timeoutMs > 0 ? { timeout: timeoutMs } : {}),
          ...(signal ? { signal } : {}),
        })
      : lease.session.client.callTool(request)
  ) as Promise<ChromeMcpToolResult>;

  let result: ChromeMcpToolResult;
  try {
    result = await rawCall;
  } catch (err) {
    // Transport/connection error, timeout, or abort: tear down the cached session.
    if (!lease.temporary && lease.owner.isCurrent(lease.session)) {
      await lease.owner.close(lease.session);
    }
    if (signal?.aborted) {
      throw toErrorObject(signal.reason ?? err, "Non-Error abort reason");
    }
    if (timeoutMs && err instanceof McpError && err.code === MCP_REQUEST_TIMEOUT_CODE) {
      throw new Error(
        `Chrome MCP "${name}" timed out after ${timeoutMs}ms. Session reset for reconnect.`,
        { cause: err },
      );
    }
    throw err;
  }
  // Ordinary tool errors leave the session usable. A stale selected-page list
  // poisons it, so the outer pre-operation list may reconnect once.
  const message = extractChromeMcpToolError(result, name, args);
  if (message) {
    if (name === "list_pages" && message.includes(STALE_SELECTED_PAGE_ERROR)) {
      if (!lease.temporary && lease.owner.isCurrent(lease.session)) {
        await lease.owner.close(lease.session);
      }
      throw new ChromeMcpReconnectRequiredError(message);
    }
    throw new Error(
      formatChromeMcpToolErrorMessage({
        profileName,
        options: profileOptions,
        toolName: name,
        message,
      }),
    );
  }
  return result;
}

export async function callTargetTool(
  params: ChromeMcpTargetOperation,
  name: string,
  args: Record<string, unknown> | ((session: ChromeMcpSession) => Record<string, unknown>),
): Promise<ChromeMcpToolResult> {
  return await withChromeMcpTarget(params, async (target) => {
    const resolvedArgs = typeof args === "function" ? args(target.session) : args;
    return await target.callTool(name, { ...resolvedArgs, pageId: target.pageId });
  });
}

type ChromeMcpOperation = {
  session: ChromeMcpSession;
  profileOptions: NormalizedChromeMcpProfileOptions;
  callTool: (
    name: string,
    args: Record<string, unknown>,
    options?: ChromeMcpCallOptions,
  ) => Promise<ChromeMcpToolResult>;
  listTargets: (
    options?: ChromeMcpCallOptions,
  ) => Promise<Array<{ page: ChromeMcpStructuredPage; targetId: string }>>;
};

export type ChromeMcpPinnedTarget = ChromeMcpOperation & {
  pageId: number;
};

export async function withChromeMcpLease<T>(
  profileName: string,
  profileOptions: ChromeMcpOptionsInput | undefined,
  options: ChromeMcpCallOptions,
  operation: (operation: ChromeMcpOperation) => Promise<T>,
): Promise<T> {
  const normalizedProfileOptions = normalizeChromeMcpOptions(profileOptions);
  options.signal?.throwIfAborted();
  const lease = await getChromeMcpSessionOwner(profileName, normalizedProfileOptions).lease(
    options,
  );
  try {
    return await withChromeMcpOperationLock(lease.session, options, async () => {
      if (
        !lease.temporary &&
        (!lease.owner.isCurrent(lease.session) || lease.session.transport.pid === null)
      ) {
        throw new BrowserProfileUnavailableError(
          `Chrome MCP session for profile "${redactChromeMcpProfileLabelForDiagnostic(profileName)}" changed before the operation could start. Run the browser command again to reconnect.`,
        );
      }
      const call: ChromeMcpOperation["callTool"] = (name, args, callOptions = options) =>
        callTool(profileName, normalizedProfileOptions, name, args, callOptions, lease);
      return await operation({
        session: lease.session,
        profileOptions: normalizedProfileOptions,
        callTool: call,
        listTargets: async (callOptions = options) =>
          registerChromeMcpTargets(
            lease.session,
            extractStructuredPages(await call("list_pages", {}, callOptions)),
          ),
      });
    });
  } finally {
    await lease.release();
  }
}

export function registerChromeMcpTargets(
  session: ChromeMcpSession,
  pages: ChromeMcpStructuredPage[],
  options: { authoritative?: boolean } = {},
): Array<{ page: ChromeMcpStructuredPage; targetId: string }> {
  const routing = getChromeMcpRoutingState(session);
  const targetIdByPageId =
    options.authoritative === false ? new Map(routing.targetIdByPageId) : new Map<number, string>();
  const returnedPageIds = new Set<number>();
  const targets: Array<{ page: ChromeMcpStructuredPage; targetId: string }> = [];

  for (const page of pages) {
    if (returnedPageIds.has(page.id)) {
      throw new Error(`Chrome MCP returned duplicate numeric page id ${page.id}.`);
    }
    returnedPageIds.add(page.id);
    let targetId = routing.targetIdByPageId.get(page.id);
    if (!targetId) {
      targetId = `${CHROME_MCP_SESSION_TARGET_PREFIX}${routing.sessionNonce}:${routing.nextTargetHandleId}`;
      routing.nextTargetHandleId += 1;
    }
    targetIdByPageId.set(page.id, targetId);
    targets.push({ page, targetId });
  }
  for (const [pageId, targetId] of routing.targetIdByPageId) {
    if (!targetIdByPageId.has(pageId)) {
      routing.snapshotsByTarget.delete(targetId);
    }
  }
  routing.targetIdByPageId = targetIdByPageId;
  return targets;
}

export async function withChromeMcpTarget<T>(
  params: ChromeMcpTargetOperation,
  operation: (target: ChromeMcpPinnedTarget) => Promise<T>,
): Promise<T> {
  return await withChromeMcpLease(
    params.profileName,
    params.profile,
    params,
    async (sessionOperation) => {
      const routing = getChromeMcpRoutingState(sessionOperation.session);
      const pageId = [...routing.targetIdByPageId].find(
        ([, targetId]) => targetId === params.targetId,
      )?.[0];
      if (pageId === undefined) {
        throw new BrowserTabNotFoundError({ input: params.targetId });
      }
      return await operation({ ...sessionOperation, pageId });
    },
  );
}
