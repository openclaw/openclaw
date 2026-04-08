"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/button";
import { ComposioAppCard } from "./composio-app-card";
import { ComposioConnectModal } from "./composio-connect-modal";
import type {
  ComposioConnection,
  ComposioToolkit,
  ComposioToolkitsResponse,
  ComposioConnectionsResponse,
} from "@/lib/composio";
import {
  extractComposioConnections,
  extractComposioToolkits,
  normalizeComposioConnections,
  normalizeComposioToolkitSlug,
} from "@/lib/composio-client";
import {
  denchIntegrationsBrand,
  formatDenchIntegrationsStatusError,
} from "@/lib/dench-integrations-brand";

const FEATURED_SLUGS = [
  "gmail",
  "slack",
  "github",
  "notion",
  "google-calendar",
  "linear",
  "airtable",
  "hubspot",
  "salesforce",
  "jira",
  "asana",
  "discord",
];

const MAX_CATEGORY_PILLS = 6;
const MARKETPLACE_PAGE_SIZE = 24;

function SearchIcon() {
  return (
    <svg
      className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ color: "var(--color-text-muted)" }}
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

type ComposioAppsState = {
  connectedToolkits: ComposioToolkit[];
  marketplaceToolkits: ComposioToolkit[];
  marketplaceCursor: string | null;
  connections: ComposioConnection[];
  categories: string[];
  loading: boolean;
  marketplaceLoading: boolean;
  marketplaceReady: boolean;
  loadingMore: boolean;
  error: string | null;
  connectionsError: string | null;
};

type ConnectedAppsSnapshot = {
  connectedToolkits: ComposioToolkit[];
  connections: ComposioConnection[];
};

type ConnectionChangePayload = {
  toolkit?: ComposioToolkit | null;
  connected?: boolean;
  connectedToolkitSlug?: string | null;
  connectedToolkitName?: string | null;
  shouldProbeLiveAgent?: boolean;
};

let lastConnectedAppsSnapshot: ConnectedAppsSnapshot | null = null;

const SNAPSHOT_STORAGE_KEY = "composio-connected-apps-snapshot";

function loadSnapshotFromStorage(): ConnectedAppsSnapshot | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (Array.isArray(parsed?.connectedToolkits) && Array.isArray(parsed?.connections)) {
      return parsed as unknown as ConnectedAppsSnapshot;
    }
  } catch {}
  return null;
}

