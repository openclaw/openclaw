import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { CdpProtocolSend } from "./cdp-ax.js";
import type { CdpRoleRef, CursorInteractiveInfo, RoleTreeNode } from "./cdp-role-snapshot-tree.js";

export async function findCursorInteractiveElements(
  send: CdpProtocolSend,
  sessionId?: string,
): Promise<Map<number, CursorInteractiveInfo>> {
  const attr = "data-openclaw-cdp-ci";
  try {
    const evaluated = (await send(
      "Runtime.evaluate",
      {
        expression: `(() => {
          const out = [];
          const roles = new Set(["button","link","textbox","checkbox","radio","combobox","listbox","menuitem","menuitemcheckbox","menuitemradio","option","searchbox","slider","spinbutton","switch","tab","treeitem"]);
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
              tagName,
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
      },
      sessionId,
    ).catch(() => null)) as { result?: { value?: unknown } } | null; // SAFETY: Runtime returns a RemoteObject result; its page-derived by-value data is validated below.
    const values: unknown[] = Array.isArray(evaluated?.result?.value) ? evaluated.result.value : [];
    const entries: (CursorInteractiveInfo | undefined)[] = values.map((value) => {
      const entry = asOptionalRecord(value);
      if (typeof entry?.text !== "string" || typeof entry.tagName !== "string") {
        return undefined;
      }
      return {
        text: truncateUtf16Safe(entry.text, 100),
        tagName: entry.tagName,
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

    const documentResult = await send("DOM.getDocument", { depth: 0 }, sessionId).catch(() => null);
    // SAFETY: DOM.getDocument returns its root DOM.Node; nodeId is checked before use.
    const doc = documentResult as {
      root?: { nodeId?: number };
    } | null;
    const rootNodeId = doc?.root?.nodeId;
    if (typeof rootNodeId !== "number") {
      return new Map();
    }
    const queried = (await send(
      "DOM.querySelectorAll",
      { nodeId: rootNodeId, selector: `[${attr}]` },
      sessionId,
    ).catch(() => null)) as { nodeIds?: number[] } | null; // SAFETY: DOM.querySelectorAll returns browser-owned integer NodeIds.
    const out = new Map<number, CursorInteractiveInfo>();
    await Promise.all(
      (queried?.nodeIds ?? []).map(async (nodeId) => {
        const described = (await send("DOM.describeNode", { nodeId }, sessionId).catch(
          () => null,
        )) as { node?: { backendNodeId?: number; attributes?: string[] } } | null; // SAFETY: DOM.describeNode returns native node identity and alternating string attributes.
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
    await send(
      "Runtime.evaluate",
      {
        expression: `document.querySelectorAll("[${attr}]").forEach((el) => el.removeAttribute("${attr}"))`,
        returnByValue: true,
      },
      sessionId,
    ).catch(() => {});
  }
}

export async function resolveLinkUrls(
  send: CdpProtocolSend,
  refs: Record<string, CdpRoleRef>,
  sessionId?: string,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const linkRefs = Object.values(refs).filter(
    (ref): ref is CdpRoleRef & { backendDOMNodeId: number } =>
      ref.role === "link" && Boolean(ref.backendDOMNodeId),
  );
  await Promise.all(
    linkRefs.map(async (ref) => {
      const resolved = (await send(
        "DOM.resolveNode",
        { backendNodeId: ref.backendDOMNodeId },
        sessionId,
      ).catch(() => null)) as { object?: { objectId?: string } } | null; // SAFETY: DOM.resolveNode returns a RemoteObject; its objectId is required below.
      const objectId = resolved?.object?.objectId;
      if (!objectId) {
        return;
      }
      const hrefResult = (await send(
        "Runtime.callFunctionOn",
        {
          objectId,
          functionDeclaration: "function() { return this.href || ''; }",
          returnByValue: true,
        },
        sessionId,
      ).catch(() => null)) as { result?: { value?: unknown } } | null; // SAFETY: Runtime returns a RemoteObject result; its page-derived by-value data is validated below.
      const href = typeof hrefResult?.result?.value === "string" ? hrefResult.result.value : "";
      if (href) {
        out.set(ref.backendDOMNodeId, href);
      }
    }),
  );
  return out;
}

export async function resolveIframeFrameIds(
  send: CdpProtocolSend,
  tree: RoleTreeNode[],
  sessionId?: string,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const iframeNodes = tree.filter(
    (node): node is RoleTreeNode & { backendDOMNodeId: number } =>
      node.role.toLowerCase() === "iframe" && Boolean(node.backendDOMNodeId),
  );
  await Promise.all(
    iframeNodes.map(async (node) => {
      const description = await send(
        "DOM.describeNode",
        { backendNodeId: node.backendDOMNodeId, depth: 1 },
        sessionId,
      ).catch(() => null);
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
