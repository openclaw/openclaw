"use client";

import { useState, useEffect, useCallback } from "react";
import {
    Activity,
    AlertCircle,
    CheckCircle2,
    CreditCard,
    ExternalLink,
    HelpCircle,
    Info,
    Key,
    Loader2,
    Plus,
    RefreshCw,
    ShieldAlert,
    Sparkles,
    Zap
} from "lucide-react";
import { SettingsSection, SettingsSkeleton } from "./settings-shared";
import { useToast } from "@/components/ui/toast";
import {
    API_KEY_PROVIDERS,
    PROVIDER_ICONS,
    PROVIDER_LABELS,
    PROVIDER_CREDIT_URLS,
    PROVIDER_KEY_URLS,
} from "./settings-types";
import { ApiKeysSection } from "./api-keys-section";
import type { ApiKeyResponse, ProviderCreditInfo } from "./settings-types";

// ============================================================================
// AI API Command Center
// ============================================================================

interface BatchStatusResponse {
    byProvider: Record<string, ApiKeyResponse[]>;
    configuredProviders: string[];
    unconfiguredProviders: string[];
    allProviders: string[];
    stats: {
        totalKeys: number;
        activeKeys: number;
        testedKeys: number;
        failedKeys: number;
        untestedKeys: number;
        totalProviders: number;
        configuredCount: number;
    };
}

