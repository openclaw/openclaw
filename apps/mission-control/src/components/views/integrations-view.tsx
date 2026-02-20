"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Link2,
  RefreshCw,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";

type IntegrationService = "github" | "vercel" | "neon" | "render" | "telegram_master";

interface IntegrationSummary {
  configured: boolean;
  preview: string | null;
  username: string | null;
  teamId: string | null;
  updatedAt: string | null;
}

interface IntegrationsResponse {
  integrations: Record<IntegrationService, IntegrationSummary>;
}

const SERVICES: Array<{
  id: IntegrationService;
  label: string;
  description: string;
  dashboardUrl: string;
}> = [
    {
      id: "github",
      label: "GitHub",
      description: "Track repository activity and status from your command center.",
      dashboardUrl: "https://github.com",
    },
    {
      id: "vercel",
      label: "Vercel",
      description: "Monitor deployments and link production health to tasks.",
      dashboardUrl: "https://vercel.com/dashboard",
    },
    {
      id: "neon",
      label: "Neon",
      description: "Watch database projects and environment status.",
      dashboardUrl: "https://console.neon.tech",
    },
    {
      id: "render",
      label: "Render",
      description: "Track service uptime and deployment state for apps.",
      dashboardUrl: "https://dashboard.render.com",
    },
    {
      id: "telegram_master",
      label: "Telegram Master Bot",
      description: "A master bot token specifically for Mission Control remote administration.",
      dashboardUrl: "https://t.me/BotFather",
    },
  ];

function emptyIntegrationSummary(): Record<IntegrationService, IntegrationSummary> {
  return {
    github: { configured: false, preview: null, username: null, teamId: null, updatedAt: null },
    vercel: { configured: false, preview: null, username: null, teamId: null, updatedAt: null },
    neon: { configured: false, preview: null, username: null, teamId: null, updatedAt: null },
    render: { configured: false, preview: null, username: null, teamId: null, updatedAt: null },
    telegram_master: { configured: false, preview: null, username: null, teamId: null, updatedAt: null },
  };
}

