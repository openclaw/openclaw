import type { lookup as dnsLookupCb } from "node:dns";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { CdpProtocolSend, RawAXNode } from "./cdp-ax.js";
import { prepareCdpPageSession } from "./cdp-page-session.js";
import {
  buildRoleTree,
  renderRoleTree,
  type CdpRoleRef,
  type CursorInteractiveInfo,
  type RoleTreeNode,
} from "./cdp-role-snapshot-tree.js";
import { withCdpSocket } from "./cdp.helpers.js";
import {
  finalizeRoleSnapshot,
  type RoleSnapshotIdentityMode,
  type RoleSnapshotOptions,
  type RoleSnapshotResult,
} from "./pw-role-snapshot.js";
import { appendRoleSnapshotDepthTruncationMarker } from "./snapshot-depth-limit.js";
import { CONTENT_ROLES, INTERACTIVE_ROLES } from "./snapshot-roles.js";
import { appendSnapshotUrls, type SnapshotUrlEntry } from "./snapshot-urls.js";

async function findCursorInteractiveElements(
  send: CdpProtocolSend,
): Promise<Map<number, CursorInteractiveInfo>> {
  const attr = "data-openclaw-cdp-ci";
  try {
    const evaluated = (await send("Runtime.evaluate", {
      expression: `(() => {
          const out = [];
          const roles = new Set(${JSON.stringify([...INTERACTIVE_ROLES])});
          const tags = new Set(["a","button","input","select","textarea","details","summary"]);
          document.querySelectorAll("[${attr}]").forEach((el) => el.removeAttribute("${attr}"));
          for (const el of document.body ? document.body.querySelectorAll("*") : []) {
            if (!(el instanceof HTMLElement) || el.closest("[hidden],[aria-hidden='true']")) continue;
            const tagName = el.tagName.toLowerCase();
            if (tags.has(tagName)) continue;
            const role = String(el.getAttribute("role") || "").toLowerCase();
            if (roles.has(role)) continue;
            const style = getComputedStyle(el);
            const hasCursorPointer = style.cursor === "pointer";
            const hasOnClick = el.hasAttribute("onclick") || el.onclick !== null;
            const tabIndex = el.getAttribute("tabindex");
            const hasTabIndex = tabIndex !== null && tabIndex !== "-1";
            const ce = el.getAttribute("contenteditable");
            const isEditable = ce === "" || ce === "true";
            if (!hasCursorPointer && !hasOnClick && !hasTabIndex && !isEditable) continue;
            if (hasCursorPointer && !hasOnClick && !hasTabIndex && !isEditable) {
              const parent = el.parentElement;
              if (parent && getComputedStyle(parent).cursor === "pointer") continue;
            }
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;
            let hiddenInputType = "";
            const hiddenInput = el.querySelector("input[type='radio'],input[type='checkbox']");
            if (hiddenInput instanceof HTMLInputElement) {
              const hiddenStyle = getComputedStyle(hiddenInput);
              if (hiddenInput.hidden || hiddenStyle.display === "none" || hiddenStyle.visibility === "hidden") {
                hiddenInputType = hiddenInput.type;
              }
            }
            el.setAttribute("${attr}", String(out.length));
            out.push({
              text: String(el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 101),
              hasCursorPointer,
              hasOnClick,
              hasTabIndex,
              isEditable,
              hiddenInputType,
            });
          }
          return out;
        })()`,
      returnByValue: true,
      awaitPromise: false,
    }).catch(() => null)) as { result?: { value?: unknown } } | null; // SAFETY: Runtime returns a RemoteObject result; its page-derived by-value data is validated below.
    const values: unknown[] = Array.isArray(evaluated?.result?.value) ? evaluated.result.value : [];
    const entries: (CursorInteractiveInfo | undefined)[] = values.map((value) => {
      const entry = asOptionalRecord(value);
      if (typeof entry?.text !== "string") {
        return undefined;
      }
      return {
        text: truncateUtf16Safe(entry.text, 100),
        hasOnClick: entry.hasOnClick === true,
        hasCursorPointer: entry.hasCursorPointer === true,
        hasTabIndex: entry.hasTabIndex === true,
        isEditable: entry.isEditable === true,
        hiddenInputType:
          typeof entry.hiddenInputType === "string" ? entry.hiddenInputType : undefined,
      };
    });
    if (!entries.some((entry) => entry !== undefined)) {
      return new Map();
    }

    const documentResult = await send("DOM.getDocument", { depth: 0 }).catch(() => null);
    // SAFETY: DOM.getDocument returns its root DOM.Node; nodeId is checked before use.
    const doc = documentResult as {
      root?: { nodeId?: number };
    } | null;
    const rootNodeId = doc?.root?.nodeId;
    if (typeof rootNodeId !== "number") {
      return new Map();
    }
    const queried = (await send("DOM.querySelectorAll", {
      nodeId: rootNodeId,
      selector: `[${attr}]`,
    }).catch(() => null)) as { nodeIds?: number[] } | null; // SAFETY: DOM.querySelectorAll returns browser-owned integer NodeIds.
    const out = new Map<number, CursorInteractiveInfo>();
    await Promise.all(
      (queried?.nodeIds ?? []).map(async (nodeId) => {
        // SAFETY: DOM.describeNode returns native node identity and alternating string attributes.
        const described = (await send("DOM.describeNode", { nodeId }).catch(() => null)) as {
          node?: { backendNodeId?: number; attributes?: string[] };
        } | null;
        const attrs = described?.node?.attributes ?? [];
        const attrIndex = attrs.indexOf(attr);
        const rawIndex = attrIndex >= 0 ? attrs[attrIndex + 1] : undefined;
        const index = typeof rawIndex === "string" ? Number(rawIndex) : Number.NaN;
        const backendNodeId = described?.node?.backendNodeId;
        if (typeof backendNodeId === "number" && Number.isInteger(index) && entries[index]) {
          out.set(backendNodeId, entries[index]);
        }
      }),
    );
    return out;
  } finally {
    await send("Runtime.evaluate", {
      expression: `document.querySelectorAll("[${attr}]").forEach((el) => el.removeAttribute("${attr}"))`,
      returnByValue: true,
    }).catch(() => {});
  }
}

