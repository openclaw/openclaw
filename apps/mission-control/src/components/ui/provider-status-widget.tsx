"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Activity, CheckCircle2, AlertCircle, HelpCircle, Settings, Wifi, WifiOff } from "lucide-react";
import { PROVIDER_ICONS, PROVIDER_LABELS } from "@/components/views/settings/settings-types";

interface WidgetData {
    stats: {
        totalKeys: number;
        activeKeys: number;
        configuredCount: number;
        failedKeys: number;
        untestedKeys: number;
    };
    configuredProviders: string[];
    byProvider: Record<string, Array<{ is_active: boolean; last_test_status: string | null }>>;
}

export function ProviderStatusWidget() {
    const [data, setData] = useState<WidgetData | null>(null);
    const [gatewayUp, setGatewayUp] = useState(false);
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    const fetchStatus = useCallback(async () => {
        try {
            const [statusRes, gwRes] = await Promise.all([
                fetch("/api/settings/api-keys/batch-status"),
                fetch("/api/openclaw/status"),
            ]);
            if (statusRes.ok) {setData(await statusRes.json());}
            if (gwRes.ok) {
                const gwData = await gwRes.json();
                setGatewayUp(gwData.connected === true);
            }
        } catch {
            // Non-fatal
        }
    }, []);
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        fetchStatus();
        const interval = setInterval(fetchStatus, 60_000);
        return () => clearInterval(interval);
    }, [fetchStatus]);

    // Close on outside click
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, []);

    // Determine dot color
    const stats = data?.stats;
    let dotColor = "bg-zinc-400"; // gray - no data
    let statusText = "Loading...";

    if (stats) {
        if (stats.configuredCount === 0) {
            dotColor = "bg-zinc-400";
            statusText = "No providers";
        } else if (stats.failedKeys > 0) {
            dotColor = "bg-red-500";
            statusText = `${stats.activeKeys}/${stats.configuredCount} active`;
        } else if (stats.untestedKeys > 0) {
            dotColor = "bg-amber-500";
            statusText = `${stats.configuredCount} providers`;
        } else if (stats.activeKeys > 0) {
            dotColor = "bg-emerald-500";
            statusText = `${stats.activeKeys} active`;
        }
    }

    return (
        <div ref={ref} className="relative">
            {/* Compact button */}
            <button
                onClick={() => setOpen(!open)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                title="AI Provider Status"
            >
                <span className={`w-2 h-2 rounded-full ${dotColor} ${dotColor !== "bg-zinc-400" ? "animate-pulse" : ""}`} />
                <span className="hidden sm:inline">{statusText}</span>
                <Activity className="w-3.5 h-3.5" />
            </button>

            {/* Expanded dropdown */}
            {open && (
                <div className="absolute right-0 top-full mt-2 w-80 bg-card border border-border rounded-xl shadow-xl z-50 p-4 space-y-4 animate-in fade-in slide-in-from-top-2 duration-200">
                    {/* Gateway status */}
                    <div className="flex items-center justify-between text-sm">
                        <span className="font-medium">Gateway</span>
                        <span className={`flex items-center gap-1.5 text-xs ${gatewayUp ? "text-emerald-500" : "text-red-500"}`}>
                            {gatewayUp ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
                            {gatewayUp ? "Connected" : "Disconnected"}
                        </span>
                    </div>

                    {/* Provider list */}
                    {data?.configuredProviders && data.configuredProviders.length > 0 ? (
                        <div className="space-y-2">
                            <p className="text-xs text-muted-foreground font-medium">Providers</p>
                            {data.configuredProviders.map((p) => {
                                const keys = data.byProvider[p] || [];
                                const isActive = keys.some(k => k.is_active && k.last_test_status === "active");
                                const hasError = keys.some(k => k.last_test_status === "error" || k.last_test_status === "failed");
                                const isUntested = keys.some(k => k.is_active && !k.last_test_status);

                                let statusIcon = <HelpCircle className="w-3 h-3 text-zinc-400" />;
                                let statusLabel = "Unknown";
                                if (isActive) {
                                    statusIcon = <CheckCircle2 className="w-3 h-3 text-emerald-500" />;
                                    statusLabel = "Active";
                                } else if (hasError) {
                                    statusIcon = <AlertCircle className="w-3 h-3 text-red-500" />;
                                    statusLabel = "Error";
                                } else if (isUntested) {
                                    statusIcon = <HelpCircle className="w-3 h-3 text-amber-500" />;
                                    statusLabel = "Untested";
                                }

                                return (
                                    <div key={p} className="flex items-center justify-between text-xs">
                                        <span className="flex items-center gap-2">
                                            <span>{PROVIDER_ICONS[p] || "🔧"}</span>
                                            <span>{PROVIDER_LABELS[p] || p}</span>
                                        </span>
                                        <span className="flex items-center gap-1">
                                            {statusIcon}
                                            <span className="text-muted-foreground">{statusLabel}</span>
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                    ) : (
                        <p className="text-xs text-muted-foreground text-center py-2">No providers configured</p>
                    )}

                    {/* Settings link */}
                    <a
                        href="/settings#ai-command-center"
                        className="flex items-center justify-center gap-2 w-full py-2 rounded-lg border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                    >
                        <Settings className="w-3.5 h-3.5" /> Manage Providers
                    </a>
                </div>
            )}
        </div>
    );
}
