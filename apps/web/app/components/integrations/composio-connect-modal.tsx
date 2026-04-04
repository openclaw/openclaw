"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import {
  type ComposioToolkit,
  type ComposioConnection,
} from "@/lib/composio";
import { normalizeComposioConnections } from "@/lib/composio-client";

function ModalLogoBox({ logo, name }: { logo: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  const showImg = logo && !failed;
  return (
    <div
      className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-xl"
      style={{ background: "var(--color-surface-hover)", border: "1px solid var(--color-border)" }}
    >
      {showImg ? (
        <img
          src={logo}
          alt=""
          className="h-8 w-8 object-contain"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <span
          className="text-base font-semibold uppercase"
          style={{ color: "var(--color-text-muted)" }}
        >
          {name.slice(0, 2)}
        </span>
      )}
    </div>
  );
}

function formatAuthScheme(scheme: string): string {
  const map: Record<string, string> = {
    OAUTH2: "OAuth 2.0",
    OAUTH1: "OAuth 1.0",
    API_KEY: "API Key",
    BASIC: "Basic Auth",
    BEARER_TOKEN: "Bearer Token",
    JWT: "JWT",
    NO_AUTH: "No Auth",
  };
  return map[scheme] ?? scheme.replace(/_/g, " ");
}

function formatConnectionDate(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "Connected recently";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(timestamp);
}

export function ComposioConnectModal({
  toolkit,
  connections,
  open,
  preferredAction,
  onOpenChange,
  onConnectionChange,
}: {
  toolkit: ComposioToolkit | null;
  connections: ComposioConnection[];
  open: boolean;
  preferredAction?: "connect" | "reconnect";
  onOpenChange: (open: boolean) => void;
  onConnectionChange: (payload?: {
    toolkit?: ComposioToolkit | null;
    connected?: boolean;
    connectedToolkitSlug?: string | null;
    connectedToolkitName?: string | null;
    shouldProbeLiveAgent?: boolean;
  }) => void;
}) {
  const [connecting, setConnecting] = useState(false);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const popupRef = useRef<Window | null>(null);
  const popupPollRef = useRef<number | null>(null);
  const callbackHandledRef = useRef(false);

  const normalizedConnections = useMemo(
    () => normalizeComposioConnections(connections),
    [connections],
  );
  const activeConnections = useMemo(
    () => normalizedConnections.filter((connection) => connection.is_active),
    [normalizedConnections],
  );
  const connected = activeConnections.length > 0;
  const primaryAction = preferredAction
    ?? (connected ? "connect" : normalizedConnections.length > 0 ? "reconnect" : "connect");

  const stopPopupPolling = useCallback(() => {
    if (popupPollRef.current !== null) {
      window.clearInterval(popupPollRef.current);
      popupPollRef.current = null;
    }
  }, []);

  const clearPopupState = useCallback(() => {
    stopPopupPolling();
    popupRef.current = null;
    callbackHandledRef.current = false;
  }, [stopPopupPolling]);

  useEffect(() => {
    if (!open) {
      setError(null);
      setConnecting(false);
      setDisconnectingId(null);
      clearPopupState();
    }
  }, [clearPopupState, open]);

  useEffect(() => clearPopupState, [clearPopupState]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.data?.type !== "composio-callback") return;
      if (event.origin !== window.location.origin) return;

      callbackHandledRef.current = true;
      stopPopupPolling();
      popupRef.current = null;
      setConnecting(false);
      if (event.data.status === "success") {
        onConnectionChange({
          toolkit,
          connected: true,
          connectedToolkitSlug:
            typeof event.data.connected_toolkit_slug === "string"
              ? event.data.connected_toolkit_slug
              : toolkit?.slug ?? null,
          connectedToolkitName:
            typeof event.data.connected_toolkit_name === "string"
              ? event.data.connected_toolkit_name
              : toolkit?.name ?? null,
          shouldProbeLiveAgent: true,
        });
        onOpenChange(false);
      } else {
        setError("Connection was not completed. Please try again.");
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onConnectionChange, onOpenChange, stopPopupPolling, toolkit]);

  const handleConnect = useCallback(async () => {
    if (!toolkit) return;
    setConnecting(true);
    setError(null);
    clearPopupState();
    try {
      const res = await fetch("/api/composio/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolkit: toolkit.connect_slug ?? toolkit.slug }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? "Failed to start connection.");
      }
      const popup = window.open(
        data.redirect_url,
        "_blank",
        "popup=yes,width=560,height=720,resizable=yes,scrollbars=yes",
      );
      if (!popup) {
        throw new Error("Popup was blocked. Please allow popups and try again.");
      }

      popupRef.current = popup;
      callbackHandledRef.current = false;
      popup.focus?.();
      popupPollRef.current = window.setInterval(() => {
        const currentPopup = popupRef.current;
        if (!currentPopup || !currentPopup.closed) return;

        stopPopupPolling();
        popupRef.current = null;
        setConnecting(false);
        if (!callbackHandledRef.current) {
          onConnectionChange({ toolkit });
          onOpenChange(false);
        }
      }, 500);
    } catch (err) {
      setConnecting(false);
      setError(err instanceof Error ? err.message : "Failed to connect.");
    }
  }, [clearPopupState, onConnectionChange, onOpenChange, stopPopupPolling, toolkit]);

  const handleDisconnect = useCallback(async (connectionId: string) => {
    setDisconnectingId(connectionId);
    setError(null);
    try {
      const res = await fetch("/api/composio/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connection_id: connectionId }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? "Failed to disconnect.");
      }
      onConnectionChange({ toolkit, connected: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disconnect.");
    } finally {
      setDisconnectingId(null);
    }
  }, [onConnectionChange]);

  if (!toolkit) return null;

  const authLabel = toolkit.auth_schemes.length > 0
    ? toolkit.auth_schemes.map(formatAuthScheme).join(", ")
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg p-0 gap-0 overflow-hidden">
        {/* Hero header */}
        <div
          className="px-6 pt-6 pb-4"
          style={{ borderBottom: "1px solid var(--color-border)" }}
        >
          <DialogHeader className="space-y-0">
            <div className="flex items-start gap-4">
              <ModalLogoBox logo={toolkit.logo} name={toolkit.name} />
              <div className="min-w-0 flex-1">
                <DialogTitle className="text-lg leading-tight">{toolkit.name}</DialogTitle>
                {toolkit.description && (
                  <DialogDescription className="mt-1 text-[13px] leading-relaxed line-clamp-2">
                    {toolkit.description}
                  </DialogDescription>
                )}
              </div>
            </div>
          </DialogHeader>

          {/* Stats row */}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {toolkit.tools_count > 0 && (
              <span
                className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium"
                style={{ background: "var(--color-surface-hover)", color: "var(--color-text)" }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                </svg>
                {toolkit.tools_count} tool{toolkit.tools_count !== 1 ? "s" : ""}
              </span>
            )}
            {authLabel && (
              <span
                className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium"
                style={{ background: "var(--color-surface-hover)", color: "var(--color-text)" }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                {authLabel}
              </span>
            )}
            {connected && (
              <span
                className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium"
                style={{ background: "rgba(16, 185, 129, 0.1)", color: "rgb(74 222 128)", border: "1px solid rgba(16, 185, 129, 0.2)" }}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                {activeConnections.length} connected
              </span>
            )}
          </div>

          {/* Category pills */}
          {toolkit.categories.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {toolkit.categories.slice(0, 5).map((cat) => (
                <span
                  key={cat}
                  className="rounded-full px-2 py-0.5 text-[11px]"
                  style={{ background: "var(--color-surface-hover)", color: "var(--color-text-muted)" }}
                >
                  {cat}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Body */}
        <div className="px-6 py-4 space-y-3 max-h-[340px] overflow-y-auto">
          {error && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-red-300">
              {error}
            </div>
          )}

          {normalizedConnections.length > 0 ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <h4 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Connections
                </h4>
                <span className="text-[11px] text-muted-foreground">
                  {normalizedConnections.length} total
                </span>
              </div>

              {normalizedConnections.map((connection, index) => {
                const buttonLabel = connection.is_active ? "Disconnect" : "Remove";
                const showReconnectBadge = connection.is_same_account_reconnect;
                const showInferredIdentityBadge =
                  connection.account_identity_source !== "gateway_stable_id";
                return (
                  <div
                    key={connection.id}
                    className="rounded-xl border px-3 py-3"
                    style={{
                      borderColor: connection.is_active ? "rgba(16, 185, 129, 0.22)" : "var(--color-border)",
                      background: connection.is_active ? "rgba(16, 185, 129, 0.05)" : "var(--color-surface-hover)",
                    }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate text-sm font-medium text-foreground">
                            {connection.display_label}
                          </p>
                          <span
                            className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
                            style={{
                              background: connection.is_active ? "rgba(16, 185, 129, 0.15)" : "var(--color-background)",
                              color: connection.is_active ? "rgb(74 222 128)" : "var(--color-text-muted)",
                              border: connection.is_active
                                ? "1px solid rgba(16, 185, 129, 0.24)"
                                : "1px solid var(--color-border)",
                            }}
                          >
                            {connection.normalized_status}
                          </span>
                        </div>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {connection.account_email || connection.account_name || connection.account_label
                            ? `Added ${formatConnectionDate(connection.created_at)}`
                            : `Connection ${index + 1} · Added ${formatConnectionDate(connection.created_at)}`}
                        </p>
                        {(showReconnectBadge || showInferredIdentityBadge) && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {showReconnectBadge && (
                              <span
                                className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
                                style={{
                                  background: "rgba(96, 165, 250, 0.12)",
                                  color: "rgb(147 197 253)",
                                  border: "1px solid rgba(96, 165, 250, 0.2)",
                                }}
                              >
                                Same account reconnected
                              </span>
                            )}
                            {showInferredIdentityBadge && (
                              <span
                                className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
                                style={{
                                  background: "var(--color-background)",
                                  color: "var(--color-text-muted)",
                                  border: "1px solid var(--color-border)",
                                }}
                              >
                                Identity inferred
                              </span>
                            )}
                          </div>
                        )}
                      </div>

                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleDisconnect(connection.id)}
                        disabled={disconnectingId === connection.id}
                      >
                        {disconnectingId === connection.id ? `${buttonLabel}...` : buttonLabel}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div
              className="rounded-xl border border-dashed px-3 py-5 text-center text-sm text-muted-foreground"
              style={{
                borderColor: "var(--color-border)",
                background: "var(--color-surface-hover)",
              }}
            >
              No accounts connected yet. Connect your {toolkit.name} account to get started.
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-end gap-2 px-6 py-4"
          style={{ borderTop: "1px solid var(--color-border)" }}
        >
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            size="sm"
            onClick={() => void handleConnect()}
            disabled={connecting}
          >
            {connecting
              ? "Waiting for authorization..."
              : primaryAction === "reconnect"
                ? `Reconnect ${toolkit.name}`
                : connected
                ? "Connect another account"
                : `Connect ${toolkit.name}`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
