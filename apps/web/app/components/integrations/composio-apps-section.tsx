"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Input } from "../ui/input";
import { ComposioAppCard } from "./composio-app-card";
import { ComposioConnectModal } from "./composio-connect-modal";
import {
  type ComposioConnection,
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

type ComposioAppsState = {
  toolkits: ComposioToolkit[];
  connections: ComposioConnection[];
  categories: string[];
  loading: boolean;
  error: string | null;
  connectionsError: string | null;
};

export function ComposioAppsSection({
  eligible,
  lockBadge,
}: {
  eligible: boolean;
  lockBadge: string | null;
}) {
  const [state, setState] = useState<ComposioAppsState>({
    toolkits: [],
    connections: [],
    categories: [],
    loading: true,
    error: null,
    connectionsError: null,
  });
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [selectedToolkit, setSelectedToolkit] = useState<ComposioToolkit | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const fetchData = useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true, error: null, connectionsError: null }));
    try {
      const [toolkitsRes, connectionsRes] = await Promise.all([
        fetch("/api/composio/toolkits"),
        fetch("/api/composio/connections"),
      ]);

      if (!toolkitsRes.ok) {
        const err = await toolkitsRes.json().catch(() => ({}));
        throw new Error(
          (err as { error?: string }).error ?? `Failed to load apps (${toolkitsRes.status})`,
        );
      }

      const toolkitsData = extractComposioToolkits(
        (await toolkitsRes.json()) as ComposioToolkitsResponse,
      );
      let connectionsData: ComposioConnectionsResponse = { items: [] };
      let connectionsError: string | null = null;

      if (connectionsRes.ok) {
        connectionsData = (await connectionsRes.json()) as ComposioConnectionsResponse;
      } else {
        const err = await connectionsRes.json().catch(() => ({}));
        connectionsError = (err as { error?: string }).error
          ?? `Failed to load connections (${connectionsRes.status})`;
      }

      setState({
        toolkits: toolkitsData.items,
        connections: extractComposioConnections(connectionsData),
        categories: toolkitsData.categories,
        loading: false,
        error: null,
        connectionsError,
      });

      // Keep the agent's Composio tool cheat sheet in sync with connections (non-blocking).
      void fetch("/api/composio/tool-index", { method: "POST" }).catch(() => {
        /* ignore — integrations still work if index rebuild fails */
      });
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : "Failed to load apps.",
      }));
    }
  }, []);

  useEffect(() => {
    if (eligible) {
      void fetchData();
    } else {
      setState((prev) => ({ ...prev, loading: false }));
    }
  }, [eligible, fetchData]);

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

  const connectedAppsCount = activeAccountsByToolkit.size;
  const activeAccountsCount = useMemo(
    () => Array.from(activeAccountsByToolkit.values()).reduce(
      (sum, connections) => sum + connections.length,
      0,
    ),
    [activeAccountsByToolkit],
  );

  const filteredToolkits = useMemo(() => {
    let list = [...state.toolkits].sort((left, right) => left.name.localeCompare(right.name));
    if (activeCategory) {
      list = list.filter((t) =>
        t.categories.some((c) => c.toLowerCase() === activeCategory.toLowerCase()),
      );
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.slug.toLowerCase().includes(q) ||
          t.description?.toLowerCase().includes(q),
      );
    }
    return list;
  }, [state.toolkits, search, activeCategory]);

  const connectedToolkits = useMemo(
    () => filteredToolkits.filter((toolkit) =>
      activeAccountsByToolkit.has(normalizeComposioToolkitSlug(toolkit.slug))),
    [activeAccountsByToolkit, filteredToolkits],
  );

  const availableToolkits = useMemo(
    () => filteredToolkits.filter((toolkit) =>
      !activeAccountsByToolkit.has(normalizeComposioToolkitSlug(toolkit.slug))),
    [activeAccountsByToolkit, filteredToolkits],
  );

  const { featuredAvailable, restAvailable } = useMemo(() => {
    if (search.trim() || activeCategory) {
      return { featuredAvailable: [] as ComposioToolkit[], restAvailable: availableToolkits };
    }

    const featuredSet = new Set(FEATURED_SLUGS);
    const featured = availableToolkits.filter((toolkit) => featuredSet.has(toolkit.slug));
    featured.sort(
      (left, right) => FEATURED_SLUGS.indexOf(left.slug) - FEATURED_SLUGS.indexOf(right.slug),
    );
    const rest = availableToolkits.filter((toolkit) => !featuredSet.has(toolkit.slug));
    return { featuredAvailable: featured, restAvailable: rest };
  }, [activeCategory, availableToolkits, search]);

  const selectedConnections = selectedToolkit
    ? connectionsByToolkit.get(normalizeComposioToolkitSlug(selectedToolkit.slug)) ?? []
    : null;

  const handleAppClick = useCallback((toolkit: ComposioToolkit) => {
    setSelectedToolkit(toolkit);
    setModalOpen(true);
  }, []);

  const handleConnectionChange = useCallback(() => {
    void fetchData();
  }, [fetchData]);

  if (!eligible) {
    return (
      <div className="mt-6">
        <div className="mb-3">
          <h3
            className="text-sm font-medium"
            style={{ color: "var(--color-text)" }}
          >
            App Connections
          </h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Browse integrations and unlock them for your AI agent
          </p>
        </div>
        <div
          className="flex items-center justify-center rounded-2xl border px-6 py-10"
          style={{
            borderColor: "var(--color-border)",
            background: "var(--color-surface-hover)",
          }}
        >
          <div className="text-center">
            <p className="text-sm text-muted-foreground">
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

  return (
    <div className="mt-6">
      <div
        className="mb-4 rounded-2xl border p-4"
        style={{
          borderColor: "var(--color-border)",
          background: "var(--color-surface-hover)",
        }}
      >
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h3
              className="text-sm font-medium"
              style={{ color: "var(--color-text)" }}
            >
              App Connections
            </h3>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Connect your tools, keep track of active accounts, and manage everything from one place.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <div
              className="min-w-[120px] rounded-xl border px-3 py-2"
              style={{ borderColor: "var(--color-border)", background: "var(--color-background)" }}
            >
              <p className="text-lg font-semibold text-foreground">{connectedAppsCount}</p>
              <p className="text-[11px] text-muted-foreground">
                app{connectedAppsCount === 1 ? "" : "s"} connected
              </p>
            </div>
            <div
              className="min-w-[120px] rounded-xl border px-3 py-2"
              style={{ borderColor: "var(--color-border)", background: "var(--color-background)" }}
            >
              <p className="text-lg font-semibold text-foreground">{activeAccountsCount}</p>
              <p className="text-[11px] text-muted-foreground">
                active account{activeAccountsCount === 1 ? "" : "s"}
              </p>
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input
            type="text"
            placeholder="Search apps..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 text-sm"
          />
        </div>

        {state.categories.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setActiveCategory(null)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                !activeCategory
                  ? "bg-[var(--color-accent)] text-white"
                  : "bg-[var(--color-background)] text-muted-foreground hover:text-foreground"
              }`}
            >
              All
            </button>
            {state.categories.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() =>
                  setActiveCategory(activeCategory === cat ? null : cat)
                }
                className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  activeCategory === cat
                    ? "bg-[var(--color-accent)] text-white"
                    : "bg-[var(--color-background)] text-muted-foreground hover:text-foreground"
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        )}
      </div>

      {state.loading && (
        <div className="flex items-center justify-center py-10">
          <div
            className="h-5 w-5 animate-spin rounded-full border-2"
            style={{
              borderColor: "var(--color-border)",
              borderTopColor: "var(--color-accent)",
            }}
          />
        </div>
      )}

      {!state.loading && state.error && (
        <div
          className="rounded-xl border px-4 py-3 text-sm"
          style={{
            borderColor: "var(--color-border)",
            color: "var(--color-text-muted)",
          }}
        >
          {state.error}
        </div>
      )}

      {!state.loading && !state.error && (
        <>
          {state.connectionsError && (
            <div
              className="mb-4 rounded-2xl border px-4 py-3 text-sm"
              style={{
                borderColor: "rgba(250, 204, 21, 0.28)",
                background: "rgba(250, 204, 21, 0.08)",
                color: "rgb(253 224 71)",
              }}
            >
              {state.connectionsError}
            </div>
          )}

          {connectedToolkits.length > 0 ? (
            <div className="mb-5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h4 className="text-sm font-medium text-foreground">Connected</h4>
                  <p className="text-[11px] text-muted-foreground">
                    Apps already available to your AI agent
                  </p>
                </div>
                <span className="text-[11px] text-muted-foreground">
                  {connectedAppsCount} app{connectedAppsCount === 1 ? "" : "s"} connected
                </span>
              </div>

              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {connectedToolkits.map((toolkit) => {
                  const toolkitSlug = normalizeComposioToolkitSlug(toolkit.slug);
                  const activeConnections = activeAccountsByToolkit.get(toolkitSlug) ?? [];
                  const totalConnections = connectionsByToolkit.get(toolkitSlug)?.length ?? 0;
                  return (
                    <ComposioAppCard
                      key={toolkit.slug}
                      toolkit={toolkit}
                      activeConnections={activeConnections.length}
                      totalConnections={totalConnections}
                      onClick={() => handleAppClick(toolkit)}
                    />
                  );
                })}
              </div>
            </div>
          ) : (
            <div
              className="mb-5 rounded-2xl border border-dashed px-5 py-6"
              style={{
                borderColor: "var(--color-border)",
                background: "var(--color-background-soft, var(--color-surface-hover))",
              }}
            >
              <h4 className="text-sm font-medium text-foreground">No connected apps yet</h4>
              <p className="mt-1 text-sm text-muted-foreground">
                Connect an app below to make it available inside your agent workflows.
              </p>
            </div>
          )}

          {featuredAvailable.length > 0 && (
            <div className="mb-5">
              <div className="mb-3">
                <h4 className="text-sm font-medium text-foreground">Popular to connect</h4>
                <p className="text-[11px] text-muted-foreground">
                  Quick-start apps people usually connect first
                </p>
              </div>

              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {featuredAvailable.map((toolkit) => (
                  <ComposioAppCard
                    key={toolkit.slug}
                    toolkit={toolkit}
                    activeConnections={0}
                    featured
                    onClick={() => handleAppClick(toolkit)}
                  />
                ))}
              </div>
            </div>
          )}

          {restAvailable.length > 0 && (
            <div>
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h4 className="text-sm font-medium text-foreground">
                    {featuredAvailable.length > 0 ? "Browse all apps" : "Available apps"}
                  </h4>
                  <p className="text-[11px] text-muted-foreground">
                    Explore the rest of the catalog and connect more tools
                  </p>
                </div>
                <span className="text-[11px] text-muted-foreground">
                  {restAvailable.length} available
                </span>
              </div>

              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {restAvailable.map((toolkit) => (
                  <ComposioAppCard
                    key={toolkit.slug}
                    toolkit={toolkit}
                    activeConnections={0}
                    onClick={() => handleAppClick(toolkit)}
                  />
                ))}
              </div>
            </div>
          )}

          {connectedToolkits.length === 0 && availableToolkits.length === 0 && (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {search.trim()
                ? `No apps matching "${search.trim()}"`
                : "No apps available"}
            </div>
          )}
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
