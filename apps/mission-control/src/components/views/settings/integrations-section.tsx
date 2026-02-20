"use client";

import { useState, useEffect, useCallback } from "react";
import {
    Link2, Plus, Eye, EyeOff, Trash2, Loader2,
    RefreshCw, CheckCircle2, Circle,
} from "lucide-react";
import { SettingsSection, SettingsSkeleton } from "./settings-shared";
import { useToast } from "@/components/ui/toast";

// ============================================================================
// Integrations Section — GitHub, Vercel, Neon, Render
// ============================================================================

const SERVICES = [
    { id: "github", name: "GitHub", icon: "🐙", description: "Repository access, PR management, and code deployments" },
    { id: "vercel", name: "Vercel", icon: "▲", description: "Deployment previews, domains, and serverless functions" },
    { id: "neon", name: "Neon", icon: "🐘", description: "Serverless Postgres database management" },
    { id: "render", name: "Render", icon: "🚀", description: "Cloud hosting, services, and infrastructure" },
] as const;

interface IntegrationSummary {
    configured: boolean;
    preview: string | null;
    username: string | null;
    teamId: string | null;
    updatedAt: string | null;
}

type IntegrationsData = Record<string, IntegrationSummary>;

export function IntegrationsSection() {
    const { addToast } = useToast();
    const [integrations, setIntegrations] = useState<IntegrationsData>({});
    const [loading, setLoading] = useState(true);
    const [editingService, setEditingService] = useState<string | null>(null);
    const [tokenInput, setTokenInput] = useState("");
    const [usernameInput, setUsernameInput] = useState("");
    const [showToken, setShowToken] = useState(false);
    const [saving, setSaving] = useState(false);
    const [removingService, setRemovingService] = useState<string | null>(null);

    const fetchIntegrations = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch("/api/integrations");
            if (res.ok) {
                const data = await res.json();
                setIntegrations(data.integrations ?? {});
            }
        } catch {
            // Integrations not available
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchIntegrations();
    }, [fetchIntegrations]);

    const handleSave = async (serviceId: string) => {
        if (!tokenInput.trim()) return;
        setSaving(true);
        try {
            const res = await fetch("/api/integrations", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    service: serviceId,
                    token: tokenInput,
                    username: usernameInput || undefined,
                }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            // Update local state with the returned integration
            if (data.integration) {
                setIntegrations((prev) => ({ ...prev, [serviceId]: data.integration }));
            } else {
                await fetchIntegrations();
            }
            setEditingService(null);
            setTokenInput("");
            setUsernameInput("");
            setShowToken(false);
            addToast("success", `${SERVICES.find((s) => s.id === serviceId)?.name} integration saved`);
        } catch (err) {
            addToast("error", `Failed to save integration: ${err}`);
        } finally {
            setSaving(false);
        }
    };

    const handleRemove = async (serviceId: string) => {
        setRemovingService(serviceId);
        try {
            const res = await fetch(`/api/integrations?service=${encodeURIComponent(serviceId)}`, { method: "DELETE" });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            setIntegrations((prev) => ({
                ...prev,
                [serviceId]: { configured: false, preview: null, username: null, teamId: null, updatedAt: null },
            }));
            addToast("success", `${SERVICES.find((s) => s.id === serviceId)?.name} integration removed`);
        } catch (err) {
            addToast("error", `Failed to remove integration: ${err}`);
        } finally {
            setRemovingService(null);
        }
    };

    const startEditing = (serviceId: string) => {
        setEditingService(serviceId);
        setTokenInput("");
        setUsernameInput(integrations[serviceId]?.username ?? "");
        setShowToken(false);
    };

    return (
        <SettingsSection
            id="integrations"
            icon={<Link2 className="w-5 h-5" />}
            title="Integrations"
            description="Connect external services for deployments and infrastructure"
            defaultOpen={false}
        >
            <div className="space-y-3">
                {loading && <SettingsSkeleton lines={4} />}

                {!loading && SERVICES.map((service) => {
                    const info = integrations[service.id];
                    const configured = info?.configured ?? false;
                    const isEditing = editingService === service.id;

                    return (
                        <div
                            key={service.id}
                            className="bg-card border border-border rounded-lg overflow-hidden hover:border-primary/20 transition-colors"
                        >
                            {/* Service Header */}
                            <div className="flex items-center justify-between p-4">
                                <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center text-lg">
                                        {service.icon}
                                    </div>
                                    <div>
                                        <div className="flex items-center gap-2">
                                            <span className="font-medium text-sm">{service.name}</span>
                                            {configured ? (
                                                <span className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                                                    <CheckCircle2 className="w-3 h-3" />
                                                    Connected
                                                </span>
                                            ) : (
                                                <span className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-gray-500/10 text-gray-400 border border-gray-500/30">
                                                    <Circle className="w-3 h-3" />
                                                    Not configured
                                                </span>
                                            )}
                                        </div>
                                        <p className="text-xs text-muted-foreground mt-0.5">{service.description}</p>
                                        {configured && info?.preview && (
                                            <p className="text-xs text-muted-foreground font-mono mt-1">Token: {info.preview}</p>
                                        )}
                                        {configured && info?.username && (
                                            <p className="text-xs text-muted-foreground mt-0.5">User: {info.username}</p>
                                        )}
                                    </div>
                                </div>

                                <div className="flex items-center gap-2 shrink-0">
                                    {configured && !isEditing && (
                                        <button
                                            onClick={() => handleRemove(service.id)}
                                            disabled={removingService === service.id}
                                            className="p-2 rounded-lg hover:bg-destructive/10 transition-colors text-muted-foreground hover:text-destructive disabled:opacity-50"
                                            title="Remove integration"
                                        >
                                            {removingService === service.id ? (
                                                <Loader2 className="w-4 h-4 animate-spin" />
                                            ) : (
                                                <Trash2 className="w-4 h-4" />
                                            )}
                                        </button>
                                    )}
                                    {!isEditing && (
                                        <button
                                            onClick={() => startEditing(service.id)}
                                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-muted hover:bg-muted/80 border border-border transition-all"
                                        >
                                            <Plus className="w-3.5 h-3.5" />
                                            {configured ? "Update" : "Configure"}
                                        </button>
                                    )}
                                </div>
                            </div>

                            {/* Inline Edit Form */}
                            {isEditing && (
                                <div className="px-4 pb-4 pt-0 border-t border-border/50 space-y-3 animate-in fade-in slide-in-from-top-1 duration-150">
                                    <div className="pt-3">
                                        <label className="block text-xs font-medium mb-1.5">API Token / Access Key</label>
                                        <div className="relative">
                                            <input
                                                type={showToken ? "text" : "password"}
                                                value={tokenInput}
                                                onChange={(e) => setTokenInput(e.target.value)}
                                                placeholder={`Enter ${service.name} token...`}
                                                className="w-full px-3 py-2 pr-10 rounded-lg border border-border bg-background focus:border-primary focus:ring-1 focus:ring-primary/50 outline-none transition-all text-sm font-mono"
                                            />
                                            <button
                                                onClick={() => setShowToken(!showToken)}
                                                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-muted/50 text-muted-foreground"
                                            >
                                                {showToken ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                                            </button>
                                        </div>
                                    </div>

                                    {(service.id === "github" || service.id === "vercel") && (
                                        <div>
                                            <label className="block text-xs font-medium mb-1.5">
                                                Username / Org <span className="text-muted-foreground font-normal">(optional)</span>
                                            </label>
                                            <input
                                                type="text"
                                                value={usernameInput}
                                                onChange={(e) => setUsernameInput(e.target.value)}
                                                placeholder={service.id === "github" ? "github-username" : "vercel-team"}
                                                className="w-full px-3 py-2 rounded-lg border border-border bg-background focus:border-primary focus:ring-1 focus:ring-primary/50 outline-none transition-all text-sm"
                                            />
                                        </div>
                                    )}

                                    <div className="flex items-center gap-2 pt-1">
                                        <button
                                            onClick={() => handleSave(service.id)}
                                            disabled={!tokenInput.trim() || saving}
                                            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all ${!tokenInput.trim() || saving
                                                ? "bg-muted text-muted-foreground cursor-not-allowed"
                                                : "bg-primary text-primary-foreground hover:opacity-90 shadow-[0_0_15px_oklch(0.58_0.2_260/0.2)]"
                                                }`}
                                        >
                                            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                                            Save
                                        </button>
                                        <button
                                            onClick={() => { setEditingService(null); setTokenInput(""); setShowToken(false); }}
                                            className="px-3 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:bg-muted/50 transition-colors"
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    );
                })}

                {/* Refresh */}
                {!loading && (
                    <div className="flex justify-end pt-1">
                        <button
                            onClick={fetchIntegrations}
                            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:bg-muted/50 transition-colors"
                        >
                            <RefreshCw className="w-3.5 h-3.5" />
                            Refresh
                        </button>
                    </div>
                )}
            </div>
        </SettingsSection>
    );
}
