"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  useGatewayConnectionState,
  useGatewayEvents,
  type GatewayConnectionState,
  type GatewayEvent,
} from "@/lib/hooks/use-gateway-events";

export interface GatewayTelemetry {
  connectionState: GatewayConnectionState;
  eventsPerMinute: number;
  lastEventAt: string | null;
}

/**
 * Tracks gateway stream health and throughput.
 */
export function useGatewayTelemetry(windowMs = 60_000): GatewayTelemetry {
  const [connectionState, setConnectionState] =
    useState<GatewayConnectionState>("connecting");
  const [eventsPerMinute, setEventsPerMinute] = useState(0);
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);

  const timestampsRef = useRef<number[]>([]);

  const pruneAndCompute = useCallback(() => {
    const now = Date.now();
    const cutoff = now - windowMs;
    const timestamps = timestampsRef.current;
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }
    const scaled = Math.round((timestamps.length * 60_000) / windowMs);
    setEventsPerMinute(scaled);
  }, [windowMs]);

  const handleConnectionState = useCallback((state: GatewayConnectionState) => {
    setConnectionState(state);
  }, []);

  const handleGatewayEvent = useCallback(
    (event: GatewayEvent) => {
      if (event.type !== "gateway_event") {return;}
      timestampsRef.current.push(Date.now());
      setLastEventAt(event.ts || new Date().toISOString());
      pruneAndCompute();
    },
    [pruneAndCompute]
  );

  useGatewayConnectionState(handleConnectionState);
  useGatewayEvents(handleGatewayEvent);

  useEffect(() => {
    const intervalId = setInterval(() => {
      pruneAndCompute();
    }, 1000);
    return () => clearInterval(intervalId);
  }, [pruneAndCompute]);

  return {
    connectionState,
    eventsPerMinute,
    lastEventAt,
  };
}
