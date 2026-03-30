"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import type { DenchIntegrationState, IntegrationsState } from "@/lib/integrations";

type IntegrationStatus = "healthy" | "degraded" | "disabled";

function statusCopy(status: IntegrationStatus): string {
  switch (status) {
    case "healthy":
      return "Healthy";
    case "degraded":
      return "Needs attention";
    case "disabled":
      return "Disabled";
  }
}

function toneClasses(status: IntegrationStatus): string {
  switch (status) {
    case "healthy":
      return "bg-emerald-500/10 text-emerald-200 border-emerald-500/20";
    case "degraded":
      return "bg-amber-500/10 text-amber-200 border-amber-500/20";
    case "disabled":
      return "bg-zinc-500/10 text-zinc-300 border-zinc-500/20";
  }
}

function friendlyHealthIssue(issue: string): string {
  switch (issue) {
    case "missing_plugin_entry":
      return "Plugin entry is missing from OpenClaw config";
    case "plugin_disabled":
      return "Plugin is installed but disabled";
    case "plugin_not_allowlisted":
      return "Plugin is not in the OpenClaw allowlist";
    case "plugin_load_path_missing":
      return "Plugin load path is missing";
    case "plugin_install_missing":
      return "Plugin install metadata is missing";
    case "plugin_install_path_missing":
      return "Plugin install path is missing on disk";
    case "missing_auth":
      return "Dench auth is not configured";
    case "missing_gateway":
      return "Gateway URL is missing";
    case "missing_override":
      return "Dench ElevenLabs override is missing";
    case "built_in_search_still_enabled":
      return "Built-in web_search is still enabled";
    default:
      return issue;
  }
}

function boolCopy(value: boolean): string {
  return value ? "Yes" : "No";
}

function SearchOwnershipCard({ state }: { state: IntegrationsState }) {
  const fallbackProvider = state.metadata.exa?.fallbackProvider ?? "duckduckgo";

  return (
    <Card className="border-border/80 bg-card/70">
      <CardHeader>
        <CardTitle>Search Ownership</CardTitle>
        <CardDescription>
          Exa controls whether Dench search owns the web-search workflow or hands it back to built-in search.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-3">
        <Stat label="Effective owner" value={state.search.effectiveOwner === "exa" ? "Dench Exa" : state.search.effectiveOwner === "web_search" ? "Built-in web_search" : "None"} />
        <Stat label="Built-in search enabled" value={boolCopy(state.search.builtIn.enabled)} />
        <Stat label="Fallback provider" value={state.search.builtIn.provider ?? fallbackProvider} />
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/70 bg-background/30 p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-medium text-foreground">{value}</div>
    </div>
  );
}

function IntegrationCard({ integration, state }: { integration: DenchIntegrationState; state: IntegrationsState }) {
  const exaOwnsSearch = integration.id === "exa" && state.search.effectiveOwner === "exa";
  const status = integration.health.status;

  return (
    <Card className="h-full border-border/80 bg-card/70">
      <CardHeader className="gap-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>{integration.label}</CardTitle>
            <CardDescription className="mt-1">
              {integration.id === "exa"
                ? "Dench-routed search tools with built-in web_search fallback control."
                : integration.id === "apollo"
                  ? "Dench-routed people and company enrichment lookups."
                  : "Dench-managed ElevenLabs gateway override for TTS requests."}
            </CardDescription>
          </div>
          <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${toneClasses(status)}`}>
            {statusCopy(status)}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Stat label="Enabled" value={boolCopy(integration.enabled)} />
          <Stat label="Available" value={boolCopy(integration.available)} />
          <Stat label="Auth source" value={integration.auth.source} />
          <Stat label="Gateway" value={integration.gatewayBaseUrl ?? "Not set"} />
          {integration.plugin ? (
            <>
              <Stat label="Plugin configured" value={boolCopy(integration.plugin.configured)} />
              <Stat label="Plugin installed" value={boolCopy(integration.plugin.installRecorded && integration.plugin.installPathExists)} />
            </>
          ) : (
            <>
              <Stat label="Override active" value={boolCopy(Boolean(integration.overrideActive))} />
              <Stat label="Managed by Dench" value={boolCopy(integration.managedByDench)} />
            </>
          )}
        </div>

        {integration.id === "exa" && (
          <div className="rounded-xl border border-border/70 bg-background/30 p-4 text-sm text-muted-foreground">
            {exaOwnsSearch
              ? "Exa currently owns search, so built-in web_search is suppressed."
              : `If Exa is disabled, built-in web_search falls back to ${state.search.builtIn.provider ?? state.metadata.exa?.fallbackProvider ?? "duckduckgo"}.`}
          </div>
        )}

        {integration.healthIssues.length > 0 && (
          <div>
            <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
              Health details
            </div>
            <ul className="space-y-2 text-sm text-muted-foreground">
              {integration.healthIssues.map((issue) => (
                <li key={issue} className="rounded-lg border border-border/70 bg-background/20 px-3 py-2">
                  {friendlyHealthIssue(issue)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function IntegrationsPanel() {
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

  const integrations = useMemo(() => data?.integrations ?? [], [data]);

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-6">
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
          Manage Dench-managed integrations and search ownership in one place.
        </p>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16">
          <div
            className="h-6 w-6 animate-spin rounded-full border-2"
            style={{ borderColor: "var(--color-border)", borderTopColor: "var(--color-accent)" }}
          />
        </div>
      )}

      {!loading && error && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardHeader>
            <CardTitle>Could not load integrations</CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
        </Card>
      )}

      {!loading && !error && data && (
        <div className="space-y-6">
          <SearchOwnershipCard state={data} />

          <div className="grid gap-6 lg:grid-cols-3">
            {integrations.map((integration) => (
              <IntegrationCard
                key={integration.id}
                integration={integration}
                state={data}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