function saveSnapshotToStorage(snapshot: ConnectedAppsSnapshot): void {
  try {
    localStorage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {}
}

function dedupeToolkits(toolkits: ComposioToolkit[]): ComposioToolkit[] {
  const bySlug = new Map<string, ComposioToolkit>();
  for (const toolkit of toolkits) {
    bySlug.set(normalizeComposioToolkitSlug(toolkit.slug), toolkit);
  }
  return Array.from(bySlug.values());
}

function buildInitialState(): ComposioAppsState {
  if (!lastConnectedAppsSnapshot) {
    lastConnectedAppsSnapshot = loadSnapshotFromStorage();
  }
  return {
    connectedToolkits: lastConnectedAppsSnapshot?.connectedToolkits ?? [],
    marketplaceToolkits: [],
    marketplaceCursor: null,
    connections: lastConnectedAppsSnapshot?.connections ?? [],
    categories: [],
    loading: lastConnectedAppsSnapshot === null,
    marketplaceLoading: false,
    marketplaceReady: false,
    loadingMore: false,
    error: null,
    connectionsError: null,
  };
}

function createToolkitPlaceholder(
  slug: string,
  name: string,
  connectSlug?: string | null,
): ComposioToolkit {
  return {
    slug: normalizeComposioToolkitSlug(slug),
    connect_slug: connectSlug ?? slug,
    name,
    description: "",
    logo: null,
    categories: [],
    auth_schemes: [],
    tools_count: 0,
  };
}

type ComposioMcpStatus = {
  summary: {
    level: "healthy" | "warning" | "error";
    verified: boolean;
    message: string;
  };
  config: {
    status: "pass" | "fail" | "unknown";
    detail: string;
  };
  gatewayTools: {
    status: "pass" | "fail" | "unknown";
    detail: string;
    toolCount: number | null;
  };
  liveAgent: {
    status: "pass" | "fail" | "unknown";
    detail: string;
    evidence: string[];
  };
  refresh?: {
    attempted: boolean;
    restarted: boolean;
    error: string | null;
    profile: string;
  };
};

export function ComposioAppsSection({
  eligible,
  lockBadge,
}: {
  eligible: boolean;
  lockBadge: string | null;
}) {
  const [state, setState] = useState<ComposioAppsState>(buildInitialState);
  const [marketplaceSearch, setMarketplaceSearch] = useState("");
  const [debouncedMarketplaceSearch, setDebouncedMarketplaceSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [selectedToolkit, setSelectedToolkit] = useState<ComposioToolkit | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [mcpStatus, setMcpStatus] = useState<ComposioMcpStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [repairingMcp, setRepairingMcp] = useState(false);
  const [optimisticConnectedToolkits, setOptimisticConnectedToolkits] = useState<ComposioToolkit[]>([]);
  const initialFetchStartedRef = useRef(false);
  const marketplaceRequestKeyRef = useRef("");
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  const fetchToolkitsPage = useCallback(async (params?: {
    search?: string;
    category?: string;
    cursor?: string | null;
    limit?: number;
  }) => {
    const query = new URLSearchParams();
    if (params?.search) query.set("search", params.search);
    if (params?.category) query.set("category", params.category);
    if (params?.cursor) query.set("cursor", params.cursor);
    if (params?.limit) query.set("limit", String(params.limit));
    const suffix = query.toString();
    const response = await fetch(`/api/composio/toolkits${suffix ? `?${suffix}` : ""}`);
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(
        (err as { error?: string }).error ?? `Failed to load apps (${response.status})`,
      );
    }
    return extractComposioToolkits(
      (await response.json()) as ComposioToolkitsResponse,
    );
  }, []);

  const fetchMcpStatus = useCallback(async (
    action?: "refresh_status" | "repair_mcp" | "probe_live_agent",
  ) => {
    try {
      const statusRes = action
        ? await fetch("/api/composio/status", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action }),
          })
        : await fetch("/api/composio/status");
      if (statusRes.ok) {
        setMcpStatus((await statusRes.json()) as ComposioMcpStatus);
        setStatusError(null);
        return;
      }

      setMcpStatus(null);
      const err = await statusRes.json().catch(() => ({}));
      setStatusError(
        (err as { error?: string }).error
          ?? formatDenchIntegrationsStatusError("load", statusRes.status),
      );
    } catch (err) {
      setMcpStatus(null);
      setStatusError(
        err instanceof Error ? err.message : formatDenchIntegrationsStatusError("load"),
      );
    }
  }, []);

  const fetchData = useCallback(async (options?: { fresh?: boolean }) => {
    setState((prev) => ({
      ...prev,
      loading: prev.connectedToolkits.length === 0 && prev.connections.length === 0,
      error: null,
      connectionsError: null,
    }));
    setStatusError(null);

    const marketplacePreFetch = fetchToolkitsPage({ limit: MARKETPLACE_PAGE_SIZE })
      .then((result) => {
        const featuredSet = new Set(FEATURED_SLUGS);
        const ordered = [
          ...result.items
            .filter((toolkit) => featuredSet.has(toolkit.slug))
            .sort((left, right) => FEATURED_SLUGS.indexOf(left.slug) - FEATURED_SLUGS.indexOf(right.slug)),
          ...result.items.filter((toolkit) => !featuredSet.has(toolkit.slug)),
        ];
        setState((prev) => {
          if (prev.marketplaceReady) {
            return prev;
          }
          return {
            ...prev,
            marketplaceToolkits: ordered,
            marketplaceCursor: result.cursor,
            categories: result.categories,
            marketplaceReady: true,
            marketplaceLoading: false,
          };
        });
        marketplaceRequestKeyRef.current = `::`;
      })
      .catch(() => {});

    try {
      const connectionsRes = await fetch(
        `/api/composio/connections?include_toolkits=1${options?.fresh ? "&fresh=1" : ""}`,
      );
      let connectionsData: ComposioConnectionsResponse & {
        toolkits?: ComposioToolkit[];
      } = { items: [] };
      let connectionsError: string | null = null;

      if (connectionsRes.ok) {
        connectionsData = (await connectionsRes.json()) as typeof connectionsData;
      } else {
        const err = await connectionsRes.json().catch(() => ({}));
        connectionsError = (err as { error?: string }).error
          ?? `Failed to load connections (${connectionsRes.status})`;
      }

      const extractedConnections = extractComposioConnections(connectionsData);
      const connectedToolkits = dedupeToolkits(connectionsData.toolkits ?? [])
        .sort((left, right) => left.name.localeCompare(right.name));
      lastConnectedAppsSnapshot = {
        connectedToolkits,
        connections: extractedConnections,
      };
      saveSnapshotToStorage(lastConnectedAppsSnapshot);
      setOptimisticConnectedToolkits((prev) => prev.filter((toolkit) =>
        !connectedToolkits.some((connectedToolkit) =>
          normalizeComposioToolkitSlug(connectedToolkit.slug)
            === normalizeComposioToolkitSlug(toolkit.slug))));

      setState((prev) => ({
        ...prev,
        connectedToolkits,
        connections: extractedConnections,
        loading: false,
        error: null,
        connectionsError,
      }));

      window.setTimeout(() => {
        void fetchMcpStatus();
      }, 0);
      void marketplacePreFetch;
    } catch (err) {
      setMcpStatus(null);
      setState((prev) => ({
        ...prev,
        loading: false,
        error:
          prev.connectedToolkits.length > 0 || prev.connections.length > 0
            ? prev.error
            : err instanceof Error
              ? err.message
              : "Failed to load apps.",
        connectionsError: err instanceof Error ? err.message : "Failed to load connections.",
      }));
    }
  }, [fetchMcpStatus, fetchToolkitsPage]);

  const loadMarketplace = useCallback(async (options?: { reset?: boolean }) => {
    const reset = options?.reset ?? false;
    const searchTerm = debouncedMarketplaceSearch.trim();
    const queryKey = `${searchTerm.toLowerCase()}::${activeCategory ?? ""}`;
    const preserveResults = reset && state.marketplaceReady;

    if (reset) {
      marketplaceRequestKeyRef.current = queryKey;
      setState((prev) => ({
        ...prev,
        marketplaceToolkits: preserveResults ? prev.marketplaceToolkits : [],
        marketplaceCursor: null,
        categories: preserveResults ? prev.categories : [],
        marketplaceLoading: true,
        marketplaceReady: preserveResults,
        loadingMore: false,
        error: null,
      }));
    } else {
      setState((prev) => ({ ...prev, loadingMore: true }));
    }

    try {
      const currentCursor = reset ? null : state.marketplaceCursor;
      const result = await fetchToolkitsPage({
        search: searchTerm || undefined,
        category: activeCategory ?? undefined,
        cursor: currentCursor,
        limit: MARKETPLACE_PAGE_SIZE,
      });

      if (marketplaceRequestKeyRef.current !== queryKey) {
        return;
      }

      setState((prev) => {
        const combined = reset
          ? result.items
          : dedupeToolkits([...prev.marketplaceToolkits, ...result.items]);
        const featuredSet = new Set(FEATURED_SLUGS);
        const ordered = (searchTerm || activeCategory)
          ? combined
          : [
              ...combined
                .filter((toolkit) => featuredSet.has(toolkit.slug))
                .sort((left, right) => FEATURED_SLUGS.indexOf(left.slug) - FEATURED_SLUGS.indexOf(right.slug)),
              ...combined.filter((toolkit) => !featuredSet.has(toolkit.slug)),
            ];

        return {
          ...prev,
          marketplaceToolkits: ordered,
          marketplaceCursor: result.cursor,
          categories: result.categories,
          marketplaceLoading: false,
          marketplaceReady: true,
          loadingMore: false,
          error: null,
        };
      });
    } catch (err) {
      if (marketplaceRequestKeyRef.current !== queryKey) {
        return;
      }
      setState((prev) => ({
        ...prev,
        marketplaceLoading: false,
        marketplaceReady: true,
        loadingMore: false,
        error: err instanceof Error ? err.message : "Failed to load apps.",
      }));
    }
  }, [activeCategory, debouncedMarketplaceSearch, fetchToolkitsPage, state.marketplaceCursor, state.marketplaceReady]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedMarketplaceSearch(marketplaceSearch);
    }, 300);
    return () => window.clearTimeout(timeoutId);
  }, [marketplaceSearch]);

  useEffect(() => {
    if (eligible) {
      if (initialFetchStartedRef.current) {
        return;
      }
      initialFetchStartedRef.current = true;
      void fetchData();
    } else {
      initialFetchStartedRef.current = false;
      setState((prev) => ({ ...prev, loading: false }));
    }
  }, [eligible, fetchData]);

  useEffect(() => {
    if (!eligible || state.loading) {
      return;
    }

    const queryKey = `${debouncedMarketplaceSearch.trim().toLowerCase()}::${activeCategory ?? ""}`;
    if (!state.marketplaceReady || marketplaceRequestKeyRef.current !== queryKey) {
      void loadMarketplace({ reset: true });
    }
  }, [
    activeCategory,
    eligible,
    loadMarketplace,
    debouncedMarketplaceSearch,
    state.loading,
    state.marketplaceReady,
  ]);

  const normalizedConnections = useMemo(
    () => normalizeComposioConnections(state.connections),
    [state.connections],
  );

  const connectionsByToolkit = useMemo(() => {
    const map = new Map<string, typeof normalizedConnections>();
    for (const connection of normalizedConnections) {
      const bucket = map.get(connection.normalized_toolkit_slug);
      if (bucket) {
        bucket.push(connection);
      } else {
        map.set(connection.normalized_toolkit_slug, [connection]);
      }
    }
    return map;
  }, [normalizedConnections]);

  const activeConnectionsByToolkit = useMemo(() => {
    const map = new Map<string, typeof normalizedConnections>();
    for (const [toolkitSlug, connections] of connectionsByToolkit) {
      const activeConnections = connections.filter((connection) => connection.is_active);
      if (activeConnections.length > 0) {
        map.set(toolkitSlug, activeConnections);
      }
    }
    return map;
  }, [connectionsByToolkit]);

  const activeAccountsByToolkit = useMemo(() => {
    const map = new Map<string, typeof normalizedConnections>();
    for (const [toolkitSlug, connections] of activeConnectionsByToolkit) {
      const uniqueAccounts = new Map<string, typeof connections[number]>();
      for (const connection of connections) {
        if (!uniqueAccounts.has(connection.account_identity)) {
          uniqueAccounts.set(connection.account_identity, connection);
        }
      }
      map.set(toolkitSlug, Array.from(uniqueAccounts.values()));
    }
    return map;
  }, [activeConnectionsByToolkit]);

  const optimisticConnectedToolkitSlugs = useMemo(
    () => new Set(
      optimisticConnectedToolkits.map((toolkit) => normalizeComposioToolkitSlug(toolkit.slug)),
    ),
    [optimisticConnectedToolkits],
  );

  const connectedToolkits = useMemo(
    () => dedupeToolkits([...state.connectedToolkits, ...optimisticConnectedToolkits])
      .filter((toolkit) => {
        const slug = normalizeComposioToolkitSlug(toolkit.slug);
        return activeAccountsByToolkit.has(slug) || optimisticConnectedToolkitSlugs.has(slug);
      }),
    [activeAccountsByToolkit, optimisticConnectedToolkits, optimisticConnectedToolkitSlugs, state.connectedToolkits],
  );

  const marketplaceToolkits = useMemo(() => {
    const q = debouncedMarketplaceSearch.trim().toLowerCase();
    return state.marketplaceToolkits.filter((toolkit) => {
      const slug = normalizeComposioToolkitSlug(toolkit.slug);
      if (activeAccountsByToolkit.has(slug) || optimisticConnectedToolkitSlugs.has(slug)) {
        return false;
      }
      if (!q) {
        return true;
      }
      return toolkit.name.toLowerCase().includes(q)
        || toolkit.slug.toLowerCase().includes(q)
        || toolkit.description.toLowerCase().includes(q);
    });
  }, [activeAccountsByToolkit, debouncedMarketplaceSearch, optimisticConnectedToolkitSlugs, state.marketplaceToolkits]);

  const displayCategories = useMemo(
    () => state.categories.slice(0, MAX_CATEGORY_PILLS),
    [state.categories],
  );

  const selectedConnections = selectedToolkit
    ? connectionsByToolkit.get(normalizeComposioToolkitSlug(selectedToolkit.slug)) ?? []
    : null;

  const handleAppClick = useCallback((toolkit: ComposioToolkit) => {
    setSelectedToolkit(toolkit);
    setModalOpen(true);
  }, []);

  const handleConnectionChange = useCallback((payload?: ConnectionChangePayload) => {
    if (payload?.toolkit && payload.connected === false) {
      const removedSlug = normalizeComposioToolkitSlug(payload.toolkit.slug);
      setOptimisticConnectedToolkits((prev) => prev.filter((toolkit) =>
        normalizeComposioToolkitSlug(toolkit.slug) !== removedSlug));
    }
    if (payload?.connected) {
      const resolvedSlug = payload.connectedToolkitSlug ?? payload.toolkit?.slug ?? null;
      const resolvedName = payload.connectedToolkitName ?? payload.toolkit?.name ?? null;
      if (resolvedSlug && resolvedName) {
        const normalizedResolvedSlug = normalizeComposioToolkitSlug(resolvedSlug);
        const existingToolkit = [
          payload.toolkit,
          ...state.connectedToolkits,
          ...state.marketplaceToolkits,
        ]
          .filter((toolkit): toolkit is ComposioToolkit => Boolean(toolkit))
          .find((toolkit) =>
            normalizeComposioToolkitSlug(toolkit.slug) === normalizedResolvedSlug,
          ) ?? null;
        const optimisticToolkit = existingToolkit
          ? {
              ...existingToolkit,
              slug: normalizedResolvedSlug,
              name: resolvedName,
            }
          : createToolkitPlaceholder(
              normalizedResolvedSlug,
              resolvedName,
              payload.toolkit?.connect_slug ?? resolvedSlug,
            );
        setOptimisticConnectedToolkits((prev) =>
          dedupeToolkits([
            ...prev.filter((toolkit) =>
              normalizeComposioToolkitSlug(toolkit.slug) !== normalizedResolvedSlug),
            optimisticToolkit,
          ]));
      }
    }
    void fetchData({ fresh: true });
    if (payload?.connected) {
      window.setTimeout(() => {
        void fetchData({ fresh: true });
      }, 1500);
    }
    if (payload?.shouldProbeLiveAgent) {
      window.setTimeout(() => {
        void fetchMcpStatus("probe_live_agent");
      }, 300);
    }
    void loadMarketplace({ reset: true });
  }, [fetchData, fetchMcpStatus, loadMarketplace, state.connectedToolkits, state.marketplaceToolkits]);

  const handleRepairMcp = useCallback(async () => {
    setRepairingMcp(true);
    setStatusError(null);
    try {
      const response = await fetch("/api/composio/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "repair_mcp" }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setStatusError(
          (payload as { error?: string }).error
            ?? formatDenchIntegrationsStatusError("update"),
        );
        return;
      }
      setMcpStatus(payload as ComposioMcpStatus);
    } catch (err) {
      setStatusError(
        err instanceof Error ? err.message : formatDenchIntegrationsStatusError("update"),
      );
    } finally {
      setRepairingMcp(false);
    }
  }, []);

  useEffect(() => {
    if (
      !eligible
      || state.loading
      || state.marketplaceLoading
      || state.loadingMore
      || !state.marketplaceReady
      || !state.marketplaceCursor
      || !loadMoreRef.current
    ) {
      return;
    }

    const node = loadMoreRef.current;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        void loadMarketplace();
      }
    }, { rootMargin: "160px 0px" });

    observer.observe(node);
    return () => observer.disconnect();
  }, [
    eligible,
    loadMarketplace,
    state.loading,
    state.loadingMore,
    state.marketplaceCursor,
    state.marketplaceLoading,
    state.marketplaceReady,
  ]);

  if (!eligible) {
    return (
      <div>
        <div
          className="flex items-center justify-center rounded-2xl px-6 py-10"
          style={{
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
          }}
        >
          <div className="text-center">
            <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
              Available with Dench Cloud
            </p>
            {lockBadge && (
              <span
                className="mt-2 inline-flex items-center rounded-full px-3 py-1 text-[11px] font-medium"
                style={{
                  background: "var(--color-surface-hover)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border)",
                }}
              >
                {lockBadge}
              </span>
            )}
          </div>
        </div>
      </div>
    );
  }

  const trimmedSearch = debouncedMarketplaceSearch.trim();

  return (
    <div>
      {/* MCP status bar */}
      {(statusError || (mcpStatus && mcpStatus.summary.level !== "healthy")) && (
        <div
          className="mb-6 flex items-start justify-between gap-3 rounded-xl px-3 py-2 text-xs"
          style={{
            background: "color-mix(in srgb, var(--color-error, #ef4444) 8%, transparent)",
            color: "var(--color-error, #ef4444)",
            border: "1px solid color-mix(in srgb, var(--color-error, #ef4444) 20%, transparent)",
          }}
        >
          <div className="min-w-0">
            <p className="truncate">
              {statusError ?? mcpStatus?.summary.message ?? denchIntegrationsBrand.attentionLabel}
            </p>
            {!statusError && mcpStatus?.liveAgent.detail && mcpStatus.summary.level !== "healthy" && (
              <p className="mt-1 text-[11px] opacity-80">
                {mcpStatus.liveAgent.detail}
              </p>
            )}
            {!statusError && (mcpStatus?.liveAgent.evidence?.length ?? 0) > 0 && (
              <p className="mt-1 truncate text-[11px] opacity-70">
                Evidence: {mcpStatus?.liveAgent.evidence.slice(0, 3).join(", ")}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => void handleRepairMcp()}
            disabled={repairingMcp}
            className="shrink-0 rounded-lg px-2 py-1 text-[11px] font-medium cursor-pointer transition-colors"
            style={{
              background: "color-mix(in srgb, var(--color-error, #ef4444) 15%, transparent)",
            }}
          >
            {repairingMcp ? "Repairing..." : "Repair"}
          </button>
        </div>
      )}

      {/* Initial loading */}
      {state.loading && (
        <div className="flex items-center justify-center py-16">
          <div
            className="w-6 h-6 border-2 rounded-full animate-spin"
            style={{ borderColor: "var(--color-border)", borderTopColor: "var(--color-accent)" }}
          />
        </div>
      )}

      {/* Error state */}
      {!state.loading && state.error && (
        <div
          className="p-8 text-center rounded-2xl"
          style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
        >
          <p className="text-sm mb-3" style={{ color: "var(--color-text-muted)" }}>
            {state.error}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => void fetchData()}>
            Retry
          </Button>
        </div>
      )}

      {!state.loading && !state.error && (
        <>
          {/* ─── Your Apps ─── */}
          {connectedToolkits.length > 0 && (
            <section className="mb-10">
              <div className="flex items-baseline gap-2.5 mb-4">
                <h2
                  className="text-lg font-bold tracking-tight"
                  style={{ color: "var(--color-text)" }}
                >
                  Your Apps
                </h2>
                <span
                  className="text-[11px] font-medium rounded-full px-2 py-0.5"
                  style={{
                    background: "var(--color-surface-hover)",
                    color: "var(--color-text-muted)",
                  }}
                >
                  {connectedToolkits.length}
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {connectedToolkits.map((toolkit) => {
                  const toolkitSlug = normalizeComposioToolkitSlug(toolkit.slug);
                  const activeConns = activeAccountsByToolkit.get(toolkitSlug) ?? [];
                  const totalConns = connectionsByToolkit.get(toolkitSlug)?.length ?? 0;
                  return (
                    <ComposioAppCard
                      key={toolkit.slug}
                      toolkit={toolkit}
                      activeConnections={activeConns.length}
                      totalConnections={totalConns}
                      mode="connected"
                      onClick={() => handleAppClick(toolkit)}
                    />
                  );
                })}
              </div>
            </section>
          )}

          {/* ─── Discover ─── */}
          <section>
            <h2
              className="text-lg font-bold tracking-tight mb-4"
              style={{ color: "var(--color-text)" }}
            >
              Discover
            </h2>

            {/* Search */}
            <div className="relative mb-4">
              <SearchIcon />
              <input
                type="text"
                value={marketplaceSearch}
                onChange={(e) => setMarketplaceSearch(e.target.value)}
                placeholder="Search apps..."
                className="w-full pl-9 pr-4 py-2.5 rounded-xl text-sm outline-none transition-shadow focus:shadow-[0_0_0_3px_rgba(0,122,255,0.12)]"
                style={{
                  background: "var(--color-surface-hover)",
                  color: "var(--color-text)",
                }}
              />
            </div>

            {/* Category pills */}
            {displayCategories.length > 0 && (
              <div className="mb-4 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => setActiveCategory(null)}
                  className="rounded-full px-3 py-1 text-[11px] font-medium transition-colors cursor-pointer"
                  style={{
                    background: !activeCategory ? "var(--color-accent)" : "var(--color-surface)",
                    color: !activeCategory ? "var(--color-bg, #fff)" : "var(--color-text-muted)",
                    border: `1px solid ${!activeCategory ? "var(--color-accent)" : "var(--color-border)"}`,
                  }}
                >
                  All
                </button>
                {displayCategories.map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setActiveCategory(activeCategory === cat ? null : cat)}
                    className="rounded-full px-3 py-1 text-[11px] font-medium transition-colors cursor-pointer"
                    style={{
                      background: activeCategory === cat ? "var(--color-accent)" : "var(--color-surface)",
                      color: activeCategory === cat ? "var(--color-bg, #fff)" : "var(--color-text-muted)",
                      border: `1px solid ${activeCategory === cat ? "var(--color-accent)" : "var(--color-border)"}`,
                    }}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            )}

            {/* Search loading indicator */}
            {state.marketplaceLoading && state.marketplaceReady && (
              <div className="mb-4 text-xs" style={{ color: "var(--color-text-muted)" }}>
                Searching...
              </div>
            )}

            {/* Initial marketplace loading */}
            {!state.marketplaceReady && !state.loading && (
              <div className="flex items-center justify-center py-12">
                <div
                  className="w-5 h-5 border-2 rounded-full animate-spin"
                  style={{ borderColor: "var(--color-border)", borderTopColor: "var(--color-accent)" }}
                />
              </div>
            )}

            {/* Marketplace grid */}
            {state.marketplaceReady && marketplaceToolkits.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {marketplaceToolkits.map((toolkit) => (
                  <ComposioAppCard
                    key={toolkit.slug}
                    toolkit={toolkit}
                    activeConnections={0}
                    mode="marketplace"
                    onClick={() => handleAppClick(toolkit)}
                  />
                ))}
              </div>
            )}

            {/* Empty state */}
            {state.marketplaceReady && !state.marketplaceLoading && marketplaceToolkits.length === 0 && (
              <div
                className="p-8 text-center rounded-2xl"
                style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
              >
                <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
                  {trimmedSearch
                    ? `No apps found for "${trimmedSearch}".`
                    : activeCategory
                      ? `No apps found in "${activeCategory}".`
                      : "No apps found."}
                </p>
                {(trimmedSearch || activeCategory) && (
                  <p className="mt-2 text-xs" style={{ color: "var(--color-text-muted)" }}>
                    Try clearing search or category filters.
                  </p>
                )}
              </div>
            )}

            {/* Infinite scroll trigger */}
            {(Boolean(state.marketplaceCursor) || state.loadingMore) && (
              <div
                ref={loadMoreRef}
                className="flex items-center justify-center py-6 text-xs"
                style={{ color: "var(--color-text-muted)" }}
              >
                {state.loadingMore ? "Loading more apps..." : "Scroll to load more"}
              </div>
            )}
          </section>
        </>
      )}

      <ComposioConnectModal
        toolkit={selectedToolkit}
        connections={selectedConnections ?? []}
        open={modalOpen}
        onOpenChange={setModalOpen}
        onConnectionChange={handleConnectionChange}
      />
    </div>
  );
}
