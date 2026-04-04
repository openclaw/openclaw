"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { SiElevenlabs } from "react-icons/si";
import { Button } from "../ui/button";
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

/** Apollo.io mark (vector commonly used for the brand; fill follows theme via currentColor). */
function ApolloIoLogo({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      aria-hidden="true"
      className={className}
    >
      <path
        fill="currentColor"
        d="M32.4,0l-24,49.6h7.8l16.2-33.9l15.5,33.9h7.7L32.4,0z M25.5,49.6L32.4,64l6.7-14.4H25.5z"
      />
    </svg>
  );
}

function integrationLogo(id: DenchIntegrationId): ReactNode {
  switch (id) {
    case "exa":
      return (
        <img
          src="/integrations/exa-logomark.svg"
          alt=""
          width={20}
          height={20}
          className="h-5 w-5 shrink-0 object-contain"
          draggable={false}
        />
      );
    case "apollo":
      return <ApolloIoLogo className="h-5 w-5 shrink-0" />;
    case "elevenlabs":
      return <SiElevenlabs className="h-5 w-5 shrink-0" aria-hidden />;
  }
}

const INTEGRATION_DESCRIPTIONS: Record<DenchIntegrationId, string> = {
  exa: "Search the web with Exa",
  apollo: "Enrich people and company data",
  elevenlabs: "Generate speech with ElevenLabs",
};

function IntegrationCard({
  integration,
  isSaving,
  onToggle,
}: {
  integration: DenchIntegrationState;
  isSaving: boolean;
  onToggle: (integration: DenchIntegrationState, enabled: boolean) => void;
}) {
  const description = INTEGRATION_DESCRIPTIONS[integration.id];
  const statusText = isSaving
    ? "Saving..."
    : integration.locked
      ? "Unavailable until Dench Cloud is ready"
      : description;

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
          {integrationLogo(integration.id)}
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">
            {integration.label}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] leading-4 text-muted-foreground">
            <span>{statusText}</span>
            {integration.lockBadge && (
              <span
                className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
                style={{
                  background: "var(--color-surface-hover)",
                  color: "var(--color-text)",
                }}
              >
                {integration.lockBadge}
              </span>
            )}
          </div>
        </div>
      </div>
      <Switch
        aria-label={`Toggle ${integration.label}`}
        checked={integration.enabled}
        disabled={isSaving || integration.locked}
        onCheckedChange={(checked) => onToggle(integration, checked)}
      />
    </div>
  );
}

export function DenchIntegrationsSection() {
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

      const nextState = payload as IntegrationToggleResponse;
      applyState(nextState);
      if (nextState.refresh.restarted) {
        setNotice({
          tone: "success",
          message: `${integration.label} updated and the ${nextState.refresh.profile} gateway restarted successfully.`,
        });
      } else if (nextState.changed) {
        setNotice({
          tone: "warning",
          message: `${integration.label} updated, but the gateway restart did not complete: ${nextState.refresh.error ?? "unknown error"}.`,
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

      const nextState = payload as IntegrationRepairResponse;
      applyState(nextState);
      if (nextState.changed && nextState.refresh.restarted) {
        const repairedNames = nextState.repairedIds.length > 0 ? nextState.repairedIds.join(", ") : "profiles";
        setNotice({
          tone: "success",
          message: `Repair completed for ${repairedNames} and the ${nextState.refresh.profile} gateway restarted successfully.`,
        });
      } else if (nextState.changed) {
        setNotice({
          tone: "warning",
          message: `Repair updated the profile, but the gateway restart did not complete: ${nextState.refresh.error ?? "unknown error"}.`,
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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div
          className="h-5 w-5 animate-spin rounded-full border-2"
          style={{ borderColor: "var(--color-border)", borderTopColor: "var(--color-accent)" }}
        />
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="rounded-xl border px-4 py-4 text-center"
        style={{ borderColor: "var(--color-border)" }}
      >
        <p className="text-sm mb-2" style={{ color: "var(--color-text-muted)" }}>{error}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void fetchIntegrations()}>
          Retry
        </Button>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-4">
      {notice && <RefreshNoticeBanner notice={notice} />}

      {needsRepair && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void handleRepair()}
          disabled={repairing}
        >
          {repairing ? "Repairing..." : "Repair older profiles"}
        </Button>
      )}

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
  );
}