async function resolveLinkUrls(
  send: CdpProtocolSend,
  refs: Record<string, CdpRoleRef>,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const linkRefs = Object.values(refs).filter(
    (ref): ref is CdpRoleRef & { backendDOMNodeId: number } =>
      ref.role === "link" && Boolean(ref.backendDOMNodeId),
  );
  await Promise.all(
    linkRefs.map(async (ref) => {
      const resolved = (await send("DOM.resolveNode", {
        backendNodeId: ref.backendDOMNodeId,
      }).catch(() => null)) as { object?: { objectId?: string } } | null; // SAFETY: DOM.resolveNode returns a RemoteObject; its objectId is required below.
      const objectId = resolved?.object?.objectId;
      if (!objectId) {
        return;
      }
      const hrefResult = (await send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function() { return this.href || ''; }",
        returnByValue: true,
      }).catch(() => null)) as { result?: { value?: unknown } } | null; // SAFETY: Runtime returns a RemoteObject result; its page-derived by-value data is validated below.
      const href = typeof hrefResult?.result?.value === "string" ? hrefResult.result.value : "";
      if (href) {
        out.set(ref.backendDOMNodeId, href);
      }
    }),
  );
  return out;
}

async function resolveIframeFrameIds(
  send: CdpProtocolSend,
  tree: RoleTreeNode[],
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const iframeNodes = tree.filter(
    (node): node is RoleTreeNode & { backendDOMNodeId: number } =>
      node.role.toLowerCase() === "iframe" && Boolean(node.backendDOMNodeId),
  );
  await Promise.all(
    iframeNodes.map(async (node) => {
      const description = await send("DOM.describeNode", {
        backendNodeId: node.backendDOMNodeId,
        depth: 1,
      }).catch(() => null);
      // SAFETY: DOM.describeNode includes optional native frameId and contentDocument metadata.
      const described = description as {
        node?: { frameId?: string; contentDocument?: { frameId?: string } };
      } | null;
      const frameId = described?.node?.contentDocument?.frameId ?? described?.node?.frameId ?? "";
      if (frameId) {
        out.set(node.backendDOMNodeId, frameId);
      }
    }),
  );
  return out;
}

