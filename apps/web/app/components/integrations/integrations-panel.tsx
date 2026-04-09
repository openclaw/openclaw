"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "../ui/button";
import type { IntegrationsState } from "@/lib/integrations";
import { ComposioAppsSection } from "./composio-apps-section";

export function IntegrationsPanel({ embedded }: { embedded?: boolean } = {}) {
  const [data, setData] = useState<IntegrationsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchIntegrations = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/integrations");
      if (!response.ok) {
        throw new Error(`Failed to load integrations (${response.status})`);
      }
      const payload = (await response.json()) as IntegrationsState;
      setData(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load integrations");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchIntegrations();
  }, [fetchIntegrations]);

  return (
    <div className={embedded ? "" : ""}>
      {!embedded && (
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1
              className="font-instrument text-3xl tracking-tight"
              style={{ color: "var(--color-text)" }}
            >
              Integrations
            </h1>
            <p
              className="mt-1 text-sm"
              style={{ color: "var(--color-text-muted)" }}
            >
              Connect third-party apps to your Dench Cloud workspace.
            </p>
          </div>
          <a
            className="flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-medium transition-opacity hover:opacity-80"
            style={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text-muted)",
            }}
          >
            Powered by
            <img
              src="/logo/composio.webp"
              alt="Composio"
              className="h-10 w-auto dark:invert"
            />
          </a>
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-16">
          <div
            className="h-6 w-6 animate-spin rounded-full border-2"
            style={{ borderColor: "var(--color-border)", borderTopColor: "var(--color-accent)" }}
          />
        </div>
      )}

      {!loading && error && (
        <div
          className="rounded-xl border px-4 py-6 text-center"
          style={{ borderColor: "var(--color-border)" }}
        >
          <p className="text-sm mb-3" style={{ color: "var(--color-text-muted)" }}>{error}</p>
          <Button type="button" variant="outline" onClick={() => void fetchIntegrations()}>
            Retry
          </Button>
        </div>
      )}

      {!loading && !error && data && (
        <ComposioAppsSection
          eligible={Boolean(data.denchCloud.hasKey && data.denchCloud.isPrimaryProvider)}
          lockBadge={
            !data.denchCloud.hasKey
              ? "Get Dench Cloud API Key"
              : !data.denchCloud.isPrimaryProvider
                ? "Use Dench Cloud"
                : null
          }
        />
      )}
    </div>
  );
}
