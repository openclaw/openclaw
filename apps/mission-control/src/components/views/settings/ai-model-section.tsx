"use client";

import { useState, useEffect, useCallback } from "react";
import {
    Sparkles, ChevronDown, RefreshCw, AlertTriangle,
} from "lucide-react";
import { SettingsSection, SettingsSkeleton } from "./settings-shared";
import { useToast } from "@/components/ui/toast";
import type { ModelsResponse, ModelPreference } from "./settings-types";
import {
    PROVIDER_LABELS, PROVIDER_ICONS, MODEL_PREF_KEY,
    getStoredModelPreference,
} from "./settings-types";

// ============================================================================
// AI Model & Provider Section
// ============================================================================

export function AiModelSection() {
    const { addToast } = useToast();
    const [modelsData, setModelsData] = useState<ModelsResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [selectedProvider, setSelectedProvider] = useState("");
    const [selectedModel, setSelectedModel] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [degraded, setDegraded] = useState(false);

    const fetchModels = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch("/api/models");
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data: ModelsResponse & { degraded?: boolean } = await res.json();
            setModelsData(data);
            setDegraded(!!data.degraded);

            const pref = getStoredModelPreference();
            if (pref) {
                setSelectedProvider(pref.provider);
                setSelectedModel(pref.model);
            } else {
                setSelectedProvider(data.defaultProvider || data.providers?.[0] || "");
                setSelectedModel(data.defaultModel || "");
            }
        } catch (err) {
            setError(String(err));
            setModelsData(null);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchModels(); }, [fetchModels]);

    const handleProviderChange = (provider: string) => {
        setSelectedProvider(provider);
        // Auto-select first model for provider
        if (modelsData?.byProvider?.[provider]?.length) {
            const firstModel = modelsData.byProvider[provider][0].id;
            setSelectedModel(firstModel);
            savePref(provider, firstModel);
        } else {
            setSelectedModel("");
            savePref(provider, "");
        }
    };

    const handleModelChange = (model: string) => {
        setSelectedModel(model);
        savePref(selectedProvider, model);
    };

    const savePref = (provider: string, model: string) => {
        const pref: ModelPreference = { provider, model };
        try {
            localStorage.setItem(MODEL_PREF_KEY, JSON.stringify(pref));
            addToast("success", "Model preference saved");
        } catch {
            // localStorage full
        }
    };

    const availableModels = modelsData?.byProvider?.[selectedProvider] || [];
    const providerIcon = PROVIDER_ICONS[selectedProvider] || "🔧";
    const providerLabel = PROVIDER_LABELS[selectedProvider] || selectedProvider;

    return (
        <SettingsSection
            id="ai-model"
            icon={<Sparkles className="w-5 h-5" />}
            title="AI Model & Provider"
            description="Select the default AI model for task dispatch"
        >
            <div className="space-y-5">
                {loading && <SettingsSkeleton lines={2} />}

                {!loading && !modelsData && (
                    <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 flex items-start gap-3">
                        <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                        <div>
                            <p className="text-sm font-medium text-amber-400">Gateway not connected</p>
                            <p className="text-xs text-amber-300/70 mt-1">Connect to the gateway to view available AI models.</p>
                        </div>
                    </div>
                )}

                {error && (
                    <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm mb-4">
                        <AlertTriangle className="w-4 h-4 shrink-0" />
                        <span>Failed to load models: {error}</span>
                        <button onClick={fetchModels} className="ml-auto text-xs underline hover:no-underline">Retry</button>
                    </div>
                )}
                {degraded && !error && (
                    <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/10 text-amber-500 text-sm mb-4">
                        <AlertTriangle className="w-4 h-4 shrink-0" />
                        <span>Gateway unreachable — showing cached model catalog. Some models may be unavailable.</span>
                    </div>
                )}

                {!loading && modelsData && (
                    <>
                        {/* Provider */}
                        <div>
                            <label className="block text-sm font-medium mb-2">Provider</label>
                            <div className="relative">
                                <select
                                    value={selectedProvider}
                                    onChange={(e) => handleProviderChange(e.target.value)}
                                    className="w-full px-4 py-2.5 rounded-lg border border-border bg-background focus:border-primary focus:ring-1 focus:ring-primary/50 outline-none transition-all text-sm appearance-none cursor-pointer"
                                >
                                    {modelsData.providers?.map((p: string) => (
                                        <option key={p} value={p}>
                                            {PROVIDER_ICONS[p] || "🔧"} {PROVIDER_LABELS[p] || p}
                                        </option>
                                    ))}
                                </select>
                                <ChevronDown className="w-4 h-4 text-muted-foreground absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                            </div>
                        </div>

                        {/* Model */}
                        <div>
                            <label className="block text-sm font-medium mb-2">Model</label>
                            {availableModels.length > 0 ? (
                                <div className="relative">
                                    <select
                                        value={selectedModel}
                                        onChange={(e) => handleModelChange(e.target.value)}
                                        className="w-full px-4 py-2.5 rounded-lg border border-border bg-background focus:border-primary focus:ring-1 focus:ring-primary/50 outline-none transition-all text-sm appearance-none cursor-pointer"
                                    >
                                        {availableModels.map((m) => (
                                            <option key={m.id} value={m.id}>
                                                {m.name || m.id}
                                            </option>
                                        ))}
                                    </select>
                                    <ChevronDown className="w-4 h-4 text-muted-foreground absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                                </div>
                            ) : (
                                <p className="text-sm text-muted-foreground">No models available for this provider.</p>
                            )}
                        </div>

                        {/* Current Selection */}
                        {selectedProvider && selectedModel && (
                            <div className="bg-muted/30 border border-border/50 rounded-lg p-4">
                                <p className="text-xs text-muted-foreground mb-2">Active Configuration</p>
                                <div className="flex items-center gap-3">
                                    <span className="text-2xl">{providerIcon}</span>
                                    <div>
                                        <p className="text-sm font-medium">{providerLabel}</p>
                                        <p className="text-xs text-muted-foreground font-mono">{selectedModel}</p>
                                    </div>
                                </div>
                            </div>
                        )}

                        <div className="flex justify-end pt-2">
                            <button
                                onClick={fetchModels}
                                className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-muted hover:bg-muted/80 border border-border transition-all"
                            >
                                <RefreshCw className="w-4 h-4" /> Refresh Models
                            </button>
                        </div>
                    </>
                )}
            </div>
        </SettingsSection>
    );
}
