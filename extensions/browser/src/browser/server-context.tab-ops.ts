import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveBrowserNavigationProxyMode } from "./browser-proxy-mode.js";
import {
  assertChromeMcpCdpTransportAllowed,
  resolveCdpControlPolicy,
} from "./cdp-reachability-policy.js";
import { isSelectableCdpBrowserTarget } from "./cdp-target-filter.js";
import { CDP_JSON_NEW_TIMEOUT_MS } from "./cdp-timeouts.js";
import {
  assertCdpEndpointAllowed,
  fetchJson,
  fetchOk,
  normalizeCdpHttpBaseForJsonEndpoints,
  resolveCdpTabOwnership,
} from "./cdp.helpers.js";
import {
  appendCdpPath,
  createTargetViaCdp,
  normalizeCdpWsUrl,
  waitForCdpCommittedNavigationUrl,
} from "./cdp.js";
import type { CdpActionTimeouts } from "./cdp.js";
import { getChromeMcpModule } from "./chrome-mcp.runtime.js";
import type { BrowserOpenResult } from "./client.types.js";
import type { ResolvedBrowserProfile } from "./config.js";
import { resolveBrowserEngine } from "./engines/registry.js";
import {
  assertBrowserNavigationAllowed,
  assertBrowserNavigationResultAllowed,
  InvalidBrowserNavigationUrlError,
  requiresInspectableBrowserNavigationRedirectsForUrl,
  withBrowserNavigationPolicy,
} from "./navigation-guard.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";
import { getPwAiModule } from "./pw-ai-module.js";
import {
  MANAGED_BROWSER_PAGE_TAB_LIMIT,
  OPEN_TAB_DISCOVERY_POLL_MS,
  OPEN_TAB_DISCOVERY_WINDOW_MS,
} from "./server-context.constants.js";
import type {
  BrowserOperationOptions,
  BrowserServerState,
  BrowserTab,
  ProfileRuntimeState,
  ProfileContext,
} from "./server-context.types.js";
import { browserSessionTabNativeIdentity } from "./session-tab-identity.js";
import { readColdNativeActivity, volatileTabsBySession } from "./session-tab-process-state.js";
import {
  dispatchBrowserTabClose,
  findRetainedBrowserDashboardTab,
  readBrowserDashboardTabs,
} from "./session-tab-store.js";
import { readDurableTabs } from "./session-tab-tracking.js";
import {
  assignTabAlias,
  assignTabAliases,
  normalizeTabLabel,
  resolveBrowserTabOrThrow,
} from "./target-id.js";

type TabOpsDeps = {
  profile: ResolvedBrowserProfile;
  state: () => BrowserServerState;
  runtime: ProfileRuntimeState;
};

type ProfileTabOps = Pick<ProfileContext, "listTabs" | "openTab"> & {
  labelTab: (
    targetId: string,
    label: string,
    options?: BrowserOperationOptions,
  ) => Promise<BrowserTab>;
};

type CdpTarget = {
  id?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
  type?: string;
};

type ExtensionCdpTarget = CdpTarget & {
  tabId?: unknown;
};

function normalizeWsUrl(raw: string | undefined, cdpBaseUrl: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    return normalizeCdpWsUrl(raw, cdpBaseUrl);
  } catch {
    return raw;
  }
}

/**
 * Collects the freshest recorded session activity per target for one profile.
 * Durable records and volatile registrations both carry lastUsedAt; durable
 * native identities also fold in activity observed after the record froze.
 */
async function readProfileTabLastUsedAt(profileName: string): Promise<Map<string, number>> {
  const profile = normalizeOptionalLowercaseString(profileName);
  const lastUsedByTarget = new Map<string, number>();
  const observe = (targetId: string, recordProfile: string | undefined, lastUsedAt: number) => {
    if (!targetId || normalizeOptionalLowercaseString(recordProfile) !== profile) {
      return;
    }
    const previous = lastUsedByTarget.get(targetId);
    if (previous === undefined || lastUsedAt > previous) {
      lastUsedByTarget.set(targetId, lastUsedAt);
    }
  };
  for (const record of await readDurableTabs()) {
    const observedAt =
      record.interactionTargetKind === "native"
        ? readColdNativeActivity(browserSessionTabNativeIdentity(record))
        : undefined;
    observe(record.nativeTargetId, record.profile, Math.max(record.lastUsedAt, observedAt ?? 0));
  }
  for (const sessionTabs of volatileTabsBySession().values()) {
    for (const tab of sessionTabs.values()) {
      observe(tab.targetId, tab.profile, tab.lastUsedAt);
    }
  }
  return lastUsedByTarget;
}

