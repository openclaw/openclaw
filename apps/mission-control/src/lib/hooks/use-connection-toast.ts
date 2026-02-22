"use client";

import { useEffect, useRef, useCallback } from "react";
import type { GatewayConnectionState } from "@/lib/hooks/use-gateway-events";

/**
 * Watches gateway connection state transitions and fires toasts
 * for disconnections and reconnections. Prevents spam by only
 * toasting once per state change after an initial grace period.
 */
export function useConnectionToast(
    connectionState: GatewayConnectionState,
    showToast: (message: string, type: "success" | "error") => void
) {
    const prevStateRef = useRef<GatewayConnectionState>(connectionState);
    const hasBeenConnectedRef = useRef(false);
    const mountTimeRef = useRef(0);

    const handleTransition = useCallback(
        (from: GatewayConnectionState, to: GatewayConnectionState) => {
            // Don't fire toasts during the first 5 seconds (initial connection)
            if (Date.now() - mountTimeRef.current < 5_000) {return;}

            // Track if we've ever been connected
            if (to === "connected") {hasBeenConnectedRef.current = true;}

            // Only fire toasts after we've been connected at least once
            if (!hasBeenConnectedRef.current) {return;}

            if (from === "connected" && to === "disconnected") {
                showToast("Gateway disconnected — reconnecting…", "error");
            } else if (from !== "connected" && to === "connected") {
                showToast("Gateway reconnected", "success");
            }
        },
        [showToast]
    );

    useEffect(() => {
        if (!mountTimeRef.current) {
            mountTimeRef.current = Date.now();
        }
    }, []);

    useEffect(() => {
        const prev = prevStateRef.current;
        prevStateRef.current = connectionState;

        if (prev !== connectionState) {
            handleTransition(prev, connectionState);
        }
    }, [connectionState, handleTransition]);
}
