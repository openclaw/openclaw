"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Activity,
  Server,
  MessageSquare,
  Brain,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  XCircle,
  Loader2,
  ExternalLink,
  Clock,
  Wifi,
  WifiOff,
} from "lucide-react";
import { Link } from "@tanstack/react-router";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { StatusBadge } from "@/components/composed/StatusBadge";
import { errorMessages } from "@/components/composed/ErrorState";
import {
  useGatewayHealth,
  useGatewayConnected,
  useChannelsStatus,
  useConfig,
  useHealthProbe,
} from "@/hooks";
import type { ChannelSummary, ChannelAccountSnapshot } from "@/lib/api";

// Types
type HealthStatus = "healthy" | "degraded" | "error" | "unknown";

interface HealthDashboardProps {
  className?: string;
  /** Callback when user navigates to a settings section */
  onNavigateToSection?: (section: string) => void;
}

// Helper to format uptime
function formatUptime(uptimeMs: number): string {
  const seconds = Math.floor(uptimeMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

// Helper to get overall health status
function getOverallHealth(
  gatewayConnected: boolean,
  channelsConnected: number,
  channelsTotal: number,
  providersConfigured: number
): HealthStatus {
  if (!gatewayConnected) {return "error";}
  if (providersConfigured === 0) {return "degraded";}
  if (channelsTotal > 0 && channelsConnected === 0) {return "degraded";}
  if (channelsConnected < channelsTotal) {return "degraded";}
  return "healthy";
}

// Gateway Status Card
function GatewayStatusCard({
  className,
  onReconnect,
}: {
  className?: string;
  onReconnect?: () => void;
}) {
  const {
    isConnected,
    isLoading,
    isError,
    version,
    uptime,
    refetch,
    isFetching,
  } = useGatewayConnected();
  const { data: healthData } = useGatewayHealth();
  const [isRetrying, setIsRetrying] = React.useState(false);

  const status: "online" | "offline" | "pending" = isLoading
    ? "pending"
    : isConnected
      ? "online"
      : "offline";

  const handleRetry = React.useCallback(async () => {
    setIsRetrying(true);
    try {
      const result = await refetch();
      if (result.data) {
        toast.success("Gateway connected");
      }
    } catch {
      // Error handled by component state
    } finally {
      setIsRetrying(false);
    }
  }, [refetch]);

  return (
    <Card className={cn("", className)}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Server className="h-4 w-4 text-primary" />
            Gateway
          </CardTitle>
          <StatusBadge
            status={status}
            label={
              isLoading
                ? "Checking..."
                : isConnected
                  ? "Connected"
                  : "Disconnected"
            }
            animate={isLoading}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-24" />
          </div>
        ) : isConnected ? (
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Version</span>
              <span className="font-mono text-xs">{version || "unknown"}</span>
            </div>
            {uptime !== undefined && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  Uptime
                </span>
                <span>{formatUptime(uptime)}</span>
              </div>
            )}
            {healthData?.channels && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Active channels</span>
                <span>{Object.keys(healthData.channels).length}</span>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {isError
                ? errorMessages.gateway.description
                : "Gateway is not connected."}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={onReconnect || handleRetry}
              disabled={isRetrying || isFetching}
              className="w-full"
            >
              <RefreshCw className={cn("h-4 w-4", (isRetrying || isFetching) && "animate-spin")} />
              {isRetrying || isFetching ? "Retrying..." : "Reconnect"}
            </Button>
          </div>
        )}

        {/* Quick link */}
        <div className="pt-2 border-t">
          <Link
            to="/settings"
            search={{ section: "gateway" }}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
          >
            Configure gateway
            <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

// Channels Status Card
function ChannelsStatusCard({ className }: { className?: string }) {
  const { data, isLoading, isError, refetch, isFetching } = useChannelsStatus({ probe: false });
  const [isRetrying, setIsRetrying] = React.useState(false);

  const handleRetry = React.useCallback(async () => {
    setIsRetrying(true);
    try {
      await refetch();
      toast.success("Channel status refreshed");
    } catch {
      // Error handled by component state
    } finally {
      setIsRetrying(false);
    }
  }, [refetch]);

  // Calculate channel stats
  const channelStats = React.useMemo(() => {
    if (!data) {return { connected: 0, total: 0, channels: [] as { id: string; label: string; connected: boolean; error?: string }[] };}

    const channelList: { id: string; label: string; connected: boolean; error?: string }[] = [];
    let connected = 0;
    let total = 0;

    for (const channelId of data.channelOrder || []) {
      const summary: ChannelSummary | undefined = data.channels?.[channelId];
      const accounts: ChannelAccountSnapshot[] = data.channelAccounts?.[channelId] || [];
      const label = data.channelLabels?.[channelId] || channelId;

      if (!summary?.configured) {continue;}
      total++;

      const isConnected = summary.connected === true || accounts.some((a) => a.connected);
      const error = summary.error || accounts.find((a) => a.error)?.error;

      if (isConnected) {connected++;}

      channelList.push({
        id: channelId,
        label,
        connected: isConnected,
        error,
      });
    }

    return { connected, total, channels: channelList };
  }, [data]);

  const status: "online" | "offline" | "warning" | "pending" = isLoading
    ? "pending"
    : channelStats.total === 0
      ? "offline"
      : channelStats.connected === channelStats.total
        ? "online"
        : channelStats.connected > 0
          ? "warning"
          : "offline";

  return (
    <Card className={cn("", className)}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-primary" />
            Channels
          </CardTitle>
          <StatusBadge
            status={status}
            label={
              isLoading
                ? "Checking..."
                : `${channelStats.connected} of ${channelStats.total}`
            }
            animate={isLoading}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : isError ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {errorMessages.channels.description}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={handleRetry}
              disabled={isRetrying || isFetching}
              className="w-full"
            >
              <RefreshCw className={cn("h-4 w-4", (isRetrying || isFetching) && "animate-spin")} />
              {isRetrying || isFetching ? "Retrying..." : "Try Again"}
            </Button>
          </div>
        ) : channelStats.total === 0 ? (
          <p className="text-sm text-muted-foreground">
            No channels configured yet.
          </p>
        ) : (
          <div className="space-y-2">
            {channelStats.channels.map((channel) => (
              <div
                key={channel.id}
                className="flex items-center justify-between py-1.5 px-2 rounded-md bg-muted/50"
              >
                <span className="text-sm font-medium">{channel.label}</span>
                <div className="flex items-center gap-2">
                  {channel.error && (
                    <Tooltip>
                      <TooltipTrigger>
                        <AlertCircle className="h-4 w-4 text-warning" />
                      </TooltipTrigger>
                      <TooltipContent>
                        <p className="max-w-xs">{channel.error}</p>
                      </TooltipContent>
                    </Tooltip>
                  )}
                  {channel.connected ? (
                    <Wifi className="h-4 w-4 text-green-500" />
                  ) : (
                    <WifiOff className="h-4 w-4 text-muted-foreground" />
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Quick link */}
        <div className="pt-2 border-t">
          <Link
            to="/settings"
            search={{ section: "channels" }}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
          >
            Configure channels
            <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

// Model Providers Status Card
function ProvidersStatusCard({ className }: { className?: string }) {
  const { data: config, isLoading, isError, refetch, isFetching } = useConfig();
  const [isRetrying, setIsRetrying] = React.useState(false);

  const handleRetry = React.useCallback(async () => {
    setIsRetrying(true);
    try {
      await refetch();
      toast.success("Provider status refreshed");
    } catch {
      // Error handled by component state
    } finally {
      setIsRetrying(false);
    }
  }, [refetch]);

  // Calculate provider stats
  const providerStats = React.useMemo(() => {
    if (!config?.config?.auth) {return { configured: 0, providers: [] as { id: string; name: string; configured: boolean }[] };}

    const providerDefs = [
      { id: "anthropic", name: "Anthropic", key: "anthropic" },
      { id: "openai", name: "OpenAI", key: "openai" },
      { id: "google", name: "Google Gemini", key: "google" },
      { id: "zai", name: "Z.AI (Grok)", key: "xai" },
      { id: "openrouter", name: "OpenRouter", key: "openrouter" },
    ];

    const auth = config.config.auth;
    const providers = providerDefs.map((p) => ({
      id: p.id,
      name: p.name,
      configured: Boolean(auth[p.key]?.apiKey),
    }));

    const configured = providers.filter((p) => p.configured).length;

    return { configured, providers };
  }, [config]);

  const status: "online" | "offline" | "pending" = isLoading
    ? "pending"
    : providerStats.configured > 0
      ? "online"
      : "offline";

  return (
    <Card className={cn("", className)}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Brain className="h-4 w-4 text-primary" />
            AI Providers
          </CardTitle>
          <StatusBadge
            status={status}
            label={
              isLoading
                ? "Checking..."
                : `${providerStats.configured} configured`
            }
            animate={isLoading}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : isError ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {errorMessages.config.description}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={handleRetry}
              disabled={isRetrying || isFetching}
              className="w-full"
            >
              <RefreshCw className={cn("h-4 w-4", (isRetrying || isFetching) && "animate-spin")} />
              {isRetrying || isFetching ? "Retrying..." : "Try Again"}
            </Button>
          </div>
        ) : providerStats.configured === 0 ? (
          <p className="text-sm text-muted-foreground">
            No AI providers configured. Add at least one to enable agents.
          </p>
        ) : (
          <div className="space-y-2">
            {providerStats.providers
              .filter((p) => p.configured)
              .map((provider) => (
                <div
                  key={provider.id}
                  className="flex items-center justify-between py-1.5 px-2 rounded-md bg-muted/50"
                >
                  <span className="text-sm font-medium">{provider.name}</span>
                  <Badge variant="success" className="text-xs gap-1">
                    <CheckCircle2 className="h-3 w-3" />
                    Configured
                  </Badge>
                </div>
              ))}
          </div>
        )}

        {/* Quick link */}
        <div className="pt-2 border-t">
          <Link
            to="/settings"
            search={{ section: "ai-provider" }}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
          >
            Configure providers
            <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

// Main Health Dashboard Component
export function HealthDashboard({ className }: HealthDashboardProps) {
  const { isConnected, isLoading: gatewayLoading } = useGatewayConnected();
  const {
    data: channelsData,
    isLoading: channelsLoading,
  } = useChannelsStatus({ probe: false });
  const {
    data: config,
    isLoading: configLoading,
  } = useConfig();
  const healthProbe = useHealthProbe();

  // Calculate overall stats
  const stats = React.useMemo(() => {
    // Channels
    let channelsConnected = 0;
    let channelsTotal = 0;

    if (channelsData) {
      for (const channelId of channelsData.channelOrder || []) {
        const summary = channelsData.channels?.[channelId];
        if (!summary?.configured) {continue;}
        channelsTotal++;
        if (summary.connected) {channelsConnected++;}
      }
    }

    // Providers
    let providersConfigured = 0;
    if (config?.config?.auth) {
      const auth = config.config.auth;
      const keys = ["anthropic", "openai", "google", "xai", "openrouter"];
      providersConfigured = keys.filter((k) => auth[k]?.apiKey).length;
    }

    return {
      channelsConnected,
      channelsTotal,
      providersConfigured,
    };
  }, [channelsData, config]);

  const overallHealth = getOverallHealth(
    isConnected,
    stats.channelsConnected,
    stats.channelsTotal,
    stats.providersConfigured
  );

  const isLoading = gatewayLoading || channelsLoading || configLoading;

  // Run diagnostics with deep health probing
  const runDiagnostics = async () => {
    try {
      const result = await healthProbe.mutateAsync();

      // Show result toast based on probe results
      const issues: string[] = [];

      if (!result.gateway.ok) {
        issues.push("Gateway health check failed");
      }
      if (result.providers.configured === 0) {
        issues.push("No AI providers configured");
      }
      if (result.channels.total > 0 && result.channels.connected < result.channels.total) {
        issues.push(`${result.channels.total - result.channels.connected} of ${result.channels.total} channel(s) disconnected`);
      }
      if (result.channels.errors.length > 0) {
        issues.push(`${result.channels.errors.length} channel error(s)`);
      }

      if (issues.length === 0) {
        toast.success("All systems operational", {
          description: "Gateway, channels, and providers are healthy.",
        });
      } else {
        toast.warning(`${issues.length} issue${issues.length > 1 ? "s" : ""} found`, {
          description: issues.join(", "),
        });
      }
    } catch (error) {
      toast.error("Diagnostics failed", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    }
  };

  // Overall health indicator
  const healthConfig = {
    healthy: {
      icon: CheckCircle2,
      color: "text-green-500",
      bg: "bg-green-500/10",
      label: "All Systems Operational",
    },
    degraded: {
      icon: AlertCircle,
      color: "text-amber-500",
      bg: "bg-amber-500/10",
      label: "Some Issues Detected",
    },
    error: {
      icon: XCircle,
      color: "text-red-500",
      bg: "bg-red-500/10",
      label: "System Unavailable",
    },
    unknown: {
      icon: Loader2,
      color: "text-muted-foreground",
      bg: "bg-muted",
      label: "Checking Status...",
    },
  };

  const currentHealth = isLoading ? healthConfig.unknown : healthConfig[overallHealth];
  const HealthIcon = currentHealth.icon;

  return (
    <div className={cn("space-y-6", className)}>
      {/* Header with overall status */}
      <Card className={cn("border-2", currentHealth.bg)}>
        <CardContent className="flex items-center justify-between py-4">
          <div className="flex items-center gap-4">
            <div
              className={cn(
                "flex h-12 w-12 items-center justify-center rounded-full",
                currentHealth.bg
              )}
            >
              <HealthIcon
                className={cn(
                  "h-6 w-6",
                  currentHealth.color,
                  isLoading && "animate-spin"
                )}
              />
            </div>
            <div>
              <h3 className="font-semibold">{currentHealth.label}</h3>
              <p className="text-sm text-muted-foreground">
                {isLoading
                  ? "Checking system health..."
                  : overallHealth === "healthy"
                    ? "Everything is working correctly"
                    : overallHealth === "degraded"
                      ? "Some components need attention"
                      : "Unable to connect to gateway"}
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            onClick={runDiagnostics}
            disabled={healthProbe.isPending}
          >
            {healthProbe.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Probing...
              </>
            ) : (
              <>
                <Activity className="h-4 w-4" />
                Run Diagnostics
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Status Cards Grid */}
      <div className="grid gap-4 md:grid-cols-3">
        <GatewayStatusCard />
        <ChannelsStatusCard />
        <ProvidersStatusCard />
      </div>
    </div>
  );
}

export default HealthDashboard;
