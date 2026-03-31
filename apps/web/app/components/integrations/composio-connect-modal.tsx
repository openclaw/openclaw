"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import type { ComposioToolkit, ComposioConnection } from "@/lib/composio";

export function ComposioConnectModal({
  toolkit,
  connection,
  open,
  onOpenChange,
  onConnectionChange,
}: {
  toolkit: ComposioToolkit | null;
  connection: ComposioConnection | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnectionChange: () => void;
}) {
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connected = connection?.status === "ACTIVE";

  useEffect(() => {
    if (!open) {
      setError(null);
      setConnecting(false);
      setDisconnecting(false);
    }
  }, [open]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.data?.type !== "composio-callback") return;
      setConnecting(false);
      if (event.data.status === "success") {
        onConnectionChange();
      } else {
        setError("Connection was not completed. Please try again.");
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onConnectionChange]);

  const handleConnect = useCallback(async () => {
    if (!toolkit) return;
    setConnecting(true);
    setError(null);
    try {
      const res = await fetch("/api/composio/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolkit: toolkit.slug }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? "Failed to start connection.");
      }
      window.open(data.redirect_url, "_blank", "noopener");
    } catch (err) {
      setConnecting(false);
      setError(err instanceof Error ? err.message : "Failed to connect.");
    }
  }, [toolkit]);

  const handleDisconnect = useCallback(async () => {
    if (!connection) return;
    setDisconnecting(true);
    setError(null);
    try {
      const res = await fetch("/api/composio/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connection_id: connection.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? "Failed to disconnect.");
      }
      onConnectionChange();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disconnect.");
    } finally {
      setDisconnecting(false);
    }
  }, [connection, onConnectionChange, onOpenChange]);

  if (!toolkit) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div
              className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg"
              style={{ background: "var(--color-surface-hover)" }}
            >
              {toolkit.logo ? (
                <img src={toolkit.logo} alt="" className="h-6 w-6 object-contain" />
              ) : (
                <span
                  className="text-sm font-semibold uppercase"
                  style={{ color: "var(--color-text-muted)" }}
                >
                  {toolkit.name.slice(0, 2)}
                </span>
              )}
            </div>
            <div>
              <DialogTitle>{toolkit.name}</DialogTitle>
              {toolkit.tools_count > 0 && (
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {toolkit.tools_count} tool{toolkit.tools_count !== 1 ? "s" : ""} available
                </p>
              )}
            </div>
          </div>
        </DialogHeader>

        {toolkit.description && (
          <DialogDescription>{toolkit.description}</DialogDescription>
        )}

        {connected && (
          <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-[12px] text-emerald-300">
            This integration is connected and available to your AI agent.
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-red-300">
            {error}
          </div>
        )}

        <DialogFooter>
          {connected ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void handleDisconnect()}
              disabled={disconnecting}
            >
              {disconnecting ? "Disconnecting..." : "Disconnect"}
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => void handleConnect()}
              disabled={connecting}
            >
              {connecting ? "Waiting for authorization..." : "Connect"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