async function readScopedAXNodes(
  send: CdpProtocolSend,
  backendNodeId: number,
): Promise<RawAXNode[]> {
  // Chromium queryAXTree omits an ignored root, including its visible descendants.
  // SAFETY: queryAXTree returns native AXNodes in its protocol-defined nodes array.
  const queried = (await send("Accessibility.queryAXTree", { backendNodeId })) as {
    nodes: RawAXNode[];
  };
  if (queried.nodes.some((node) => node.backendDOMNodeId === backendNodeId)) {
    return queried.nodes;
  }
  const partial = (await send("Accessibility.getPartialAXTree", {
    backendNodeId,
    fetchRelatives: true,
  })) as { nodes: RawAXNode[] }; // SAFETY: getPartialAXTree returns native AXNodes and their ancestors.
  const root = partial.nodes.find((node) => node.backendDOMNodeId === backendNodeId);
  if (!root?.ignored || !root.nodeId) {
    throw new Error("Snapshot root is no longer present in the accessibility tree; retry.");
  }
  if (!root.childIds?.length) {
    return [root];
  }
  const frameId = partial.nodes.find((node) => node.frameId)?.frameId;
  if (!frameId) {
    throw new Error("Snapshot frame identity is unavailable; retry.");
  }
  // SAFETY: getFullAXTree returns native AXNodes for the identified frame.
  const full = (await send("Accessibility.getFullAXTree", { frameId })) as {
    nodes: RawAXNode[];
  };
  const byId = new Map(full.nodes.map((node) => [node.nodeId, node]));
  const nodes = [root];
  const included = new Set([root.nodeId]);
  for (const node of nodes) {
    for (const id of node.childIds ?? []) {
      const child = byId.get(id);
      if (child && !included.has(id)) {
        included.add(id);
        nodes.push(child);
      }
    }
  }
  return nodes;
}

async function buildCdpRoleSnapshot(params: {
  send: CdpProtocolSend;
  rootBackendNodeId?: number;
  frameId?: string;
  options: RoleSnapshotOptions;
  urls?: boolean;
  recurseIframes?: boolean;
  nextRef: { value: number };
}): Promise<{
  lines: string[];
  refs: Record<string, CdpRoleRef>;
  truncated: boolean;
}> {
  const res =
    params.rootBackendNodeId !== undefined
      ? { nodes: await readScopedAXNodes(params.send, params.rootBackendNodeId) }
      : ((await params.send(
          "Accessibility.getFullAXTree",
          params.frameId ? { frameId: params.frameId } : undefined,
        )) as { nodes?: RawAXNode[] }); // SAFETY: Accessibility commands return native AXNode arrays.
  const { tree, roots } = buildRoleTree(
    Array.isArray(res.nodes) ? res.nodes : [],
    params.rootBackendNodeId,
  );
  // Scoped captures preserve role-snapshot membership; page-wide cursor discovery
  // would add controls outside the selected root or from another frame.
  const cursorElements =
    params.rootBackendNodeId !== undefined
      ? new Map<number, CursorInteractiveInfo>()
      : await findCursorInteractiveElements(params.send);
  for (const node of tree) {
    if (node.backendDOMNodeId && cursorElements.has(node.backendDOMNodeId)) {
      const cursorInfo = cursorElements.get(node.backendDOMNodeId);
      node.cursorInfo = cursorInfo;
      if (!node.name && cursorInfo?.text) {
        node.name = cursorInfo.text;
      }
    }
  }

  const counts = new Map<string, number>();
  const refs: Record<string, CdpRoleRef> = {};
  for (const node of tree) {
    const role = node.role.toLowerCase();
    const shouldRef =
      INTERACTIVE_ROLES.has(role) ||
      (CONTENT_ROLES.has(role) && Boolean(node.name)) ||
      role === "iframe" ||
      Boolean(node.cursorInfo);
    if (!shouldRef || node.transparent) {
      continue;
    }
    const key = `${role}:${node.name}`;
    const nth = counts.get(key) ?? 0;
    counts.set(key, nth + 1);
    const ref = `e${params.nextRef.value}`;
    params.nextRef.value += 1;
    node.ref = ref;
    node.nth = nth;
    refs[ref] = {
      role,
      ...(node.name ? { name: node.name } : {}),
      nth,
      ...(node.backendDOMNodeId ? { backendDOMNodeId: node.backendDOMNodeId } : {}),
      ...(params.frameId ? { frameId: params.frameId } : {}),
    };
  }
  for (const node of tree) {
    if (node.ref && counts.get(`${node.role.toLowerCase()}:${node.name}`) === 1) {
      delete refs[node.ref]?.nth;
    }
  }

  const iframeFrameIds = await resolveIframeFrameIds(params.send, tree);
  for (const node of tree) {
    if (node.backendDOMNodeId && iframeFrameIds.has(node.backendDOMNodeId)) {
      node.frameId = iframeFrameIds.get(node.backendDOMNodeId);
      const ref = node.ref ? refs[node.ref] : undefined;
      if (ref) {
        ref.frameId = node.frameId;
      }
    }
  }

  if (params.urls) {
    const urls = await resolveLinkUrls(params.send, refs);
    for (const node of tree) {
      if (node.backendDOMNodeId && urls.has(node.backendDOMNodeId)) {
        node.url = urls.get(node.backendDOMNodeId);
      }
    }
  }

  let lines: string[] = [];
  const renderState = {
    truncated: false,
    recordIframePositions: params.recurseIframes,
    flattenInteractive: params.rootBackendNodeId !== undefined,
  };
  for (const root of roots) {
    renderRoleTree(tree, root, lines, params.options, renderState);
  }

  if (params.recurseIframes) {
    const childLinesByIndex = new Map<number, string[]>();
    for (const iframe of tree) {
      if (iframe.iframeLineIndex === undefined || !iframe.frameId) {
        continue;
      }
      const child = await buildCdpRoleSnapshot({
        ...params,
        frameId: iframe.frameId,
        recurseIframes: false,
      }).catch(() => null);
      if (!child) {
        continue;
      }
      renderState.truncated ||= child.truncated;
      if (!child.lines.length) {
        continue;
      }
      Object.assign(refs, child.refs);
      childLinesByIndex.set(iframe.iframeLineIndex, child.lines);
    }
    lines = lines.flatMap((line, index) => [
      line,
      ...(childLinesByIndex.get(index) ?? []).map((childLine) => `  ${childLine}`),
    ]);
  }

  return {
    lines,
    refs,
    truncated: renderState.truncated,
  };
}

