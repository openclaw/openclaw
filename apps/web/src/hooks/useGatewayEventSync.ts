/**
 * Gateway Event Sync Hook
 *
 * Applies gateway event-driven refreshes:
 * - presence: updates snapshot presence state
 * - cron: refreshes cron queries
 * - device pairing: refreshes device list
 * - exec approvals: refreshes approval snapshots
 */

import { useCallback, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { GatewayEvent } from "@/lib/api";
import type { PresenceEntry } from "@/lib/api/gateway-snapshot";
import { cronKeys } from "@/hooks/queries/useCron";
import { nodeKeys } from "@/hooks/queries/useNodes";
import { useOptionalGateway } from "@/providers/GatewayProvider";
import { useGatewaySnapshotStore } from "@/stores/useGatewaySnapshotStore";

export interface UseGatewayEventSyncOptions {
  enabled?: boolean;
}

function isPresencePayload(payload: unknown): payload is { presence?: PresenceEntry[] } {
  return !!payload && typeof payload === "object" && "presence" in payload;
}

export function useGatewayEventSync(options: UseGatewayEventSyncOptions = {}) {
  const { enabled = true } = options;
  const gatewayCtx = useOptionalGateway();
  const queryClient = useQueryClient();
  const setPresence = useGatewaySnapshotStore((s) => s.setPresence);

  const invalidateCron = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: cronKeys.all });
  }, [queryClient]);

  const invalidateDevices = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: nodeKeys.devices() });
    void queryClient.invalidateQueries({ queryKey: nodeKeys.list() });
  }, [queryClient]);

  const invalidateExecApprovals = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: nodeKeys.all,
      predicate: (query) =>
        query.queryKey[0] === "nodes" && query.queryKey[1] === "execApprovals",
    });
  }, [queryClient]);

  const handleEvent = useCallback(
    (event: GatewayEvent) => {
      switch (event.event) {
        case "presence": {
          const payload = event.payload;
          if (isPresencePayload(payload) && Array.isArray(payload.presence)) {
            setPresence(payload.presence);
          }
          break;
        }
        case "cron":
          invalidateCron();
          break;
        case "device.pair.requested":
        case "device.pair.resolved":
          invalidateDevices();
          break;
        case "exec.approval.requested":
        case "exec.approval.resolved":
          invalidateExecApprovals();
          break;
      }
    },
    [invalidateCron, invalidateDevices, invalidateExecApprovals, setPresence]
  );

  useEffect(() => {
    if (!enabled) {return;}
    if (!gatewayCtx) {return;}
    return gatewayCtx.addEventListener(handleEvent);
  }, [enabled, gatewayCtx, handleEvent]);
}

export default useGatewayEventSync;