export function AiApiCommandCenter() {
    const { addToast } = useToast();
    const [loading, setLoading] = useState(true);
    const [data, setData] = useState<BatchStatusResponse | null>(null);
    const [credits, setCredits] = useState<Record<string, ProviderCreditInfo>>({});
    const [testingAll, setTestingAll] = useState(false);
    const [showDetails, setShowDetails] = useState(false);
    const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
    const [connectProvider, setConnectProvider] = useState<string | null>(null);

    const fetchData = useCallback(async () => {
        setLoading(true);
        try {
            const [statusRes, creditsRes] = await Promise.all([
                fetch("/api/settings/api-keys/batch-status"),
                fetch("/api/settings/credits")
            ]);

            if (statusRes.ok) {
                setData(await statusRes.json());
            }

            if (creditsRes.ok) {
                const creditsData = await creditsRes.json();
                const creditsMap: Record<string, ProviderCreditInfo> = {};
                if (Array.isArray(creditsData.credits)) {
                    creditsData.credits.forEach((c: { provider: string; balance?: number; currency?: string; limit_total?: number; usage_total?: number }) => {
                        creditsMap[c.provider] = c as ProviderCreditInfo;
                    });
                }
                setCredits(creditsMap);
            }
        } catch (err) {
            console.error("Failed to load command center data", err);
            addToast("error", "Failed to load API status");
        } finally {
            setLoading(false);
        }
    }, [addToast]);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    const handleTestAll = async () => {
        if (!data?.stats.totalKeys) {return;}
        setTestingAll(true);
        addToast("info", "Starting connectivity test for all providers...");

        try {
            // Get all configured keys
            const allKeys = Object.values(data.byProvider).flat();

            // Run tests in parallel batches of 5
            const batchSize = 5;
            let successCount = 0;
            let failCount = 0;

            for (let i = 0; i < allKeys.length; i += batchSize) {
                const batch = allKeys.slice(i, i + batchSize);
                const results = await Promise.all(
                    batch.map(key =>
                        fetch("/api/settings/api-keys", {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ id: key.id, test: true }),
                        }).then(r => r.json())
                    )
                );

                results.forEach(res => {
                    if (res.ok && res.testResult?.ok) {successCount++;}
                    else {failCount++;}
                });
            }

            addToast(
                failCount === 0 ? "success" : "warning",
                `Test complete: ${successCount} successful, ${failCount} failed`
            );

            // Refresh data to show new statuses
            await fetchData();

        } catch (err) {
            console.error(err);
            addToast("error", "Batch test failed unexpectedly");
        } finally {
            setTestingAll(false);
        }
    };

    const ProviderCard = ({ providerId, isConfigured }: { providerId: string, isConfigured: boolean }) => {
        const providerDef = API_KEY_PROVIDERS.find(p => p.id === providerId);
        const label = providerDef?.name || PROVIDER_LABELS[providerId] || providerId;
        const icon = providerDef?.icon || PROVIDER_ICONS[providerId] || "🤖";

        // Status logic
        const keys = data?.byProvider[providerId] || [];
        const isActive = keys.some(k => k.is_active && k.last_test_status === "active");
        const hasError = keys.some(k => k.last_test_status === "error" || k.last_test_status === "failed");
        const isUntested = keys.some(k => k.is_active && !k.last_test_status);

        const creditInfo = credits[providerId];

        let statusColor = "bg-muted text-muted-foreground border-border";
        let statusIcon = <Info className="w-3 h-3" />;
        let statusText = "Not configured";

        if (isConfigured) {
            if (isActive) {
                statusColor = "bg-emerald-500/10 text-emerald-500 border-emerald-500/20";
                statusIcon = <CheckCircle2 className="w-3 h-3" />;
                statusText = "Active";
            } else if (hasError) {
                statusColor = "bg-destructive/10 text-destructive border-destructive/20";
                statusIcon = <AlertCircle className="w-3 h-3" />;
                statusText = "Error";
            } else if (isUntested) {
                statusColor = "bg-amber-500/10 text-amber-500 border-amber-500/20";
                statusIcon = <HelpCircle className="w-3 h-3" />;
                statusText = "Untested";
            } else {
                statusColor = "bg-muted text-muted-foreground border-border";
                statusIcon = <Info className="w-3 h-3" />;
                statusText = "Inactive";
            }
        }

        // Credit bar calc
        const showCredit = isActive && creditInfo && creditInfo.limit_total;
        const creditPercent = showCredit ? ((creditInfo.usage_total || 0) / (creditInfo.limit_total || 1)) * 100 : 0;
        const isLowBalance = showCredit && creditPercent > 80;

        return (
            <div className={`
        relative group flex flex-col justify-between p-4 rounded-xl border transition-all duration-200
        ${isConfigured ? "bg-card border-border hover:border-primary/50 hover:shadow-[0_0_15px_oklch(0.58_0.2_260/0.1)]" : "bg-muted/10 border-border/40 hover:bg-muted/30"}
      `}>
                <div>
                    <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center gap-3">
                            <div className={`w-10 h-10 rounded-lg flex items-center justify-center text-xl shrink-0 ${isConfigured ? "bg-primary/10" : "bg-muted"}`}>
                                {icon}
                            </div>
                            <div>
                                <h4 className={`font-semibold text-sm ${!isConfigured && "text-muted-foreground"}`}>{label}</h4>
                                <div className={`flex items-center gap-1.5 mt-1 px-2 py-0.5 rounded-full border text-[10px] font-medium w-fit ${statusColor}`}>
                                    {statusIcon}
                                    {statusText}
                                </div>
                            </div>
                        </div>

                        {isConfigured && (
                            <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                                <button
                                    onClick={() => setExpandedProvider(expandedProvider === providerId ? null : providerId)}
                                    className="p-1.5 rounded-md hover:bg-muted text-muted-foreground"
                                    title="Manage keys"
                                >
                                    <Key className="w-4 h-4" />
                                </button>
                            </div>
                        )}
                    </div>

                    {/* Credit Bar */}
                    {showCredit && (
                        <div className="mt-2 space-y-1">
                            <div className="flex justify-between text-[10px] text-muted-foreground">
                                <span>Usage</span>
                                <span>{creditPercent.toFixed(1)}%</span>
                            </div>
                            <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                                <div
                                    className={`h-full rounded-full ${isLowBalance ? "bg-red-500" : "bg-primary"}`}
                                    style={{ width: `${Math.min(creditPercent, 100)}%` }}
                                />
                            </div>
                            <div className="flex justify-between text-[10px] text-muted-foreground">
                                <span>{creditInfo.currency} {creditInfo.usage_total?.toFixed(2)}</span>
                                <span>Limit: {creditInfo.currency} {creditInfo.limit_total?.toFixed(2)}</span>
                            </div>
                        </div>
                    )}

                    {/* Manual connect button for unconfigured */}
                    {!isConfigured && (
                        <>
                            <button
                                onClick={() => {
                                    setConnectProvider(providerId);
                                    setShowDetails(true);
                                }}
                                className="mt-3 w-full py-1.5 rounded-lg border border-dashed border-border text-xs text-muted-foreground hover:text-primary hover:border-primary/50 transition-colors flex items-center justify-center gap-1.5"
                            >
                                <Plus className="w-3 h-3" /> Connect
                            </button>
                            {PROVIDER_KEY_URLS[providerId] && (
                                <a
                                    href={PROVIDER_KEY_URLS[providerId]}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="mt-2 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground hover:text-primary transition-colors"
                                >
                                    <ExternalLink className="w-3 h-3" /> Get API Key
                                </a>
                            )}
                        </>
                    )}
                </div>

                {/* Billing Link */}
                {isActive && PROVIDER_CREDIT_URLS[providerId] && (
                    <a
                        href={PROVIDER_CREDIT_URLS[providerId]}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-3 flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-primary transition-colors w-fit"
                    >
                        <ExternalLink className="w-3 h-3" /> Manage Billing
                    </a>
                )}
            </div>
        );
    };

    if (loading) {return <SettingsSkeleton lines={5} />;}

    return (
        <div className="space-y-6">
            <SettingsSection
                id="ai-command-center"
                icon={<Activity className="w-5 h-5" />}
                title="AI API Command Center"
                description="Monitor status, health, and credits for all AI providers"
                defaultOpen={true}
            >
                <div className="space-y-6">

                    {/* 1. Stats Bar */}
                    {data && (
                        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                            <div className="bg-card border border-border rounded-xl p-4 flex items-center gap-4">
                                <div className="w-10 h-10 rounded-full bg-emerald-500/10 flex items-center justify-center text-emerald-500">
                                    <CheckCircle2 className="w-5 h-5" />
                                </div>
                                <div>
                                    <p className="text-2xl font-bold">{data.stats.activeKeys}</p>
                                    <p className="text-xs text-muted-foreground">Active Keys</p>
                                </div>
                            </div>

                            <div className="bg-card border border-border rounded-xl p-4 flex items-center gap-4">
                                <div className="w-10 h-10 rounded-full bg-purple-500/10 flex items-center justify-center text-purple-500">
                                    <Zap className="w-5 h-5" />
                                </div>
                                <div>
                                    <p className="text-2xl font-bold">{data.stats.configuredCount}</p>
                                    <p className="text-xs text-muted-foreground">Providers Connected</p>
                                </div>
                            </div>

                            <div className="bg-card border border-border rounded-xl p-4 flex items-center gap-4">
                                <div className="w-10 h-10 rounded-full bg-amber-500/10 flex items-center justify-center text-amber-500">
                                    <ShieldAlert className="w-5 h-5" />
                                </div>
                                <div>
                                    <p className="text-2xl font-bold">{data.stats.failedKeys + data.stats.untestedKeys}</p>
                                    <p className="text-xs text-muted-foreground">Issues / Untested</p>
                                </div>
                            </div>

                            <div className="flex flex-col justify-center gap-2">
                                <button
                                    onClick={handleTestAll}
                                    disabled={testingAll || !data.stats.totalKeys}
                                    className="w-full h-full max-h-[42px] flex items-center justify-center gap-2 bg-primary text-primary-foreground text-sm font-medium rounded-lg hover:opacity-90 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_0_15px_oklch(0.58_0.2_260/0.3)]"
                                >
                                    {testingAll ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                                    Test All Connections
                                </button>
                                <div className="flex justify-end">
                                    <button
                                        onClick={fetchData}
                                        className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1"
                                    >
                                        <RefreshCw className="w-3 h-3" /> Refresh Status
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* 2. Provider Grid */}
                    <div>
                        <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
                            <CreditCard className="w-4 h-4 text-muted-foreground" />
                            Connected Providers
                        </h3>
                        {data && (
                            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                                {/* Configured providers first */}
                                {data.configuredProviders.map(p => (
                                    <ProviderCard key={p} providerId={p} isConfigured={true} />
                                ))}

                                {/* Then the rest */}
                                {data.unconfiguredProviders.map(p => (
                                    <ProviderCard key={p} providerId={p} isConfigured={false} />
                                ))}
                            </div>
                        )}
                    </div>

                    {/* 3. Detailed Management Toggle */}
                    <div className="pt-2 border-t border-border/50">
                        <button
                            onClick={() => setShowDetails(!showDetails)}
                            className="w-full py-2 text-sm text-muted-foreground hover:text-foreground flex items-center justify-center gap-2 transition-colors"
                        >
                            {showDetails ? "Hide Key Management" : "Show Key Management & Details"}
                        </button>
                    </div>

                    {/* 4. Embedded ApiKeysSection */}
                    {showDetails && (
                        <div className="animate-in fade-in slide-in-from-top-4 duration-300">
                            <ApiKeysSection defaultProvider={connectProvider} onProviderHandled={() => setConnectProvider(null)} />
                        </div>
                    )}

                </div>
            </SettingsSection>
        </div>
    );
}
