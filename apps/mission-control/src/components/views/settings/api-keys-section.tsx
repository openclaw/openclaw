"use client";

import { useState, useCallback, useEffect } from "react";
import {
    Key, Plus, X, Eye, EyeOff, TestTube, Trash2, Loader2,
    RefreshCw, AlertTriangle,
} from "lucide-react";
import { SettingsSection, ApiKeyStatusBadge, SettingsSkeleton } from "./settings-shared";
import { useToast } from "@/components/ui/toast";
import type { ApiKeyResponse } from "./settings-types";
import { API_KEY_PROVIDERS, PROVIDER_ICONS, PROVIDER_LABELS, formatRelativeTime } from "./settings-types";

// ============================================================================
// API Keys Section
// ============================================================================

interface ApiKeysSectionProps {
    defaultProvider?: string | null;
    onProviderHandled?: () => void;
}

export function ApiKeysSection({ defaultProvider, onProviderHandled }: ApiKeysSectionProps = {}) {
    const { addToast } = useToast();
    const [apiKeys, setApiKeys] = useState<ApiKeyResponse[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [showAddForm, setShowAddForm] = useState(false);
    const [newProvider, setNewProvider] = useState(API_KEY_PROVIDERS[0].id);
    const [newLabel, setNewLabel] = useState(API_KEY_PROVIDERS[0].name);
    const [newValue, setNewValue] = useState("");
    const [newBaseUrl, setNewBaseUrl] = useState("");
    const [showNewValue, setShowNewValue] = useState(false);
    const [saving, setSaving] = useState(false);
    const [testingId, setTestingId] = useState<string | null>(null);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

    const fetchApiKeys = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetch("/api/settings/api-keys");
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json = await res.json();
            setApiKeys(Array.isArray(json.keys) ? json.keys : []);
        } catch (err) {
            setError(String(err));
            setApiKeys([]);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchApiKeys(); }, [fetchApiKeys]);

    useEffect(() => {
        if (defaultProvider) {
            const providerDef = API_KEY_PROVIDERS.find(p => p.id === defaultProvider);
            if (providerDef) {
                setNewProvider(providerDef.id);
                setNewLabel(providerDef.name);
            }
            setShowAddForm(true);
            onProviderHandled?.();
        }
    }, [defaultProvider, onProviderHandled]);

    const handleAdd = async () => {
        if (!newValue.trim()) return;
        setSaving(true);
        try {
            // 1. Save the key
            const saveRes = await fetch("/api/settings/api-keys", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    provider: newProvider,
                    label: newLabel,
                    api_key: newValue,
                    base_url: newBaseUrl || null,
                }),
            });
            if (!saveRes.ok) throw new Error(`Save failed: HTTP ${saveRes.status}`);
            const saved = await saveRes.json();
            const savedId = saved.key?.id || saved.id;

            // 2. Test the key
            let testStatus = "untested";
            if (savedId) {
                try {
                    const testRes = await fetch("/api/settings/api-keys", {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ id: savedId, test: true }),
                    });
                    if (testRes.ok) {
                        const testResult = await testRes.json();
                        testStatus = testResult?.testResult?.status || "untested";
                    }
                } catch {
                    // Test failure is non-fatal
                }
            }

            // 3. Report result
            if (testStatus === "active") {
                addToast("success", `API key added and verified — ${newLabel} is active`);
            } else if (testStatus === "error") {
                addToast("warning", `API key saved but test failed — check your ${newLabel} key`);
            } else {
                addToast("success", "API key added (could not verify — provider may not support testing)");
            }

            await fetchApiKeys();
            setShowAddForm(false);
            setNewValue("");
            setNewBaseUrl("");
            setNewProvider(API_KEY_PROVIDERS[0].id);
            setNewLabel(API_KEY_PROVIDERS[0].name);
            setShowNewValue(false);
        } catch (err) {
            addToast("error", `Failed to save API key: ${err}`);
        } finally {
            setSaving(false);
        }
    };

    const handleToggle = async (id: string, isActive: boolean) => {
        setApiKeys((prev) => prev.map((k) => (k.id === id ? { ...k, is_active: isActive } : k)));
        try {
            const res = await fetch("/api/settings/api-keys", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id, is_active: isActive }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            addToast("success", `API key ${isActive ? "enabled" : "disabled"}`);
        } catch {
            setApiKeys((prev) => prev.map((k) => (k.id === id ? { ...k, is_active: !isActive } : k)));
            addToast("error", "Failed to toggle API key");
        }
    };

    const handleTest = async (id: string) => {
        setTestingId(id);
        try {
            const res = await fetch("/api/settings/api-keys", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id, test: true }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const result = await res.json();
            setApiKeys((prev) =>
                prev.map((k) =>
                    k.id === id
                        ? { ...k, last_tested_at: new Date().toISOString(), last_test_status: result.testResult?.status || "active" }
                        : k
                )
            );
            const testOk = result.testResult?.ok;
            addToast(testOk ? "success" : "warning", testOk ? "API key test passed" : `API key test: ${result.testResult?.detail || "failed"}`);
        } catch {
            setApiKeys((prev) =>
                prev.map((k) =>
                    k.id === id ? { ...k, last_tested_at: new Date().toISOString(), last_test_status: "failed" } : k
                )
            );
            addToast("error", "API key test failed");
        } finally {
            setTestingId(null);
        }
    };

    const handleDelete = async (id: string) => {
        setDeletingId(id);
        try {
            const res = await fetch(`/api/settings/api-keys?id=${encodeURIComponent(id)}`, { method: "DELETE" });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            setApiKeys((prev) => prev.filter((k) => k.id !== id));
            addToast("success", "API key deleted");
        } catch (err) {
            addToast("error", `Failed to delete API key: ${err}`);
        } finally {
            setDeletingId(null);
            setConfirmDeleteId(null);
        }
    };

    return (
        <SettingsSection
            id="api-keys"
            icon={<Key className="w-5 h-5" />}
            title="API Keys"
            description="Manage API keys for AI providers"
        >
            <div className="space-y-4">
                {error && (
                    <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-4 flex items-start gap-3">
                        <AlertTriangle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
                        <div>
                            <p className="text-sm font-medium text-destructive">Failed to load API keys</p>
                            <p className="text-xs text-destructive/80 mt-1">{error}</p>
                        </div>
                    </div>
                )}

                {loading && <SettingsSkeleton lines={2} />}

                {/* Add Button */}
                {!showAddForm && !loading && (
                    <button
                        onClick={() => setShowAddForm(true)}
                        className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 transition-all shadow-[0_0_15px_oklch(0.58_0.2_260/0.2)]"
                    >
                        <Plus className="w-4 h-4" />
                        Add API Key
                    </button>
                )}

                {/* Add Form */}
                {showAddForm && (
                    <div className="bg-muted/30 border border-border/50 rounded-lg p-5 space-y-4 animate-in fade-in slide-in-from-top-2 duration-200">
                        <div className="flex items-center justify-between">
                            <h4 className="text-sm font-semibold">Add New API Key</h4>
                            <button
                                onClick={() => { setShowAddForm(false); setNewValue(""); setNewBaseUrl(""); setShowNewValue(false); }}
                                className="p-1 rounded hover:bg-muted/50 text-muted-foreground"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        <div>
                            <label className="block text-sm font-medium mb-2">Provider</label>
                            <select
                                value={newProvider}
                                onChange={(e) => {
                                    const provider = API_KEY_PROVIDERS.find((p) => p.id === e.target.value);
                                    setNewProvider(e.target.value);
                                    if (provider) setNewLabel(provider.name);
                                }}
                                className="w-full px-4 py-2.5 rounded-lg border border-border bg-background focus:border-primary focus:ring-1 focus:ring-primary/50 outline-none transition-all text-sm"
                            >
                                {API_KEY_PROVIDERS.map((provider) => (
                                    <option key={provider.id} value={provider.id}>
                                        {provider.icon} {provider.name}
                                    </option>
                                ))}
                            </select>
                        </div>

                        <div>
                            <label className="block text-sm font-medium mb-2">Label</label>
                            <input
                                type="text"
                                value={newLabel}
                                onChange={(e) => setNewLabel(e.target.value)}
                                placeholder="e.g. My OpenAI Key"
                                maxLength={100}
                                className="w-full px-4 py-2.5 rounded-lg border border-border bg-background focus:border-primary focus:ring-1 focus:ring-primary/50 outline-none transition-all text-sm"
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-medium mb-2">API Key</label>
                            <div className="relative">
                                <input
                                    type={showNewValue ? "text" : "password"}
                                    value={newValue}
                                    onChange={(e) => setNewValue(e.target.value)}
                                    placeholder={API_KEY_PROVIDERS.find((p) => p.id === newProvider)?.placeholder || "Enter API key..."}
                                    className="w-full px-4 py-2.5 pr-12 rounded-lg border border-border bg-background focus:border-primary focus:ring-1 focus:ring-primary/50 outline-none transition-all text-sm font-mono"
                                />
                                <button
                                    onClick={() => setShowNewValue(!showNewValue)}
                                    className="absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-muted/50 text-muted-foreground"
                                >
                                    {showNewValue ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                </button>
                            </div>
                        </div>

                        <div>
                            <label className="block text-sm font-medium mb-2">
                                Custom Base URL <span className="text-xs text-muted-foreground font-normal">(optional)</span>
                            </label>
                            <input
                                type="url"
                                value={newBaseUrl}
                                onChange={(e) => setNewBaseUrl(e.target.value)}
                                placeholder="https://api.example.com/v1"
                                maxLength={500}
                                className="w-full px-4 py-2.5 rounded-lg border border-border bg-background focus:border-primary focus:ring-1 focus:ring-primary/50 outline-none transition-all text-sm"
                            />
                        </div>

                        <div className="flex items-center gap-3 pt-1">
                            <button
                                onClick={handleAdd}
                                disabled={!newValue.trim() || saving}
                                className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-all ${!newValue.trim() || saving
                                    ? "bg-muted text-muted-foreground cursor-not-allowed"
                                    : "bg-primary text-primary-foreground hover:opacity-90 shadow-[0_0_15px_oklch(0.58_0.2_260/0.3)]"
                                    }`}
                            >
                                {saving ? (<><Loader2 className="w-4 h-4 animate-spin" /> Verifying...</>) : (<><TestTube className="w-4 h-4" /> Add & Verify</>)}
                            </button>
                            <button
                                onClick={() => { setShowAddForm(false); setNewValue(""); setNewBaseUrl(""); setShowNewValue(false); }}
                                className="px-4 py-2.5 rounded-lg text-sm font-medium text-muted-foreground hover:bg-muted/50 transition-colors"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                )}

                {/* Empty state */}
                {!loading && apiKeys.length === 0 && !error && (
                    <div className="bg-muted/30 border border-border/50 rounded-lg p-6 text-center">
                        <Key className="w-12 h-12 mx-auto mb-3 text-muted-foreground/50" />
                        <p className="text-sm text-muted-foreground">
                            No API keys configured yet. Add a key to get started.
                        </p>
                    </div>
                )}

                {/* Keys List */}
                {apiKeys.length > 0 && (
                    <div className="space-y-3">
                        {apiKeys.map((apiKey) => {
                            const providerInfo = API_KEY_PROVIDERS.find((p) => p.id === apiKey.provider);
                            const providerIcon = providerInfo?.icon || PROVIDER_ICONS[apiKey.provider] || "🔧";
                            const providerName = providerInfo?.name || PROVIDER_LABELS[apiKey.provider] || apiKey.provider;

                            return (
                                <div key={apiKey.id} className="bg-card border border-border rounded-lg p-4 hover:border-primary/30 transition-colors">
                                    <div className="flex items-start justify-between gap-4">
                                        <div className="flex items-start gap-3 flex-1 min-w-0">
                                            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center text-lg shrink-0">
                                                {providerIcon}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2 mb-1 flex-wrap">
                                                    <span className="font-medium text-sm">{providerName}</span>
                                                    <ApiKeyStatusBadge status={apiKey.last_test_status} isActive={apiKey.is_active} />
                                                </div>
                                                <p className="text-xs text-muted-foreground">{apiKey.label}</p>
                                                <p className="text-xs text-muted-foreground font-mono mt-1">{apiKey.key_preview}</p>
                                                {apiKey.base_url && <p className="text-xs text-muted-foreground mt-1 truncate">{apiKey.base_url}</p>}
                                                {apiKey.last_tested_at && (
                                                    <p className="text-xs text-muted-foreground mt-1">Last tested: {formatRelativeTime(apiKey.last_tested_at)}</p>
                                                )}
                                            </div>
                                        </div>

                                        <div className="flex items-center gap-2 shrink-0">
                                            <button
                                                onClick={() => handleToggle(apiKey.id, !apiKey.is_active)}
                                                className={`relative w-11 h-6 rounded-full transition-colors ${apiKey.is_active ? "bg-primary" : "bg-muted"}`}
                                                title={apiKey.is_active ? "Disable" : "Enable"}
                                            >
                                                <span className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-transform ${apiKey.is_active ? "left-6" : "left-1"}`} />
                                            </button>
                                            <button
                                                onClick={() => handleTest(apiKey.id)}
                                                disabled={testingId === apiKey.id}
                                                className="p-2 rounded-lg hover:bg-muted/50 transition-colors text-muted-foreground hover:text-primary disabled:opacity-50"
                                                title="Test key"
                                            >
                                                {testingId === apiKey.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <TestTube className="w-4 h-4" />}
                                            </button>
                                            {confirmDeleteId === apiKey.id ? (
                                                <div className="flex items-center gap-1">
                                                    <button
                                                        onClick={() => handleDelete(apiKey.id)}
                                                        disabled={deletingId === apiKey.id}
                                                        className="px-2 py-1 rounded text-xs font-medium bg-destructive/10 text-destructive hover:bg-destructive/20 border border-destructive/30 transition-colors disabled:opacity-50"
                                                    >
                                                        {deletingId === apiKey.id ? <Loader2 className="w-3 h-3 animate-spin" /> : "Confirm"}
                                                    </button>
                                                    <button
                                                        onClick={() => setConfirmDeleteId(null)}
                                                        className="px-2 py-1 rounded text-xs font-medium text-muted-foreground hover:bg-muted/50 transition-colors"
                                                    >
                                                        Cancel
                                                    </button>
                                                </div>
                                            ) : (
                                                <button
                                                    onClick={() => setConfirmDeleteId(apiKey.id)}
                                                    className="p-2 rounded-lg hover:bg-destructive/10 transition-colors text-muted-foreground hover:text-destructive"
                                                    title="Delete key"
                                                >
                                                    <Trash2 className="w-4 h-4" />
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}

                {/* Refresh */}
                {!loading && (
                    <div className="flex justify-end pt-2">
                        <button
                            onClick={fetchApiKeys}
                            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-muted hover:bg-muted/80 border border-border transition-all"
                        >
                            <RefreshCw className="w-4 h-4" />
                            Refresh Keys
                        </button>
                    </div>
                )}
            </div>
        </SettingsSection>
    );
}
