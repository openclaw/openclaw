"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Switch } from "../ui/switch";
import type {
  DenchIntegrationId,
  DenchIntegrationState,
  IntegrationRuntimeRefresh,
  IntegrationsState,
} from "@/lib/integrations";

type IntegrationStatus = "healthy" | "degraded" | "disabled";
type ActionNotice = {
  tone: "success" | "warning";
  message: string;
};
type IntegrationToggleResponse = IntegrationsState & {
  integration: DenchIntegrationId;
  changed: boolean;
  refresh: IntegrationRuntimeRefresh;
};

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

function RefreshNoticeBanner({ notice }: { notice: ActionNotice }) {
  const toneClass = notice.tone === "success"
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"
    : "border-amber-500/30 bg-amber-500/10 text-amber-100";

  return (
    <div className={`rounded-xl border px-4 py-3 text-sm ${toneClass}`}>
      {notice.message}
    </div>
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

function IntegrationCard({
  integration,
  state,
  isSaving,
  onToggle,
}: {
  integration: DenchIntegrationState;
  state: IntegrationsState;
  isSaving: boolean;
  onToggle: (integration: DenchIntegrationState, enabled: boolean) => void;
}) {
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
          <div className="flex flex-col items-end gap-2">
            <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${toneClasses(status)}`}>
              {statusCopy(status)}
            </span>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {isSaving ? "Saving..." : integration.enabled ? "On" : "Off"}
              </span>
              <Switch
                aria-label={`Toggle ${integration.label}`}
                checked={integration.enabled}
                disabled={isSaving}
                onCheckedChange={(checked) => onToggle(integration, checked)}
              />
            </div>
          </div>
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
  const [savingId, setSavingId] = useState<DenchIntegrationId | null>(null);
  const [notice, setNotice] = useState<ActionNotice | null>(null);

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

  const applyState = useCallback((nextState: IntegrationsState) => {
    setData(nextState);
  }, []);

  const handleToggle = useCallback(async (integration: DenchIntegrationState, enabled: boolean) => {
    setSavingId(integration.id);
    setNotice(null);
    try {
      const response = await fetch(`/api/integrations/${integration.id}/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const payload = (await response.json()) as IntegrationToggleResponse | { error?: string };
      if (!response.ok) {
        throw new Error("error" in payload && payload.error ? payload.error : `Failed to update ${integration.label}`);
      }

      applyState(payload);
      if (payload.refresh.restarted) {
        setNotice({
          tone: "success",
          message: `${integration.label} updated and the ${payload.refresh.profile} gateway restarted successfully.`,
        });
      } else if (payload.changed) {
        setNotice({
          tone: "warning",
          message: `${integration.label} updated, but the gateway restart did not complete: ${payload.refresh.error ?? "unknown error"}.`,
        });
      } else {
        setNotice({
          tone: "success",
          message: `${integration.label} was already in the requested state.`,
        });
      }
    } catch (err) {
      setNotice({
        tone: "warning",
        message: err instanceof Error ? err.message : `Failed to update ${integration.label}.`,
      });
    } finally {
      setSavingId(null);
    }
  }, [applyState]);

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
          {notice && <RefreshNoticeBanner notice={notice} />}

          <SearchOwnershipCard state={data} />

          <div className="grid gap-6 lg:grid-cols-3">
            {integrations.map((integration) => (
              <IntegrationCard
                key={integration.id}
                integration={integration}
                state={data}
                isSaving={savingId === integration.id}
                onToggle={handleToggle}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
