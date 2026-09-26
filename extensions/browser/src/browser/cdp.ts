import type { lookup as dnsLookupCb } from "node:dns";
/**
 * Chrome DevTools Protocol browser operations.
 *
 * Provides screenshots, target creation, JavaScript evaluation, ARIA/role
 * snapshots, DOM text, and selector lookup on top of the CDP socket helpers.
 */
import { resolveIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import type { SsrFPolicy } from "openclaw/plugin-sdk/security-runtime";
import { axValue, type AriaSnapshotNode, type RawAXNode } from "./cdp-ax.js";
import {
  prepareCdpPageSession,
  prepareCdpTargetSession,
  readCdpDocumentIdentities,
  type CdpActionTimeouts,
  type CdpDocumentIdentities,
} from "./cdp-page-session.js";
import {
  appendCdpPath,
  assertCdpEndpointAllowed,
  fetchJson,
  isDirectCdpWebSocketEndpoint,
  isWebSocketUrl,
  normalizeCdpHttpBaseForJsonEndpoints,
  normalizeCdpWsUrl,
  scopeCdpPolicyToConfiguredEndpoint,
  withCdpSocket,
} from "./cdp.helpers.js";
import { assertBrowserNavigationAllowed, withBrowserNavigationPolicy } from "./navigation-guard.js";

export { appendCdpPath, normalizeCdpWsUrl } from "./cdp.helpers.js";
export type { AriaSnapshotNode, RawAXNode } from "./cdp-ax.js";
export { snapshotRoleViaCdp } from "./cdp-role-snapshot.js";
export { type CdpActionTimeouts, waitForCdpCommittedNavigationUrl } from "./cdp-page-session.js";

/** Read committed document identities from a page-level CDP target. */
export async function getDocumentIdentitiesViaCdp(opts: {
  wsUrl: string;
  lookup?: typeof dnsLookupCb;
  timeoutMs?: number;
}): Promise<CdpDocumentIdentities> {
  return await withCdpSocket(opts.wsUrl, async (send) => await readCdpDocumentIdentities(send), {
    commandTimeoutMs: opts.timeoutMs ?? 5000,
    ...(opts.lookup ? { lookup: opts.lookup } : {}),
  });
}

/** Capture a PNG or JPEG screenshot through CDP, optionally full-page. */
export async function captureScreenshot(opts: {
  wsUrl: string;
  lookup?: typeof dnsLookupCb;
  fullPage?: boolean;
  format?: "png" | "jpeg";
  quality?: number; // jpeg only (0..100)
  timeoutMs?: number;
  /** Effective launch mode recorded on the owned Chrome process, when known. */
  headless?: boolean;
}): Promise<Buffer> {
  return await withCdpSocket(
    opts.wsUrl,
    async (send) => {
      await send("Page.enable");

      // Headless background tabs need activation to produce a frame. Preserve
      // focus only when the browser process is authoritatively known headed.
      if (opts.headless !== false) {
        await send("Page.bringToFront").catch(() => {});
      }

      const format = opts.format ?? "png";
      const quality =
        format === "jpeg" ? Math.max(0, Math.min(100, Math.round(opts.quality ?? 85))) : undefined;

      // This path has no Playwright viewport owner. Chromium captures the whole
      // document without changing its layout; emulated pages use their owner session.
      const result = (await send("Page.captureScreenshot", {
        format,
        ...(quality !== undefined ? { quality } : {}),
        ...(opts.fullPage ? { captureBeyondViewport: true } : {}),
      })) as { data?: string };

      const base64 = result?.data;
      if (!base64) {
        throw new Error("Screenshot failed: missing data");
      }
      return Buffer.from(base64, "base64");
    },
    { commandTimeoutMs: opts.timeoutMs, lookup: opts.lookup },
  );
}

/** Create a new browser target after applying navigation and CDP SSRF policy. */
export async function createTargetViaCdp(opts: {
  cdpUrl: string;
  url: string;
  ssrfPolicy?: SsrFPolicy;
  timeouts?: CdpActionTimeouts;
  signal?: AbortSignal;
  /** Wait for the created document to finish navigation and return its authoritative URL. */
  waitForNavigationResult?: boolean;
}): Promise<{ targetId: string; finalUrl?: string }> {
  opts.signal?.throwIfAborted();
  await assertBrowserNavigationAllowed({
    url: opts.url,
    ...withBrowserNavigationPolicy(opts.ssrfPolicy),
  });
  const configuredCdpPin = await assertCdpEndpointAllowed(opts.cdpUrl, opts.ssrfPolicy);
  const cdpControlPolicy = scopeCdpPolicyToConfiguredEndpoint(opts.cdpUrl, opts.ssrfPolicy);

  let wsUrl: string;
  if (isDirectCdpWebSocketEndpoint(opts.cdpUrl)) {
    // Handshake-ready direct WebSocket URL — skip /json/version discovery.
    wsUrl = opts.cdpUrl;
  } else {
    // Either an HTTP(S) CDP endpoint or a bare ws/wss root. Try
    // /json/version discovery first. For bare ws/wss URLs, fall back to
    // using the URL itself as a direct WS endpoint when discovery is
    // unavailable — some providers (e.g. Browserless/Browserbase) expose
    // a direct WebSocket root without a /json/version route.
    const discoveryUrl = isWebSocketUrl(opts.cdpUrl)
      ? normalizeCdpHttpBaseForJsonEndpoints(opts.cdpUrl)
      : opts.cdpUrl;
    let version: { webSocketDebuggerUrl?: string } | null = null;
    try {
      version = await fetchJson<{ webSocketDebuggerUrl?: string }>(
        appendCdpPath(discoveryUrl, "/json/version"),
        opts.timeouts?.httpTimeoutMs,
        { signal: opts.signal },
        cdpControlPolicy,
      );
    } catch (err) {
      // Discovery failed for an HTTP/HTTPS URL — propagate immediately.
      if (!isWebSocketUrl(opts.cdpUrl)) {
        throw err;
      }
      // For bare ws/wss URLs, fall through: /json/version is unavailable
      // so we attempt to use opts.cdpUrl as a direct WS endpoint below.
    }
    const wsUrlRaw = version?.webSocketDebuggerUrl?.trim() ?? "";
    if (wsUrlRaw) {
      wsUrl = normalizeCdpWsUrl(wsUrlRaw, discoveryUrl);
    } else if (isWebSocketUrl(opts.cdpUrl)) {
      // /json/version unavailable or returned no WebSocket URL. Treat the
      // original URL as a direct WebSocket endpoint.
      wsUrl = opts.cdpUrl;
    } else {
      throw new Error("CDP /json/version missing webSocketDebuggerUrl");
    }
  }

  const candidateWsUrls =
    isWebSocketUrl(opts.cdpUrl) && wsUrl !== opts.cdpUrl ? [wsUrl, opts.cdpUrl] : [wsUrl];
  let lastError: unknown;
  for (const candidateWsUrl of candidateWsUrls) {
    try {
      const endpointSource =
        candidateWsUrl === opts.cdpUrl
          ? ({ source: "configured" } as const)
          : ({ source: "discovered", configuredUrl: opts.cdpUrl } as const);
      const candidateCdpPin =
        candidateWsUrl === opts.cdpUrl
          ? configuredCdpPin
          : await assertCdpEndpointAllowed(candidateWsUrl, cdpControlPolicy, endpointSource);
      opts.signal?.throwIfAborted();
      return await withCdpSocket(
        candidateWsUrl,
        async (send) => {
          opts.signal?.throwIfAborted();
          const params = { url: opts.url, background: true }; // Target-id selection must not activate browser UI.
          const created = (await send("Target.createTarget", params)) as { targetId?: string };
          const targetId = created?.targetId?.trim() ?? "";
          if (!targetId) {
            throw new Error("CDP Target.createTarget returned no targetId");
          }
          try {
            opts.signal?.throwIfAborted();
            const finalUrl = await prepareCdpTargetSession(
              send,
              targetId,
              opts.waitForNavigationResult ? opts.url : undefined,
              opts.signal,
            );
            opts.signal?.throwIfAborted();
            return finalUrl ? { targetId, finalUrl } : { targetId };
          } catch (error) {
            // The caller cannot compensate until it receives this id. Keep cleanup
            // on the creating socket, independent of cancellation, before releasing it.
            await send("Target.closeTarget", { targetId }).catch(() => {});
            throw error;
          }
        },
        {
          commandTimeoutMs: opts.timeouts?.httpTimeoutMs ?? 5000,
          handshakeTimeoutMs: opts.timeouts?.handshakeTimeoutMs,
          lookup: candidateCdpPin?.lookup,
        },
      );
    } catch (err) {
      opts.signal?.throwIfAborted();
      lastError = err;
    }
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error("CDP Target.createTarget failed");
}

/** Prefix assigned to generated accessibility-node refs. */
const AX_REF_PREFIX = "ax";
export const AX_REF_PATTERN = new RegExp(`^${AX_REF_PREFIX}\\d+$`);

/** Format raw AX nodes into bounded ARIA snapshot nodes. */
export function formatAriaSnapshot(nodes: RawAXNode[], limit: number): AriaSnapshotNode[] {
  const byId = new Map<string, RawAXNode>();
  for (const n of nodes) {
    if (n.nodeId) {
      byId.set(n.nodeId, n);
    }
  }

  // Heuristic: pick a root-ish node (one that is not referenced as a child), else first.
  const referenced = new Set<string>();
  for (const n of nodes) {
    for (const c of n.childIds ?? []) {
      referenced.add(c);
    }
  }
  const root = nodes.find((n) => n.nodeId && !referenced.has(n.nodeId)) ?? nodes[0];
  if (!root?.nodeId) {
    return [];
  }

  const out: AriaSnapshotNode[] = [];
  const stack: Array<{ node: RawAXNode; depth: number }> = [
    { node: byId.get(root.nodeId)!, depth: 0 },
  ];
  while (stack.length && out.length < limit) {
    const { node: n, depth } = stack.pop()!;
    const role = axValue(n.role);
    const name = axValue(n.name);
    const value = axValue(n.value);
    const description = axValue(n.description);
    const ref = `${AX_REF_PREFIX}${out.length + 1}`;
    out.push({
      ref,
      role: role || "unknown",
      name: name || "",
      ...(value ? { value } : {}),
      ...(description ? { description } : {}),
      ...(typeof n.backendDOMNodeId === "number" ? { backendDOMNodeId: n.backendDOMNodeId } : {}),
      depth,
    });

    const children = n.childIds ?? [];
    for (let i = children.length - 1; i >= 0; i--) {
      const childId = children[i];
      const child = childId ? byId.get(childId) : undefined;
      if (child) {
        stack.push({ node: child, depth: depth + 1 });
      }
    }
  }

  return out;
}

/** Capture an accessibility-tree snapshot through CDP. */
export async function snapshotAria(opts: {
  wsUrl: string;
  lookup?: typeof dnsLookupCb;
  limit?: number;
  timeoutMs?: number;
}): Promise<{ nodes: AriaSnapshotNode[] }> {
  const limit = resolveIntegerOption(opts.limit, 500, { min: 1, max: 2000 });
  return await withCdpSocket(
    opts.wsUrl,
    async (send) => {
      await prepareCdpPageSession(send);
      const res = (await send("Accessibility.getFullAXTree")) as {
        nodes?: RawAXNode[];
      };
      const nodes = Array.isArray(res?.nodes) ? res.nodes : [];
      return { nodes: formatAriaSnapshot(nodes, limit) };
    },
    { commandTimeoutMs: opts.timeoutMs ?? 5000, lookup: opts.lookup },
  );
}