/**
 * Orders eviction candidates for the managed tab cap. Chrome reports CDP
 * targets most-recently-activated first, so raw /json/list order is exactly
 * backwards for cleanup: slicing from the front closes the tabs other sessions
 * opened seconds ago while long-idle tabs survive. Untracked tabs (no recorded
 * session activity) evict first in reverse CDP order; tracked tabs follow in
 * ascending last-use order.
 */
function orderManagedTabEvictionCandidates(
  candidates: readonly BrowserTab[],
  lastUsedByTarget: ReadonlyMap<string, number>,
): BrowserTab[] {
  return candidates
    .toReversed()
    .toSorted(
      (left, right) =>
        (lastUsedByTarget.get(left.targetId) ?? 0) - (lastUsedByTarget.get(right.targetId) ?? 0),
    );
}

export function createProfileTabOps({ profile, state, runtime }: TabOpsDeps): ProfileTabOps {
  const cdpHttpBase = normalizeCdpHttpBaseForJsonEndpoints(profile.cdpUrl);
  const capabilities = getBrowserProfileCapabilities(profile);
  const getCdpControlPolicy = () => resolveCdpControlPolicy(profile, state().resolved.ssrfPolicy);
  const getNavigationPolicy = () =>
    withBrowserNavigationPolicy(state().resolved.ssrfPolicy, {
      browserProxyMode: resolveBrowserNavigationProxyMode({
        resolved: state().resolved,
        profile,
      }),
    });
  const getRemoteCdpActionTimeouts = (): CdpActionTimeouts | undefined => {
    if (profile.cdpIsLoopback && !profile.attachOnly) {
      return undefined;
    }
    const resolved = state().resolved;
    return {
      httpTimeoutMs: resolved.remoteCdpTimeoutMs,
      handshakeTimeoutMs: resolved.remoteCdpHandshakeTimeoutMs,
    };
  };

  const readTabs = async (options?: BrowserOperationOptions): Promise<BrowserTab[]> => {
    if (capabilities.usesChromeMcp) {
      assertChromeMcpCdpTransportAllowed(profile, getCdpControlPolicy());
      const { listChromeMcpTabs } = await getChromeMcpModule();
      return await listChromeMcpTabs(profile.name, profile, options);
    }

    if (capabilities.usesPersistentPlaywright) {
      const mod = await getPwAiModule({ mode: "strict" });
      if (mod) {
        const ssrfPolicy = getCdpControlPolicy();
        const resolved = state().resolved;
        // Enumeration budget must reflect the work of listing all tabs, not the
        // CDP handshake. Prefer a caller-supplied deadline, fall back to the
        // action-level timeout, and keep it no smaller than the handshake so a
        // healthy but slow enumeration is not mistaken for a dead connection.
        const enumerationBudgetMs =
          typeof options?.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
            ? options.timeoutMs
            : resolved.actionTimeoutMs;
        const timeoutMs = Math.max(enumerationBudgetMs, resolved.remoteCdpHandshakeTimeoutMs);
        await assertCdpEndpointAllowed(profile.cdpUrl, ssrfPolicy);
        const pages = await mod.listPagesViaPlaywright({
          cdpUrl: profile.cdpUrl,
          ...(profile.engine ? { engine: profile.engine } : {}),
          ssrfPolicy,
          timeoutMs,
          ...(capabilities.requiresCompleteTargetEnumeration
            ? { requireCompleteTargetList: true }
            : {}),
          ...(options?.signal ? { signal: options.signal } : {}),
        });
        const webExtensionTabIds =
          profile.driver === "extension"
            ? await fetchJson<ExtensionCdpTarget[]>(
                appendCdpPath(cdpHttpBase, "/json/list"),
                Math.min(timeoutMs, resolved.remoteCdpTimeoutMs),
                options?.signal ? { signal: options.signal } : undefined,
                ssrfPolicy,
              )
                .then(
                  (targets) =>
                    new Map(
                      targets.flatMap((target) =>
                        typeof target.id === "string" &&
                        typeof target.tabId === "number" &&
                        Number.isSafeInteger(target.tabId) &&
                        target.tabId >= 0
                          ? [[target.id, target.tabId] as const]
                          : [],
                      ),
                    ),
                )
                .catch(() => {
                  options?.signal?.throwIfAborted();
                  return new Map<string, number>();
                })
            : undefined;
        return pages.filter(isSelectableCdpBrowserTarget).map((p) => {
          // Correlate only by the relay's exact CDP target id. The native Chrome
          // tab id is runtime-scoped and must not replace OpenClaw's stable tN alias.
          const webExtensionTabId = webExtensionTabIds?.get(p.targetId);
          const tab: BrowserTab = {
            targetId: p.targetId,
            title: p.title,
            url: p.url,
            type: p.type,
          };
          if (webExtensionTabId !== undefined) {
            tab.webExtensionTabId = webExtensionTabId;
          }
          return tab;
        });
      }
    }

    const raw = await fetchJson<CdpTarget[]>(
      appendCdpPath(cdpHttpBase, "/json/list"),
      options?.timeoutMs,
      options?.signal ? { signal: options.signal } : undefined,
      getCdpControlPolicy(),
    );
    const cdpControlPolicy = getCdpControlPolicy();
    const tabs: BrowserTab[] = [];
    for (const t of raw) {
      const tab: BrowserTab = {
        targetId: t.id ?? "",
        title: t.title ?? "",
        url: t.url ?? "",
        wsUrl: normalizeWsUrl(t.webSocketDebuggerUrl, profile.cdpUrl),
        type: t.type,
      };
      if (!tab.targetId || !isSelectableCdpBrowserTarget(tab)) {
        continue;
      }
      if (tab.wsUrl) {
        const wsPin = await assertCdpEndpointAllowed(tab.wsUrl, cdpControlPolicy, {
          source: "discovered",
          configuredUrl: profile.cdpUrl,
        });
        if (wsPin?.lookup) {
          tab.wsLookup = wsPin.lookup;
        }
      }
      tabs.push(tab);
    }
    return tabs;
  };

  const listTabs = async (options?: BrowserOperationOptions): Promise<BrowserTab[]> => {
    const tabs = await readTabs(options);
    options?.signal?.throwIfAborted();
    // Chrome MCP target identity is authoritative. A replacement tab cannot
    // inherit an alias safely, even when its URL matches the closed tab.
    return assignTabAliases(
      runtime,
      tabs,
      !capabilities.usesChromeMcp &&
        resolveBrowserEngine(profile.engine).descriptor.sessionScope !== "connection",
    );
  };

  const enforceManagedTabLimit = async (
    keepTargetId: string,
    options?: BrowserOperationOptions,
  ): Promise<void> => {
    if (!capabilities.supportsManagedTabLimit || state().resolved.attachOnly || !runtime.running) {
      return;
    }

    const pageTabs = await listTabs(options)
      .then((tabs) => tabs.filter((tab) => (tab.type ?? "page") === "page"))
      .catch(() => [] as BrowserTab[]);
    if (pageTabs.length <= MANAGED_BROWSER_PAGE_TAB_LIMIT) {
      return;
    }

    const retained = await readBrowserDashboardTabs();
    const candidates = pageTabs.filter(
      (tab) =>
        tab.targetId !== keepTargetId &&
        !findRetainedBrowserDashboardTab(tab.targetId, profile.name, retained),
    );
    const excessCount = pageTabs.length - MANAGED_BROWSER_PAGE_TAB_LIMIT;
    const lastUsedByTarget = await readProfileTabLastUsedAt(profile.name);
    const evictionOrder = orderManagedTabEvictionCandidates(candidates, lastUsedByTarget);
    for (const tab of evictionOrder.slice(0, excessCount)) {
      options?.signal?.throwIfAborted();
      await dispatchBrowserTabClose(
        tab.targetId,
        profile.name,
        () => {
          options?.signal?.throwIfAborted();
          return fetchOk(
            appendCdpPath(cdpHttpBase, `/json/close/${tab.targetId}`),
            undefined,
            undefined,
            getCdpControlPolicy(),
          );
        },
        { skipRetained: true },
      ).catch(() => {
        // best-effort cleanup only
      });
    }
  };

  const adoptValidatedTab = (
    tab: BrowserTab,
    options?: BrowserOperationOptions & { label?: string },
  ): BrowserTab => {
    options?.signal?.throwIfAborted();
    // Rejected, aborted, or undiscovered opens must preserve the prior implicit target.
    // Alias and sticky state therefore change only at this final validated adoption point.
    const adopted = assignTabAlias({ profileState: runtime, tab, label: options?.label });
    runtime.lastTargetId = tab.targetId;
    // This local-managed raw HTTP cleanup owns no browser process or adapter.
    // Keep it best-effort so an unresponsive old target cannot block tab creation.
    void enforceManagedTabLimit(tab.targetId, options).catch(() => {});
    return adopted;
  };

  const withTabOwnership = async (
    tab: BrowserTab,
    options?: BrowserOperationOptions & { requireDurableOwnership?: boolean },
  ): Promise<BrowserOpenResult> => {
    if (resolveBrowserEngine(profile.engine).descriptor.sessionScope === "connection") {
      if (options?.requireDurableOwnership) {
        throw new Error("Connection-scoped browser pages cannot be retained by a dashboard.");
      }
      return {
        ...tab,
        ownership: { status: "non-durable", reason: "browser-identity-unavailable" },
      };
    }
    const cdpTimeouts = getRemoteCdpActionTimeouts();
    const ownership = await resolveCdpTabOwnership({
      profileName: profile.name,
      cdpUrl: profile.cdpUrl,
      nativeTargetId: tab.targetId,
      signal: options?.signal,
      timeoutMs: cdpTimeouts?.httpTimeoutMs,
      ssrfPolicy: getCdpControlPolicy(),
    });
    if (options?.requireDurableOwnership && ownership.status !== "durable") {
      throw new Error("Browser could not verify durable ownership for the new dashboard tab");
    }
    return { ...tab, ownership };
  };

  const openTab: ProfileTabOps["openTab"] = async (url, opts) => {
    opts?.signal?.throwIfAborted();
    const normalizedLabel = opts?.label === undefined ? undefined : normalizeTabLabel(opts.label);
    const ssrfPolicyOpts = getNavigationPolicy();
    const cdpPolicy = getCdpControlPolicy();
    // Runtime shutdown fences state() before draining this operation's cleanup.
    const cleanupTimeoutMs = state().resolved.remoteCdpTimeoutMs;
    const adoptOwnedTab = async (tab: BrowserTab) =>
      adoptValidatedTab(await withTabOwnership(tab, opts), { ...opts, label: normalizedLabel });

    if (capabilities.usesChromeMcp) {
      await assertBrowserNavigationAllowed({ url, ...ssrfPolicyOpts });
      assertChromeMcpCdpTransportAllowed(profile, cdpPolicy);
      const { openChromeMcpTab } = await getChromeMcpModule();
      const cdpTimeouts = getRemoteCdpActionTimeouts();
      const page = await openChromeMcpTab(profile.name, url, profile, {
        signal: opts?.signal,
        timeoutMs: opts?.timeoutMs,
        cdpPolicy,
        ...(cdpTimeouts ? { cdpTimeouts } : {}),
      });
      await assertBrowserNavigationResultAllowed({ url: page.url, ...ssrfPolicyOpts });
      return adoptValidatedTab(page, { ...opts, label: normalizedLabel });
    }

    let createdTargetId: string | undefined;
    let closeCreatedPage: (() => Promise<void>) | undefined;
    try {
      if (capabilities.usesPersistentPlaywright) {
        const mod = await getPwAiModule({ mode: "strict" });
        if (mod) {
          const page = await mod.createPageViaPlaywright({
            cdpUrl: profile.cdpUrl,
            ...(profile.engine ? { engine: profile.engine } : {}),
            url,
            cdpPolicy,
            ...(opts?.signal ? { signal: opts.signal } : {}),
            ...ssrfPolicyOpts,
          });
          closeCreatedPage = page.close;
          createdTargetId = page.targetId;
          return await adoptOwnedTab({
            targetId: page.targetId,
            title: page.title,
            url: page.url,
            type: page.type,
          });
        }
      }

      if (requiresInspectableBrowserNavigationRedirectsForUrl(url, state().resolved.ssrfPolicy)) {
        throw new InvalidBrowserNavigationUrlError(
          "Navigation blocked: strict browser SSRF policy requires Playwright-backed redirect-hop inspection",
        );
      }

      await assertBrowserNavigationAllowed({ url, ...ssrfPolicyOpts });
      const cdpActionTimeouts = getRemoteCdpActionTimeouts();
      const createdViaCdp = await createTargetViaCdp({
        cdpUrl: profile.cdpUrl,
        url,
        ssrfPolicy: cdpPolicy,
        waitForNavigationResult: true,
        ...(cdpActionTimeouts ? { timeouts: cdpActionTimeouts } : {}),
        ...(opts?.signal ? { signal: opts.signal } : {}),
      }).catch(() => null);
      createdTargetId = createdViaCdp?.targetId;
      opts?.signal?.throwIfAborted();

      if (createdViaCdp) {
        if (createdViaCdp.finalUrl) {
          await assertBrowserNavigationResultAllowed({
            url: createdViaCdp.finalUrl,
            ...ssrfPolicyOpts,
          });
          const deadline = Date.now() + OPEN_TAB_DISCOVERY_WINDOW_MS;
          while (Date.now() < deadline) {
            opts?.signal?.throwIfAborted();
            const tabs = await readTabs(opts).catch(() => [] as BrowserTab[]);
            const found = tabs.find((t) => t.targetId === createdViaCdp.targetId);
            if (found) {
              await assertBrowserNavigationResultAllowed({ url: found.url, ...ssrfPolicyOpts });
              // The attached target owns the committed URL; /json/list supplies the
              // remaining metadata and may briefly lag that exact document snapshot.
              return await adoptOwnedTab({ ...found, url: createdViaCdp.finalUrl });
            }
            await sleepWithAbort(OPEN_TAB_DISCOVERY_POLL_MS, opts?.signal);
          }
          opts?.signal?.throwIfAborted();
        }
        // Uncommitted or undiscovered targets are returned without sticky,
        // alias, or managed-cleanup adoption.
        return await withTabOwnership(
          {
            targetId: createdViaCdp.targetId,
            title: "",
            url: createdViaCdp.finalUrl || url,
            type: "page",
          },
          opts,
        );
      }

      const encoded = encodeURIComponent(url);
      const endpointUrl = new URL(appendCdpPath(cdpHttpBase, "/json/new"));
      const endpoint = endpointUrl.search
        ? (() => {
            endpointUrl.searchParams.set("url", url);
            return endpointUrl.toString();
          })()
        : `${endpointUrl.toString()}?${encoded}`;
      opts?.signal?.throwIfAborted();
      const created = await fetchJson<CdpTarget>(
        endpoint,
        cdpActionTimeouts?.httpTimeoutMs ?? CDP_JSON_NEW_TIMEOUT_MS,
        {
          method: "PUT",
        },
        getCdpControlPolicy(),
      ).catch(async (err: unknown) => {
        if (String(err).includes("HTTP 405")) {
          return await fetchJson<CdpTarget>(
            endpoint,
            cdpActionTimeouts?.httpTimeoutMs ?? CDP_JSON_NEW_TIMEOUT_MS,
            undefined,
            getCdpControlPolicy(),
          );
        }
        throw err;
      });

      createdTargetId = created.id;
      opts?.signal?.throwIfAborted();
      if (!created.id) {
        throw new Error("Failed to open tab (missing id)");
      }
      const resolvedUrl = created.url ?? url;
      if (!isSelectableCdpBrowserTarget({ url: resolvedUrl, type: created.type })) {
        throw new Error("Failed to open tab (non-selectable target)");
      }
      await assertBrowserNavigationResultAllowed({ url: resolvedUrl, ...ssrfPolicyOpts });
      const wsUrl = normalizeWsUrl(created.webSocketDebuggerUrl, profile.cdpUrl);
      const wsPin = wsUrl
        ? await assertCdpEndpointAllowed(wsUrl, getCdpControlPolicy(), {
            source: "discovered",
            configuredUrl: profile.cdpUrl,
          })
        : undefined;
      const committedUrl = wsUrl
        ? await waitForCdpCommittedNavigationUrl({
            wsUrl,
            configuredCdpUrl: profile.cdpUrl,
            cdpPolicy: getCdpControlPolicy(),
            requestedUrl: url,
            signal: opts?.signal,
            timeouts: cdpActionTimeouts,
          })
        : undefined;
      opts?.signal?.throwIfAborted();
      if (committedUrl) {
        await assertBrowserNavigationResultAllowed({ url: committedUrl, ...ssrfPolicyOpts });
      }
      const opened = await withTabOwnership(
        {
          targetId: created.id,
          title: created.title ?? "",
          url: committedUrl || resolvedUrl,
          wsUrl,
          ...(wsPin?.lookup ? { wsLookup: wsPin.lookup } : {}),
          type: created.type,
        },
        opts,
      );
      return committedUrl ? adoptValidatedTab(opened, { ...opts, label: normalizedLabel }) : opened;
    } catch (openError) {
      if (closeCreatedPage) {
        await closeCreatedPage().catch(() => {});
      } else if (createdTargetId) {
        // Creation owns the target until a successful handoff. Cleanup must not
        // inherit the caller's abort or replace the original open failure.
        await fetchOk(
          appendCdpPath(cdpHttpBase, `/json/close/${encodeURIComponent(createdTargetId)}`),
          cleanupTimeoutMs,
          undefined,
          cdpPolicy,
        ).catch(() => {});
      }
      throw openError;
    }
  };

  const labelTab = async (
    targetId: string,
    label: string,
    options?: BrowserOperationOptions,
  ): Promise<BrowserTab> => {
    const normalizedLabel = normalizeTabLabel(label);
    const tabs = await listTabs(options);
    const tab = resolveBrowserTabOrThrow(targetId, tabs);
    return assignTabAlias({ profileState: runtime, tab, label: normalizedLabel });
  };

  return {
    listTabs,
    openTab,
    labelTab,
  };
}
