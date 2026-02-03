/**
 * React Query hooks for health monitoring and probing.
 *
 * This module provides specialized health-checking functionality beyond
 * the basic useGatewayHealth hook, including:
 * - Deep health probing with connectivity checks
 * - Combined system health status
 * - Health history tracking
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getHealth, getChannelsStatus, getStatus } from "@/lib/api";
import type { HealthResponse, StatusResponse, ChannelStatusResponse } from "@/lib/api";
import { gatewayKeys } from "./useGateway";
import { channelKeys } from "./useChannels";

// Query keys factory
export const healthKeys = {
  all: ["health"] as const,
  probe: () => [...healthKeys.all, "probe"] as const,
  system: () => [...healthKeys.all, "system"] as const,
};

/**
 * Combined system health status
 */
export interface SystemHealthStatus {
  timestamp: number;
  gateway: {
    connected: boolean;
    version?: string;
    uptime?: number;
    ok: boolean;
  };
  channels: {
    total: number;
    connected: number;
    configured: number;
    errors: string[];
  };
  providers: {
    configured: number;
  };
  overall: "healthy" | "degraded" | "error" | "unknown";
}

/**
 * Hook to perform a deep health probe.
 *
 * Unlike useGatewayHealth, this mutation:
 * - Always probes (probe=true)
 * - Probes channels with connectivity checks
 * - Returns combined status
 * - Invalidates related queries on completion
 */
export function useHealthProbe() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (): Promise<SystemHealthStatus> => {
      const [healthResult, channelsResult, statusResult] = await Promise.all([
        getHealth(true).catch((err): HealthResponse => ({
          ts: Date.now(),
          ok: false,
          error: err instanceof Error ? err.message : "Health probe failed",
        })),
        getChannelsStatus({ probe: true, timeoutMs: 15000 }).catch(
          (err): ChannelStatusResponse & { error?: string } => ({
            ts: Date.now(),
            channelOrder: [],
            channelLabels: {},
            channelMeta: {},
            channels: {},
            channelAccounts: {},
            channelDefaultAccountId: {},
            error: err instanceof Error ? err.message : "Channel probe failed",
          })
        ),
        getStatus().catch(
          (err): StatusResponse & { error?: string } => ({
            gateway: { running: false },
            channels: {},
            auth: { configured: false, providers: [] },
            error: err instanceof Error ? err.message : "Status probe failed",
          })
        ),
      ]);

      // Analyze channel health
      let channelsTotal = 0;
      let channelsConnected = 0;
      let channelsConfigured = 0;
      const channelErrors: string[] = [];

      for (const channelId of channelsResult.channelOrder || []) {
        const summary = channelsResult.channels?.[channelId];
        const accounts = channelsResult.channelAccounts?.[channelId] || [];

        if (summary?.configured) {
          channelsConfigured++;
          channelsTotal++;

          if (summary.connected || accounts.some((a) => a.connected)) {
            channelsConnected++;
          }

          if (summary.error) {
            channelErrors.push(`${channelId}: ${summary.error}`);
          }

          accounts.forEach((account) => {
            if (account.error) {
              channelErrors.push(`${channelId}/${account.accountId}: ${account.error}`);
            }
          });
        }
      }

      // Determine overall health
      let overall: SystemHealthStatus["overall"] = "healthy";

      if (!healthResult.ok) {
        overall = "error";
      } else if (channelsConfigured > 0 && channelsConnected === 0) {
        overall = "error";
      } else if (channelErrors.length > 0 || channelsConnected < channelsTotal) {
        overall = "degraded";
      } else if (!statusResult.auth.configured) {
        overall = "degraded";
      }

      return {
        timestamp: Date.now(),
        gateway: {
          connected: healthResult.ok ?? false,
          version: healthResult.version,
          uptime: healthResult.uptime,
          ok: healthResult.ok ?? false,
        },
        channels: {
          total: channelsTotal,
          connected: channelsConnected,
          configured: channelsConfigured,
          errors: channelErrors,
        },
        providers: {
          configured: statusResult.auth.providers?.length ?? 0,
        },
        overall,
      };
    },
    onSuccess: () => {
      // Invalidate related queries to refresh UI with latest data
      queryClient.invalidateQueries({ queryKey: gatewayKeys.all });
      queryClient.invalidateQueries({ queryKey: channelKeys.all });
    },
  });
}

/**
 * Hook to get combined system health status.
 *
 * This is a polling query that combines gateway health, channel status,
 * and provider configuration into a single status object.
 *
 * @param options.enabled - Whether to enable the query
 * @param options.refetchInterval - How often to refetch (default: 60000ms)
 */
export function useSystemHealth(options?: {
  enabled?: boolean;
  refetchInterval?: number;
}) {
  const { enabled = true, refetchInterval = 60000 } = options ?? {};

  return useQuery({
    queryKey: healthKeys.system(),
    queryFn: async (): Promise<SystemHealthStatus> => {
      const [healthResult, channelsResult, statusResult] = await Promise.all([
        getHealth(false).catch(
          (): HealthResponse => ({
            ts: Date.now(),
            ok: false,
          })
        ),
        getChannelsStatus({ probe: false }).catch(
          (): ChannelStatusResponse => ({
            ts: Date.now(),
            channelOrder: [],
            channelLabels: {},
            channelMeta: {},
            channels: {},
            channelAccounts: {},
            channelDefaultAccountId: {},
          })
        ),
        getStatus().catch(
          (): StatusResponse => ({
            gateway: { running: false },
            channels: {},
            auth: { configured: false, providers: [] },
          })
        ),
      ]);

      // Analyze channel health
      let channelsTotal = 0;
      let channelsConnected = 0;
      let channelsConfigured = 0;
      const channelErrors: string[] = [];

      for (const channelId of channelsResult.channelOrder || []) {
        const summary = channelsResult.channels?.[channelId];
        const accounts = channelsResult.channelAccounts?.[channelId] || [];

        if (summary?.configured) {
          channelsConfigured++;
          channelsTotal++;

          if (summary.connected || accounts.some((a) => a.connected)) {
            channelsConnected++;
          }

          if (summary.error) {
            channelErrors.push(`${channelId}: ${summary.error}`);
          }
        }
      }

      // Determine overall health
      let overall: SystemHealthStatus["overall"] = "healthy";

      if (!healthResult.ok) {
        overall = "error";
      } else if (channelsConfigured > 0 && channelsConnected === 0) {
        overall = "error";
      } else if (channelErrors.length > 0 || channelsConnected < channelsTotal) {
        overall = "degraded";
      } else if (!statusResult.auth.configured) {
        overall = "degraded";
      }

      return {
        timestamp: Date.now(),
        gateway: {
          connected: healthResult.ok ?? false,
          version: healthResult.version,
          uptime: healthResult.uptime,
          ok: healthResult.ok ?? false,
        },
        channels: {
          total: channelsTotal,
          connected: channelsConnected,
          configured: channelsConfigured,
          errors: channelErrors,
        },
        providers: {
          configured: statusResult.auth.providers?.length ?? 0,
        },
        overall,
      };
    },
    enabled,
    staleTime: 30000, // 30 seconds
    refetchInterval,
  });
}

// Re-export types
export type { HealthResponse, StatusResponse };
