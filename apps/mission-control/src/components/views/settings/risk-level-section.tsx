"use client";

import { useState, useCallback, useEffect } from "react";
import { Shield, RefreshCw, Check, Info, Clock, Zap, Lock, Eye, FileText } from "lucide-react";
import { SettingsSection } from "./settings-shared";
import { useToast } from "@/components/ui/toast";
import type { RiskLevel, RiskLevelConfig, RiskLevelResponse } from "./settings-types";
import { RISK_LEVEL_META } from "./settings-types";

// ============================================================================
// Risk Level Section — new component
// ============================================================================

export function RiskLevelSection() {
    const { addToast } = useToast();
    const [currentLevel, setCurrentLevel] = useState<RiskLevel>("medium");
    const [config, setConfig] = useState<RiskLevelConfig | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const fetchRiskLevel = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch("/api/settings/risk-level");
            if (!res.ok) {throw new Error(`HTTP ${res.status}`);}
            const data: RiskLevelResponse = await res.json();
            setCurrentLevel(data.level);
            setConfig(data.config);
        } catch {
            addToast("error", "Failed to load risk level");
        } finally {
            setLoading(false);
        }
    }, [addToast]);

    useEffect(() => {
        fetchRiskLevel();
    }, [fetchRiskLevel]);

    const handleChange = async (level: RiskLevel) => {
        if (level === currentLevel || saving) {return;}

        // Confirm dangerous levels
        if (level === "insane" || level === "freedom") {
            const confirmed = window.confirm(
                `Are you sure you want to set risk level to "${RISK_LEVEL_META[level].label}"? ${RISK_LEVEL_META[level].description}`
            );
            if (!confirmed) {return;}
        }

        setSaving(true);
        const previousLevel = currentLevel;
        setCurrentLevel(level);

        try {
            const res = await fetch("/api/settings/risk-level", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ level }),
            });
            if (!res.ok) {throw new Error(`HTTP ${res.status}`);}
            const data = await res.json();
            setConfig(data.config);
            addToast("success", `Risk level set to ${RISK_LEVEL_META[level].label}`);
        } catch {
            setCurrentLevel(previousLevel);
            addToast("error", "Failed to update risk level");
        } finally {
            setSaving(false);
        }
    };

    const meta = RISK_LEVEL_META[currentLevel];

    return (
        <SettingsSection
            id="risk-level"
            icon={<Shield className="w-5 h-5" />}
            title="Risk Level"
            description="Control the security posture of your entire stack"
        >
            <div className="space-y-5">
                {loading ? (
                    <div className="flex items-center justify-center py-8 text-muted-foreground">
                        <RefreshCw className="w-5 h-5 animate-spin mr-3" />
                        Loading risk configuration...
                    </div>
                ) : (
                    <>
                        {/* Level Selector */}
                        <div className="grid grid-cols-5 gap-2">
                            {(Object.keys(RISK_LEVEL_META) as RiskLevel[]).map((level) => {
                                const levelMeta = RISK_LEVEL_META[level];
                                const isActive = level === currentLevel;
                                return (
                                    <button
                                        key={level}
                                        onClick={() => handleChange(level)}
                                        disabled={saving}
                                        className={`relative flex flex-col items-center gap-1.5 p-3 rounded-xl border transition-all duration-200 disabled:opacity-50 ${isActive
                                                ? `${levelMeta.bgColor} ${levelMeta.borderColor} shadow-lg`
                                                : "border-border hover:border-primary/30 hover:bg-muted/30"
                                            }`}
                                    >
                                        <span className="text-xl">{levelMeta.icon}</span>
                                        <span className={`text-xs font-semibold ${isActive ? levelMeta.color : ""}`}>
                                            {levelMeta.label}
                                        </span>
                                        {isActive && <Check className={`w-3.5 h-3.5 absolute top-1.5 right-1.5 ${levelMeta.color}`} />}
                                    </button>
                                );
                            })}
                        </div>

                        {/* Active Level Description */}
                        <div className={`rounded-lg border p-4 ${meta.bgColor} ${meta.borderColor}`}>
                            <div className="flex items-start gap-3">
                                <span className="text-2xl">{meta.icon}</span>
                                <div className="flex-1">
                                    <h4 className={`font-semibold text-sm ${meta.color}`}>{meta.label}</h4>
                                    <p className="text-xs text-muted-foreground mt-1">{meta.description}</p>
                                </div>
                            </div>
                        </div>

                        {/* Config Summary */}
                        {config && (
                            <div className="grid grid-cols-2 gap-3">
                                <ConfigItem
                                    icon={<Lock className="w-3.5 h-3.5" />}
                                    label="Authentication"
                                    value={config.authRequired ? "Required" : "Disabled"}
                                    positive={config.authRequired}
                                />
                                <ConfigItem
                                    icon={<Shield className="w-3.5 h-3.5" />}
                                    label="CSRF Protection"
                                    value={config.csrfEnabled ? "Enabled" : "Disabled"}
                                    positive={config.csrfEnabled}
                                />
                                <ConfigItem
                                    icon={<Zap className="w-3.5 h-3.5" />}
                                    label="Rate Limit"
                                    value={
                                        !isFinite(config.rateLimitMultiplier)
                                            ? "No limit"
                                            : `${Math.round(60 * config.rateLimitMultiplier)} req/min`
                                    }
                                    positive={isFinite(config.rateLimitMultiplier)}
                                />
                                <ConfigItem
                                    icon={<Eye className="w-3.5 h-3.5" />}
                                    label="Approval Mode"
                                    value={config.approvalMode === "all" ? "All actions" : config.approvalMode === "dangerous" ? "Dangerous only" : "None"}
                                    positive={config.approvalMode !== "none"}
                                />
                                <ConfigItem
                                    icon={<FileText className="w-3.5 h-3.5" />}
                                    label="Activity Log"
                                    value={config.activityLogging ? "Enabled" : "Disabled"}
                                    positive={config.activityLogging}
                                />
                                <ConfigItem
                                    icon={<Clock className="w-3.5 h-3.5" />}
                                    label="Agent Timeout"
                                    value={
                                        !isFinite(config.agentTimeoutMs)
                                            ? "No timeout"
                                            : `${Math.round(config.agentTimeoutMs / 60_000)} min`
                                    }
                                    positive={isFinite(config.agentTimeoutMs)}
                                />
                            </div>
                        )}

                        {/* Info note */}
                        <p className="text-xs text-muted-foreground flex items-center gap-2">
                            <Info className="w-3.5 h-3.5 shrink-0" />
                            Changes apply immediately to all API routes and agent operations.
                        </p>
                    </>
                )}
            </div>
        </SettingsSection>
    );
}

function ConfigItem({ icon, label, value, positive }: { icon: React.ReactNode; label: string; value: string; positive: boolean }) {
    return (
        <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-muted/30 border border-border/50">
            <span className="text-muted-foreground shrink-0">{icon}</span>
            <div className="flex-1 min-w-0">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className={`text-sm font-medium ${positive ? "text-emerald-400" : "text-amber-400"}`}>
                    {value}
                </p>
            </div>
        </div>
    );
}
