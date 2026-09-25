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
import {
  chromeMcpProfileOptionsFromParams,
  normalizeChromeMcpOptions,
} from "./chrome-mcp-options.js";
import {
  extractChromeMcpToolError,
  extractStructuredPages,
  formatChromeMcpToolErrorMessage,
  shouldReconnectForToolError,
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

export function clearChromeMcpSnapshotRefsForTarget(
  routing: ChromeMcpRoutingState,
  targetId: string,
): void {
  routing.snapshotsByTarget.delete(targetId);
}

function updateChromeMcpTargetMappings(
  routing: ChromeMcpRoutingState,
  targetIdByPageId: Map<number, string>,
): void {
  for (const [pageId, targetId] of routing.targetIdByPageId) {
    if (!targetIdByPageId.has(pageId)) {
      clearChromeMcpSnapshotRefsForTarget(routing, targetId);
    }
  }
  routing.targetIdByPageId = targetIdByPageId;
}

/** UID-only MCP actions cannot distinguish collisions between renderer documents. */
function validateChromeMcpSnapshotRefs(root: ChromeMcpSnapshotNode) {
  const documents = new Map<string, { document: ChromeMcpSnapshotNode; documentUid?: string }>();
  const pending = [{ node: root, document: root, documentUid: normalizeOptionalString(root.id) }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      break;
    }
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
      documents.set(uid, { document, documentUid });
    }
    for (const child of current.node.children ?? []) {
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
  root: ChromeMcpSnapshotNode,
): { root: ChromeMcpSnapshotNode; documentUid: string } {
  const documentUid = normalizeOptionalString(root.id);
  if (!documentUid || root.role?.trim().toLowerCase() !== "rootwebarea") {
    throw new Error("Chrome MCP snapshot did not contain a top-level document uid");
  }
  const documents = validateChromeMcpSnapshotRefs(root);
  const routing = getChromeMcpRoutingState(session);
  const wrappedByUid = new Map<string, string>();
  const refs = new Map<string, { uid: string; documentUid?: string }>();

  const wrapNode = (node: ChromeMcpSnapshotNode): ChromeMcpSnapshotNode => {
    const rawUid = normalizeOptionalString(node.id);
    let id: string | undefined;
    if (rawUid) {
      id = wrappedByUid.get(rawUid);
      if (!id) {
        id = `${CHROME_MCP_SNAPSHOT_REF_PREFIX}${routing.sessionNonce}:${routing.nextSnapshotRefId}`;
        routing.nextSnapshotRefId += 1;
        wrappedByUid.set(rawUid, id);
        refs.set(id, {
          uid: rawUid,
          documentUid: documents.get(rawUid)?.documentUid,
        });
      }
    }
    return {
      ...node,
      ...(id ? { id } : {}),
    };
  };

  // Keep ref rewriting iterative; the renderer owns depth truncation.
  let wrappedRoot: ChromeMcpSnapshotNode | undefined;
  const stack: Array<{
    source: ChromeMcpSnapshotNode;
    parent?: ChromeMcpSnapshotNode[];
    index?: number;
  }> = [{ source: root }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      break;
    }
    const wrapped = wrapNode(current.source);
    if (current.parent && current.index !== undefined) {
      current.parent[current.index] = wrapped;
    } else {
      wrappedRoot = wrapped;
    }
    const sourceChildren = current.source.children;
    if (!sourceChildren) {
      continue;
    }
    const wrappedChildren: ChromeMcpSnapshotNode[] = [];
    wrapped.children = wrappedChildren;
    for (let index = sourceChildren.length - 1; index >= 0; index -= 1) {
      const child = sourceChildren[index];
      if (child) {
        stack.push({ source: child, parent: wrappedChildren, index });
      }
    }
  }
  if (!wrappedRoot) {
    throw new Error("Chrome MCP snapshot did not contain a root node");
  }
  routing.snapshotsByTarget.set(targetId, { documentUid, refs });
  return { root: wrappedRoot, documentUid };
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

export async function callTool(
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
    if (shouldReconnectForToolError(name, message)) {
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
    const resolvedArgs = typeof args === "function" ? args(target.lease.session) : args;
    return await callTool(
      params.profileName,
      target.profileOptions,
      name,
      { ...resolvedArgs, pageId: target.pageId },
      params,
      target.lease,
    );
  });
}

export type ChromeMcpPinnedTarget = {
  lease: ChromeMcpSessionLease;
  profileOptions: NormalizedChromeMcpProfileOptions;
  pageId: number;
};

export async function withChromeMcpLease<T>(
  profileName: string,
  profileOptions: ChromeMcpOptionsInput | undefined,
  options: ChromeMcpCallOptions,
  operation: (
    lease: ChromeMcpSessionLease,
    normalizedProfileOptions: NormalizedChromeMcpProfileOptions,
  ) => Promise<T>,
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
      return await operation(lease, normalizedProfileOptions);
    });
  } finally {
    await lease.release();
  }
}

export async function listChromeMcpTargetsWithLease(params: {
  profileName: string;
  profileOptions: NormalizedChromeMcpProfileOptions;
  lease: ChromeMcpSessionLease;
  options: ChromeMcpCallOptions;
}): Promise<Array<{ page: ChromeMcpStructuredPage; targetId: string }>> {
  const result = await callTool(
    params.profileName,
    params.profileOptions,
    "list_pages",
    {},
    params.options,
    params.lease,
  );
  return registerChromeMcpTargets(params.lease.session, extractStructuredPages(result));
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
  updateChromeMcpTargetMappings(routing, targetIdByPageId);
  return targets;
}

export async function withChromeMcpTarget<T>(
  params: ChromeMcpTargetOperation,
  operation: (target: ChromeMcpPinnedTarget) => Promise<T>,
): Promise<T> {
  const profileOptions = chromeMcpProfileOptionsFromParams(params);
  return await withChromeMcpLease(
    params.profileName,
    profileOptions,
    params,
    async (lease, normalizedProfileOptions) => {
      const routing = getChromeMcpRoutingState(lease.session);
      const pageId = [...routing.targetIdByPageId].find(
        ([, targetId]) => targetId === params.targetId,
      )?.[0];
      if (pageId === undefined) {
        throw new BrowserTabNotFoundError({ input: params.targetId });
      }
      return await operation({
        lease,
        profileOptions: normalizedProfileOptions,
        pageId,
      });
    },
  );
}
