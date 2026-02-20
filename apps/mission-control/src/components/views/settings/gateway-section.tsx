"use client";

import { useState, useEffect, useCallback } from "react";
import {
    Wifi, WifiOff, RefreshCw, Network, CheckCircle2,
    Activity, Clock, Zap, BarChart3, Eye, EyeOff,
} from "lucide-react";
import { SettingsSection, Toggle } from "./settings-shared";
import type { AppSettings, GatewayNode } from "./settings-types";

// ============================================================================
// Gateway Connection Section (includes Cluster Nodes + Connection Metrics)
// ============================================================================

interface ConnectionMetrics {
    connected: boolean;
    uptimeMs: number;
    totalReconnects: number;
    totalConnections: number;
    eventsReceived: number;
    eventsPerSecond: number;
    pendingRequests: number;
    circuitBreakerTrips: number;
}

interface GatewaySectionProps {
    settings: AppSettings;
    onSettingsChange: (settings: AppSettings) => void;
}

function formatUptime(ms: number): string {
    if (ms <= 0) return "—";
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
}

export function GatewaySection({ settings, onSettingsChange }: GatewaySectionProps) {
    const [gatewayStatus, setGatewayStatus] = useState<"connected" | "disconnected" | "checking">("disconnected");
    const [metrics, setMetrics] = useState<ConnectionMetrics | null>(null);
    const [agentCount, setAgentCount] = useState(0);
    const [cronJobCount, setCronJobCount] = useState(0);
    const [clusterNodes, setClusterNodes] = useState<GatewayNode[]>([]);
    const [loadingNodes, setLoadingNodes] = useState(false);
    const [localUrl, setLocalUrl] = useState(settings.gatewayUrl);
    const [localToken, setLocalToken] = useState(settings.gatewayToken);
    const [showToken, setShowToken] = useState(false);

    // Sync local state when external settings change
    useEffect(() => {
        setLocalUrl(settings.gatewayUrl);
    }, [settings.gatewayUrl]);

    useEffect(() => {
        setLocalToken(settings.gatewayToken);
    }, [settings.gatewayToken]);

    const checkGateway = useCallback(async () => {
        setGatewayStatus("checking");
        try {
            const res = await fetch("/api/openclaw/status");
            if (res.ok) {
                const data = await res.json();
                if (data.connected) {
                    setGatewayStatus("connected");
                    setAgentCount(data.agentCount ?? 0);
                    setCronJobCount(data.cronJobCount ?? 0);
                    if (data.connectionMetrics) {
                        setMetrics(data.connectionMetrics);
                    }
                } else {
                    setGatewayStatus("disconnected");
                    setMetrics(null);
                }
            } else {
                setGatewayStatus("disconnected");
                setMetrics(null);
            }
        } catch {
            setGatewayStatus("disconnected");
            setMetrics(null);
        }
    }, []);

    const fetchNodes = useCallback(async () => {
        setLoadingNodes(true);
        try {
            const res = await fetch("/api/openclaw/nodes");
            if (res.ok) {
                const data = await res.json();
                setClusterNodes(Array.isArray(data.nodes) ? data.nodes : []);
            }
        } catch {
            // Nodes not available
        } finally {
            setLoadingNodes(false);
        }
    }, []);

    useEffect(() => {
        checkGateway();
        fetchNodes();
    }, [checkGateway, fetchNodes]);

    const updateField = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
        onSettingsChange({ ...settings, [key]: value });
    };

    return (
        <SettingsSection
            id="gateway"
            icon={<Wifi className="w-5 h-5" />}
            title="Gateway Connection"
            description="Configure the connection to the OpenClaw gateway"
        >
            <div className="space-y-5">
                {/* Status */}
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm ${gatewayStatus === "connected"
                            ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                            : gatewayStatus === "checking"
                                ? "bg-blue-500/10 text-blue-400 border border-blue-500/30"
                                : "bg-destructive/10 text-destructive border border-destructive/30"
                            }`}>
                            {gatewayStatus === "checking" ? (
                                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                            ) : gatewayStatus === "connected" ? (
                                <CheckCircle2 className="w-3.5 h-3.5" />
                            ) : (
                                <WifiOff className="w-3.5 h-3.5" />
                            )}
                            {gatewayStatus === "checking" ? "Checking..." : gatewayStatus === "connected" ? "Connected" : "Disconnected"}
                        </div>
                        {gatewayStatus === "connected" && (
                            <div className="flex items-center gap-3 text-xs text-muted-foreground">
                                <span>{agentCount} agent{agentCount !== 1 ? "s" : ""}</span>
                                <span>·</span>
                                <span>{cronJobCount} cron job{cronJobCount !== 1 ? "s" : ""}</span>
                            </div>
                        )}
                    </div>
                    <button
                        onClick={checkGateway}
                        disabled={gatewayStatus === "checking"}
                        className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-muted-foreground hover:bg-muted/50 transition-colors disabled:opacity-50"
                    >
                        <RefreshCw className={`w-4 h-4 ${gatewayStatus === "checking" ? "animate-spin" : ""}`} />
                        Retry
                    </button>
                </div>

                {/* Connection Metrics */}
                {metrics && gatewayStatus === "connected" && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        <div className="bg-muted/30 border border-border/50 rounded-lg p-3 text-center">
                            <Clock className="w-4 h-4 mx-auto mb-1 text-muted-foreground" />
                            <p className="text-sm font-semibold">{formatUptime(metrics.uptimeMs)}</p>
                            <p className="text-xs text-muted-foreground">Uptime</p>
                        </div>
                        <div className="bg-muted/30 border border-border/50 rounded-lg p-3 text-center">
                            <Activity className="w-4 h-4 mx-auto mb-1 text-muted-foreground" />
                            <p className="text-sm font-semibold">{metrics.eventsReceived.toLocaleString()}</p>
                            <p className="text-xs text-muted-foreground">Events</p>
                        </div>
                        <div className="bg-muted/30 border border-border/50 rounded-lg p-3 text-center">
                            <Zap className="w-4 h-4 mx-auto mb-1 text-muted-foreground" />
                            <p className="text-sm font-semibold">{metrics.eventsPerSecond.toFixed(1)}/s</p>
                            <p className="text-xs text-muted-foreground">Throughput</p>
                        </div>
                        <div className="bg-muted/30 border border-border/50 rounded-lg p-3 text-center">
                            <BarChart3 className="w-4 h-4 mx-auto mb-1 text-muted-foreground" />
                            <p className="text-sm font-semibold">{metrics.totalReconnects}</p>
                            <p className="text-xs text-muted-foreground">Reconnects</p>
                        </div>
                    </div>
                )}

                {/* Gateway URL */}
                <div>
                    <label className="block text-sm font-medium mb-2">Gateway URL</label>
                    <input
                        type="text"
                        value={localUrl}
                        onChange={(e) => setLocalUrl(e.target.value)}
                        onBlur={() => updateField("gatewayUrl", localUrl)}
                        onKeyDown={(e) => { if (e.key === "Enter") updateField("gatewayUrl", localUrl); }}
                        placeholder="ws://127.0.0.1:18789"
                        className="w-full px-4 py-2.5 rounded-lg border border-border bg-background focus:border-primary focus:ring-1 focus:ring-primary/50 outline-none transition-all text-sm font-mono"
                    />
                </div>

                {/* Gateway Token */}
                <div>
                    <label className="block text-sm font-medium mb-2">Auth Token</label>
                    <div className="relative">
                        <input
                            type={showToken ? "text" : "password"}
                            value={localToken}
                            onChange={(e) => setLocalToken(e.target.value)}
                            onBlur={() => updateField("gatewayToken", localToken)}
                            onKeyDown={(e) => { if (e.key === "Enter") updateField("gatewayToken", localToken); }}
                            placeholder="Enter auth token..."
                            className="w-full px-4 py-2.5 pr-12 rounded-lg border border-border bg-background focus:border-primary focus:ring-1 focus:ring-primary/50 outline-none transition-all text-sm font-mono"
                        />
                        <button
                            onClick={() => setShowToken(!showToken)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-muted/50 text-muted-foreground"
                        >
                            {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                    </div>
                </div>

                {/* Auto-connect */}
                <Toggle
                    enabled={settings.autoConnect}
                    onChange={(v) => updateField("autoConnect", v)}
                    label="Auto-Connect"
                    description="Automatically connect to the gateway on startup"
                />

                {/* Cluster Nodes */}
                <div className="pt-2 border-t border-border/50">
                    <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                            <Network className="w-4 h-4 text-muted-foreground" />
                            <h4 className="text-sm font-medium">Cluster Nodes</h4>
                        </div>
                        <button
                            onClick={fetchNodes}
                            disabled={loadingNodes}
                            className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium text-muted-foreground hover:bg-muted/50 transition-colors disabled:opacity-50"
                        >
                            <RefreshCw className={`w-3 h-3 ${loadingNodes ? "animate-spin" : ""}`} />
                            Refresh
                        </button>
                    </div>

                    {clusterNodes.length > 0 ? (
                        <div className="space-y-2">
                            {clusterNodes.map((node, i) => (
                                <div key={node.id || node.nodeId || i} className="flex items-center justify-between px-4 py-3 rounded-lg bg-muted/30 border border-border/50">
                                    <div className="flex items-center gap-3">
                                        <span className={`w-2 h-2 rounded-full ${(node.status || node.health) === "healthy" ? "bg-emerald-400" :
                                            (node.status || node.health) === "warning" ? "bg-amber-400" :
                                                "bg-destructive"
                                            }`} />
                                        <div>
                                            <p className="text-sm font-medium">{node.id || node.nodeId || `Node ${i + 1}`}</p>
                                            {node.description && <p className="text-xs text-muted-foreground">{node.description}</p>}
                                        </div>
                                    </div>
                                    <span className={`text-xs font-medium px-2 py-0.5 rounded ${(node.status || node.health) === "healthy"
                                        ? "bg-emerald-500/10 text-emerald-400"
                                        : "bg-amber-500/10 text-amber-400"
                                        }`}>
                                        {node.status || node.health || "Unknown"}
                                    </span>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="bg-muted/30 border border-border/50 rounded-lg p-4 text-center">
                            <p className="text-sm text-muted-foreground">
                                {loadingNodes ? "Loading nodes..." : gatewayStatus !== "connected" ? "Connect to gateway to view cluster nodes" : "No cluster nodes found"}
                            </p>
                        </div>
                    )}
                </div>
            </div>
        </SettingsSection>
    );
}
