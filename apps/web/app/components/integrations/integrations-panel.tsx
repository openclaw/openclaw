"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Switch } from "../ui/switch";
import type {
  DenchIntegrationId,
  IntegrationRepairEntry,
  DenchIntegrationState,
  IntegrationRuntimeRefresh,
  IntegrationsState,
} from "@/lib/integrations";

type ActionNotice = {
  tone: "success" | "warning";
  message: string;
};
type IntegrationToggleResponse = IntegrationsState & {
  integration: DenchIntegrationId;
  changed: boolean;
  refresh: IntegrationRuntimeRefresh;
};
type IntegrationRepairResponse = IntegrationsState & {
  changed: boolean;
  repairs: IntegrationRepairEntry[];
  repairedIds: Array<"exa" | "apollo">;
  refresh: IntegrationRuntimeRefresh;
};

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

function ExaIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 fill-none">
      <path d="M5 6h5L5 18h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19 6h-5l5 12h-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ApolloIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 fill-none">
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="2" />
      <path d="M9 15l3-8 3 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.2 12.5h3.6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function ElevenLabsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4 fill-none">
      <path d="M7 5v14" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M11 5v14" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M15 5h2v14h-2" fill="currentColor" />
    </svg>
  );
}

const INTEGRATION_ICONS = {
  exa: ExaIcon,
  apollo: ApolloIcon,
  elevenlabs: ElevenLabsIcon,
} satisfies Record<DenchIntegrationId, () => JSX.Element>;

function IntegrationCard({
  integration,
  isSaving,
  onToggle,
}: {
  integration: DenchIntegrationState;
  isSaving: boolean;
  onToggle: (integration: DenchIntegrationState, enabled: boolean) => void;
}) {
  const Icon = INTEGRATION_ICONS[integration.id];

  return (
    <div
      className="flex items-center justify-between gap-4 rounded-xl px-1 py-2"
      style={{
        background: "transparent",
      }}
    >
      <div className="flex min-w-0 items-center gap-3">
        <div
          className="flex h-9 w-9 items-center justify-center rounded-lg"
          style={{ background: "var(--color-surface-hover)", color: "var(--color-text)" }}
        >
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">
            {integration.label}
          </div>
          <div className="text-xs text-muted-foreground">
            {isSaving ? "Saving..." : integration.enabled ? "Enabled" : "Disabled"}
          </div>
        </div>
      </div>
      <Switch
        aria-label={`Toggle ${integration.label}`}
        checked={integration.enabled}
        disabled={isSaving}
        onCheckedChange={(checked) => onToggle(integration, checked)}
      />
    </div>
  );
}

export function IntegrationsPanel() {
  const [data, setData] = useState<IntegrationsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<DenchIntegrationId | null>(null);
  const [repairing, setRepairing] = useState(false);
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
  const needsRepair = useMemo(
    () => integrations.some(
      (integration) =>
        (integration.id === "exa" || integration.id === "apollo") &&
        integration.health.pluginMissing,
    ),
    [integrations],
  );

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

  const handleRepair = useCallback(async () => {
    setRepairing(true);
    setNotice(null);
    try {
      const response = await fetch("/api/integrations/repair", {
        method: "POST",
      });
      const payload = (await response.json()) as IntegrationRepairResponse | { error?: string };
      if (!response.ok) {
        throw new Error("error" in payload && payload.error ? payload.error : "Failed to repair integrations.");
      }

      applyState(payload);
      if (payload.changed && payload.refresh.restarted) {
        const repairedNames = payload.repairedIds.length > 0 ? payload.repairedIds.join(", ") : "profiles";
        setNotice({
          tone: "success",
          message: `Repair completed for ${repairedNames} and the ${payload.refresh.profile} gateway restarted successfully.`,
        });
      } else if (payload.changed) {
        setNotice({
          tone: "warning",
          message: `Repair updated the profile, but the gateway restart did not complete: ${payload.refresh.error ?? "unknown error"}.`,
        });
      } else {
        setNotice({
          tone: "success",
          message: "No repair changes were needed for this profile.",
        });
      }
    } catch (err) {
      setNotice({
        tone: "warning",
        message: err instanceof Error ? err.message : "Failed to repair integrations.",
      });
    } finally {
      setRepairing(false);
    }
  }, [applyState]);

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
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
            Manage Dench-managed integrations and search ownership in one place.
          </p>
        </div>

        {needsRepair && (
          <Button
            type="button"
            variant="outline"
            onClick={() => void handleRepair()}
            disabled={repairing}
          >
            {repairing ? "Repairing..." : "Repair older profiles"}
          </Button>
        )}
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
          <CardContent>
            <Button type="button" variant="outline" onClick={() => void fetchIntegrations()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {!loading && !error && data && (
        <div className="space-y-6">
          {notice && <RefreshNoticeBanner notice={notice} />}

          <div className="space-y-1">
            {integrations.map((integration) => (
              <IntegrationCard
                key={integration.id}
                integration={integration}
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