export function IntegrationsView() {
  const [integrations, setIntegrations] = useState<Record<
    IntegrationService,
    IntegrationSummary
  >>(emptyIntegrationSummary);
  const [tokens, setTokens] = useState<Record<IntegrationService, string>>({
    github: "",
    vercel: "",
    neon: "",
    render: "",
    telegram_master: "",
  });
  const [loading, setLoading] = useState(true);
  const [busyService, setBusyService] = useState<IntegrationService | null>(null);
  const [message, setMessage] = useState<{ type: "ok" | "error"; text: string } | null>(null);
  const [restartingGateway, setRestartingGateway] = useState(false);

  const configuredCount = useMemo(() => {
    return Object.values(integrations).filter((entry) => entry.configured).length;
  }, [integrations]);

  const fetchIntegrations = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/integrations");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as IntegrationsResponse;
      setIntegrations(data.integrations || emptyIntegrationSummary());
    } catch (error) {
      setMessage({
        type: "error",
        text: `Failed to load integrations: ${String(error)}`,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchIntegrations();
  }, [fetchIntegrations]);

  const handleSave = useCallback(
    async (service: IntegrationService) => {
      const token = tokens[service]?.trim();
      if (!token) {
        setMessage({ type: "error", text: `Enter a token for ${service}.` });
        return;
      }
      setBusyService(service);
      try {
        const res = await fetch("/api/integrations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ service, token }),
        });
        const data = (await res.json()) as { ok?: boolean; error?: string };
        if (!res.ok || !data.ok) {
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        setTokens((prev) => ({ ...prev, [service]: "" }));
        setMessage({ type: "ok", text: `${service} integration saved.` });
        await fetchIntegrations();
      } catch (error) {
        setMessage({
          type: "error",
          text: `Failed to save ${service}: ${String(error)}`,
        });
      } finally {
        setBusyService(null);
      }
    },
    [fetchIntegrations, tokens]
  );

  const handleRemove = useCallback(
    async (service: IntegrationService) => {
      setBusyService(service);
      try {
        const res = await fetch(`/api/integrations?service=${service}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          const data = (await res.json()) as { error?: string };
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        setMessage({ type: "ok", text: `${service} integration removed.` });
        await fetchIntegrations();
      } catch (error) {
        setMessage({
          type: "error",
          text: `Failed to remove ${service}: ${String(error)}`,
        });
      } finally {
        setBusyService(null);
      }
    },
    [fetchIntegrations]
  );

  const handleRestartGateway = useCallback(async () => {
    setRestartingGateway(true);
    try {
      const res = await fetch("/api/openclaw/restart", { method: "POST" });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      setMessage({ type: "ok", text: "Gateway restart requested successfully." });
    } catch (error) {
      setMessage({
        type: "error",
        text: `Failed to restart gateway: ${String(error)}`,
      });
    } finally {
      setRestartingGateway(false);
    }
  }, []);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2">
            <Link2 className="w-5 h-5 text-primary" />
            Integrations
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Legacy Command Center feature port: manage external service tokens stored locally.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-xs font-mono text-muted-foreground bg-muted px-3 py-1.5 rounded border border-border">
            configured {configuredCount}/{SERVICES.length}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRestartGateway}
            disabled={restartingGateway}
          >
            <RotateCcw className={`w-4 h-4 mr-1.5 ${restartingGateway ? "animate-spin" : ""}`} />
            Restart Gateway
          </Button>
          <Button variant="outline" size="sm" onClick={fetchIntegrations} disabled={loading}>
            <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {message && (
        <div
          className={`rounded-lg border px-4 py-3 text-sm ${message.type === "ok"
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
              : "border-destructive/40 bg-destructive/10 text-destructive"
            }`}
        >
          {message.text}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {SERVICES.map((service) => {
          const status = integrations[service.id];
          const isBusy = busyService === service.id;

          return (
            <div key={service.id} className="bg-card border border-border rounded-xl p-5 space-y-4">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-semibold">{service.label}</h3>
                  <p className="text-xs text-muted-foreground mt-1">{service.description}</p>
                </div>
                <div
                  className={`text-xs px-2 py-1 rounded border ${status?.configured
                      ? "border-emerald-500/40 text-emerald-400 bg-emerald-500/10"
                      : "border-border text-muted-foreground bg-muted/60"
                    }`}
                >
                  {status?.configured ? "Configured" : "Not Configured"}
                </div>
              </div>

              <div className="text-xs text-muted-foreground">
                {status?.configured ? (
                  <span>
                    Token: <span className="font-mono text-foreground">{status.preview}</span>
                  </span>
                ) : (
                  <span>No token saved yet.</span>
                )}
              </div>

              <div className="flex gap-2">
                <div className="relative flex-1">
                  <KeyRound className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="password"
                    value={tokens[service.id]}
                    onChange={(event) =>
                      setTokens((prev) => ({ ...prev, [service.id]: event.target.value }))
                    }
                    placeholder={`Paste ${service.label} token`}
                    maxLength={500}
                    className="w-full h-10 rounded-lg border border-border bg-background pl-9 pr-3 text-sm outline-none focus:border-primary"
                  />
                </div>
                <Button
                  size="sm"
                  onClick={() => handleSave(service.id)}
                  disabled={isBusy}
                >
                  {isBusy ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="w-4 h-4 mr-1.5" />
                  )}
                  Save
                </Button>
              </div>

              <div className="flex items-center justify-between pt-1">
                <a
                  href={service.dashboardUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
                >
                  Open {service.label} dashboard
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
                {status?.configured && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRemove(service.id)}
                    disabled={isBusy}
                    className="text-destructive hover:text-destructive"
                  >
                    <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                    Remove
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