type CdpRoleSnapshotRequest = {
  urlEntries?: SnapshotUrlEntry[];
  options?: RoleSnapshotOptions;
  urls?: boolean;
  recurseIframes?: boolean;
  timeoutMs?: number;
  maxChars?: number;
  delta?: { mode: RoleSnapshotIdentityMode; previousKeys?: ReadonlySet<string> };
};

/** Capture and format refs with their backend identities on the caller-owned CDP session. */
export async function snapshotRoleViaCdpSession(
  opts: CdpRoleSnapshotRequest & {
    send: CdpProtocolSend;
    rootBackendNodeId?: number;
  },
): Promise<RoleSnapshotResult<CdpRoleRef>> {
  await prepareCdpPageSession(opts.send);
  const built = await buildCdpRoleSnapshot({
    send: opts.send,
    rootBackendNodeId: opts.rootBackendNodeId,
    options: opts.options ?? {},
    urls: opts.urls,
    recurseIframes: opts.recurseIframes ?? true,
    nextRef: { value: 1 },
  });
  const renderedSnapshot =
    built.lines.join("\n").trim() ||
    (opts.options?.interactive
      ? "(no interactive elements)"
      : opts.rootBackendNodeId !== undefined
        ? "(empty)"
        : "(empty page)");
  const finalized = finalizeRoleSnapshot({
    snapshot: appendSnapshotUrls(
      built.truncated
        ? appendRoleSnapshotDepthTruncationMarker(renderedSnapshot)
        : renderedSnapshot,
      opts.urlEntries ?? [],
    ),
    refs: built.refs,
    maxChars: opts.maxChars,
    delta: opts.delta,
  });
  return built.truncated && !finalized.truncated ? { ...finalized, truncated: true } : finalized;
}

export async function snapshotRoleViaCdp(
  opts: CdpRoleSnapshotRequest & {
    wsUrl: string;
    lookup?: typeof dnsLookupCb;
  },
) {
  return await withCdpSocket(
    opts.wsUrl,
    async (send) => await snapshotRoleViaCdpSession({ ...opts, send }),
    { commandTimeoutMs: opts.timeoutMs ?? 5000, lookup: opts.lookup },
  );
}
