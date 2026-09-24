import { randomUUID } from "node:crypto";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  takeChromeMcpScreenshotOnTarget,
  type ChromeMcpScreenshotOptions,
} from "./chrome-mcp-actions.js";
import {
  ChromeMcpDocumentUnavailableError,
  rethrowChromeMcpDocumentError,
} from "./chrome-mcp-contracts.js";
import { extractJsonMessage } from "./chrome-mcp-result.js";
import {
  callTool,
  resolveChromeMcpSnapshotRef,
  withChromeMcpTarget,
} from "./chrome-mcp-routing.js";
import {
  evaluateChromeMcpScript,
  type ChromeMcpOperationOptions,
  type ChromeMcpProfileOptions,
} from "./chrome-mcp.js";
import type { SnapshotUrlEntry } from "./snapshot-urls.js";

const CHROME_MCP_OVERLAY_ATTR = "data-openclaw-mcp-overlay";

export type ChromeMcpSnapshotOperation = ChromeMcpOperationOptions & {
  profileName: string;
  profile?: ChromeMcpProfileOptions;
  userDataDir?: string;
  targetId: string;
};

export async function collectChromeMcpSnapshotUrls(
  params: ChromeMcpSnapshotOperation,
): Promise<SnapshotUrlEntry[]> {
  const result = await evaluateChromeMcpScript({
    ...params,
    fn: `() => {
      const seen = new Set();
      const out = [];
      for (const anchor of document.querySelectorAll("a[href]")) {
        const href = anchor.href || "";
        if (!href || seen.has(href)) continue;
        const text = (anchor.innerText || anchor.textContent || anchor.getAttribute("aria-label") || "")
          .replace(/\\s+/g, " ")
          .trim()
          .slice(0, 121) || href;
        seen.add(href);
        out.push({ text, url: href });
        if (out.length >= 100) break;
      }
      return out;
    }`,
  }).catch(() => []);
  return Array.isArray(result)
    ? result
        .filter(
          (entry: unknown): entry is { text: string; url: string } =>
            isRecord(entry) && typeof entry.text === "string" && typeof entry.url === "string",
        )
        .map((entry) => {
          entry.text = truncateUtf16Safe(entry.text, 120) || entry.url;
          return entry;
        })
    : [];
}

/** Keep labels, capture, and document cleanup in one target operation. */
export async function withChromeMcpLabels<T>(
  params: ChromeMcpSnapshotOperation & { refs: string[]; clipToRef?: boolean },
  capture: (
    labels: { labels: number; skipped: number },
    screenshot: (options: ChromeMcpScreenshotOptions) => Promise<Buffer>,
  ) => Promise<T>,
): Promise<T> {
  return await withChromeMcpTarget(params, async (target) => {
    const documents = new Map<string, { refs: string[]; uids: string[] }>();
    for (const ref of params.refs) {
      const binding = resolveChromeMcpSnapshotRef(target.lease.session, params.targetId, ref);
      if (!binding.documentUid) {
        throw new Error(
          "Snapshot ref has no owning document. Take a new snapshot before labeling.",
        );
      }
      let group = documents.get(binding.documentUid);
      if (!group) {
        group = { refs: [], uids: [] };
        documents.set(binding.documentUid, group);
      }
      group.refs.push(ref);
      group.uids.push(binding.uid);
    }
    const token = randomUUID();
    const touchedDocuments: string[] = [];
    const evaluate = async (documentUid: string, fn: string, uids: string[] = []) => {
      try {
        return extractJsonMessage(
          await callTool(
            params.profileName,
            target.profileOptions,
            "evaluate_script",
            { pageId: target.pageId, function: fn, args: [documentUid, ...uids] },
            // Once dispatched, label mutations must settle before their document is cleaned.
            { timeoutMs: params.timeoutMs },
            target.lease,
          ),
        );
      } catch (error) {
        return rethrowChromeMcpDocumentError(error);
      }
    };
    let labels = 0;
    let captured: T;
    let cleanup: PromiseSettledResult<unknown>[];
    try {
      for (const [documentUid, group] of documents) {
        params.signal?.throwIfAborted();
        touchedDocuments.push(documentUid);
        const count = await evaluate(
          documentUid,
          `(documentRoot, ...elements) => {
          const doc = documentRoot.nodeType === 9 ? documentRoot : documentRoot.ownerDocument;
          const refs = ${JSON.stringify(group.refs)};
          const clipToRef = ${params.clipToRef === true};
          if (clipToRef && elements[0] instanceof Element) {
            elements[0].scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
          }
          const root = doc.createElement("div");
          root.setAttribute("${CHROME_MCP_OVERLAY_ATTR}", ${JSON.stringify(token)});
          root.style.position = "fixed";
          root.style.inset = "0";
          root.style.pointerEvents = "none";
          root.style.zIndex = "2147483647";
          let labels = 0;
          elements.forEach((el, index) => {
            if (!(el instanceof Element)) return;
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return;
            labels += 1;
            const badge = doc.createElement("div");
            badge.setAttribute("${CHROME_MCP_OVERLAY_ATTR}", "label");
            badge.textContent = refs[index];
            badge.style.position = "fixed";
            badge.style.left = \`\${Math.max(0, rect.left)}px\`;
            badge.style.top = \`\${Math.max(0, rect.top + (clipToRef ? 2 : 0))}px\`;
            badge.style.transform = clipToRef ? "none" : "translateY(-100%)";
            badge.style.padding = "2px 6px";
            badge.style.borderRadius = "999px";
            badge.style.background = "#FF4500";
            badge.style.color = "#fff";
            badge.style.font = "600 12px ui-monospace, SFMono-Regular, Menlo, monospace";
            badge.style.boxShadow = "0 2px 6px rgba(0,0,0,0.35)";
            badge.style.whiteSpace = "nowrap";
            root.appendChild(badge);
          });
          doc.documentElement.appendChild(root);
          return labels;
        }`,
          group.uids,
        );
        if (typeof count !== "number") {
          throw new Error("Chrome MCP label rendering returned an invalid count");
        }
        labels += count;
      }
      params.signal?.throwIfAborted();
      captured = await capture(
        { labels, skipped: params.refs.length - labels },
        async (options) => {
          params.signal?.throwIfAborted();
          const buffer = await takeChromeMcpScreenshotOnTarget(
            { ...params, ...options, signal: undefined },
            target,
          );
          params.signal?.throwIfAborted();
          return buffer;
        },
      );
    } finally {
      cleanup = await Promise.allSettled(
        touchedDocuments.map((documentUid) =>
          evaluate(
            documentUid,
            `(documentRoot) => {
          const doc = documentRoot.nodeType === 9 ? documentRoot : documentRoot.ownerDocument;
          doc.querySelectorAll('[${CHROME_MCP_OVERLAY_ATTR}="${token}"]').forEach((node) => node.remove());
        }`,
          ),
        ),
      );
    }
    for (const result of cleanup) {
      // Navigation or frame removal already discarded that document's overlay.
      if (
        result.status === "rejected" &&
        !(result.reason instanceof ChromeMcpDocumentUnavailableError)
      ) {
        throw toErrorObject(result.reason, "Chrome MCP label cleanup failed");
      }
    }
    return captured;
  });
}
