"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Input } from "../ui/input";
import { ComposioAppCard } from "./composio-app-card";
import { ComposioConnectModal } from "./composio-connect-modal";
import type {
  ComposioToolkit,
  ComposioConnection,
  ComposioToolkitsResponse,
  ComposioConnectionsResponse,
} from "@/lib/composio";

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
  });
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [selectedToolkit, setSelectedToolkit] = useState<ComposioToolkit | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  const fetchData = useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
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

      const toolkitsData = (await toolkitsRes.json()) as ComposioToolkitsResponse;
      const connectionsData = connectionsRes.ok
        ? ((await connectionsRes.json()) as ComposioConnectionsResponse)
        : { items: [] };

      setState({
        toolkits: toolkitsData.items,
        connections: connectionsData.items,
        categories: toolkitsData.categories ?? [],
        loading: false,
        error: null,
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

  const connectionsByToolkit = useMemo(() => {
    const map = new Map<string, ComposioConnection>();
    for (const conn of state.connections) {
      if (conn.status === "ACTIVE" && !map.has(conn.toolkit_slug)) {
        map.set(conn.toolkit_slug, conn);
      }
    }
    return map;
  }, [state.connections]);

  const filteredToolkits = useMemo(() => {
    let list = state.toolkits;
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

  const { featured, rest } = useMemo(() => {
    if (search.trim() || activeCategory) {
      return { featured: [], rest: filteredToolkits };
    }
    const featuredSet = new Set(FEATURED_SLUGS);
    const feat: ComposioToolkit[] = [];
    const other: ComposioToolkit[] = [];
    for (const t of filteredToolkits) {
      if (featuredSet.has(t.slug)) {
        feat.push(t);
      } else {
        other.push(t);
      }
    }
    feat.sort(
      (a, b) => FEATURED_SLUGS.indexOf(a.slug) - FEATURED_SLUGS.indexOf(b.slug),
    );
    return { featured: feat, rest: other };
  }, [filteredToolkits, search, activeCategory]);

  const selectedConnection = selectedToolkit
    ? connectionsByToolkit.get(selectedToolkit.slug) ?? null
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
            Connected Apps
          </h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Connect your tools to use them with the AI agent
          </p>
        </div>
        <div
          className="flex items-center justify-center rounded-xl border px-6 py-10"
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
      <div className="mb-3 flex items-end justify-between gap-4">
        <div>
          <h3
            className="text-sm font-medium"
            style={{ color: "var(--color-text)" }}
          >
            Connected Apps
          </h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Connect your tools to use them with the AI agent
          </p>
        </div>
        {state.connections.filter((c) => c.status === "ACTIVE").length > 0 && (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {state.connections.filter((c) => c.status === "ACTIVE").length} connected
          </span>
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
          <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              type="text"
              placeholder="Search apps..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 text-xs"
            />
          </div>

          {state.categories.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setActiveCategory(null)}
                className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  !activeCategory
                    ? "bg-[var(--color-accent)] text-white"
                    : "bg-[var(--color-surface-hover)] text-muted-foreground hover:text-foreground"
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
                      : "bg-[var(--color-surface-hover)] text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>
          )}

          {featured.length > 0 && (
            <div className="mb-1">
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Popular
              </p>
              <div className="space-y-0.5">
                {featured.map((toolkit) => (
                  <ComposioAppCard
                    key={toolkit.slug}
                    toolkit={toolkit}
                    connection={connectionsByToolkit.get(toolkit.slug) ?? null}
                    onClick={() => handleAppClick(toolkit)}
                  />
                ))}
              </div>
            </div>
          )}

          {rest.length > 0 && (
            <div>
              {featured.length > 0 && (
                <p className="mb-1 mt-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  All Apps
                </p>
              )}
              <div className="space-y-0.5">
                {rest.map((toolkit) => (
                  <ComposioAppCard
                    key={toolkit.slug}
                    toolkit={toolkit}
                    connection={connectionsByToolkit.get(toolkit.slug) ?? null}
                    onClick={() => handleAppClick(toolkit)}
                  />
                ))}
              </div>
            </div>
          )}

          {filteredToolkits.length === 0 && (
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
        connection={selectedConnection}
        open={modalOpen}
        onOpenChange={setModalOpen}
        onConnectionChange={handleConnectionChange}
      />
    </div>
  );
}
