"use client";

import { useState, useCallback, useEffect } from "react";
import {
    Server, Plus, X, Cpu, HardDrive, Trash2, Loader2,
    RefreshCw, AlertTriangle,
} from "lucide-react";
import { SettingsSection, SettingsSkeleton } from "./settings-shared";
import { useToast } from "@/components/ui/toast";
import type { LocalModelsData } from "./settings-types";
import { formatFileSize, formatRelativeTime } from "./settings-types";

// ============================================================================
// Local Models Section
// ============================================================================

export function LocalModelsSection() {
    const { addToast } = useToast();
    const [data, setData] = useState<LocalModelsData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [showAddForm, setShowAddForm] = useState(false);
    const [newName, setNewName] = useState("");
    const [newModelId, setNewModelId] = useState("");
    const [newBaseUrl, setNewBaseUrl] = useState("http://localhost:11434");
    const [saving, setSaving] = useState(false);
    const [ollamaUrl, setOllamaUrl] = useState("http://localhost:11434");
    const [registeringModel, setRegisteringModel] = useState<string | null>(null);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

    const fetchModels = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams();
            if (ollamaUrl) params.set("ollamaUrl", ollamaUrl);
            const res = await fetch(`/api/settings/models?${params.toString()}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const json: LocalModelsData = await res.json();
            setData(json);
        } catch (err) {
            setError(String(err));
            setData(null);
        } finally {
            setLoading(false);
        }
    }, [ollamaUrl]);

    useEffect(() => { fetchModels(); }, [fetchModels]);

    const isRegistered = (modelName: string): boolean => {
        if (!data) return false;
        return data.models.some((m) => m.model_id === modelName);
    };

    const handleRegisterOllama = async (modelName: string) => {
        setRegisteringModel(modelName);
        try {
            const res = await fetch("/api/settings/models", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: modelName.split(":")[0], model_id: modelName, base_url: ollamaUrl, source: "ollama" }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            await fetchModels();
            addToast("success", `Registered ${modelName}`);
        } catch (err) {
            addToast("error", `Failed to register model: ${err}`);
        } finally {
            setRegisteringModel(null);
        }
    };

    const handleAdd = async () => {
        if (!newName.trim() || !newModelId.trim()) return;
        setSaving(true);
        try {
            const res = await fetch("/api/settings/models", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: newName, model_id: newModelId, base_url: newBaseUrl }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            await fetchModels();
            setShowAddForm(false);
            setNewName("");
            setNewModelId("");
            setNewBaseUrl(ollamaUrl);
            addToast("success", "Local model added");
        } catch (err) {
            addToast("error", `Failed to add model: ${err}`);
        } finally {
            setSaving(false);
        }
    };

    const handleToggle = async (id: string, isActive: boolean) => {
        if (!data) return;
        setData((prev) => prev ? { ...prev, models: prev.models.map((m) => (m.id === id ? { ...m, is_active: isActive } : m)) } : prev);
        try {
            const res = await fetch("/api/settings/models", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id, is_active: isActive }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch {
            setData((prev) => prev ? { ...prev, models: prev.models.map((m) => (m.id === id ? { ...m, is_active: !isActive } : m)) } : prev);
            addToast("error", "Failed to toggle model");
        }
    };

    const handleDelete = async (id: string) => {
        setDeletingId(id);
        try {
            const res = await fetch(`/api/settings/models?id=${encodeURIComponent(id)}`, { method: "DELETE" });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            await fetchModels();
            addToast("success", "Model removed");
        } catch (err) {
            addToast("error", `Failed to delete model: ${err}`);
        } finally {
            setDeletingId(null);
            setConfirmDeleteId(null);
        }
    };

    return (
        <SettingsSection
            id="local-models"
            icon={<Server className="w-5 h-5" />}
            title="Local Models"
            description="Manage locally-running AI models (Ollama, LM Studio, etc.)"
        >
            <div className="space-y-4">
                {error && (
                    <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-4 flex items-start gap-3">
                        <AlertTriangle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
                        <div>
                            <p className="text-sm font-medium text-destructive">Failed to load local models</p>
                            <p className="text-xs text-destructive/80 mt-1">{error}</p>
                        </div>
                    </div>
                )}

                {loading && <SettingsSkeleton lines={2} />}

                {/* Ollama Connection Status */}
                {!loading && data && (
                    <div className="flex items-center gap-3">
                        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm ${data.ollamaAvailable
                                ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                                : "bg-destructive/10 text-destructive border border-destructive/30"
                            }`}>
                            <span className={`w-2 h-2 rounded-full ${data.ollamaAvailable ? "bg-emerald-400" : "bg-destructive"}`} />
                            {data.ollamaAvailable ? "Ollama Connected" : "Ollama Not Running"}
                        </div>
                    </div>
                )}

                {/* Ollama URL Configuration */}
                {!loading && data && (
                    <div className="flex items-center gap-2 mb-3">
                        <label className="text-xs text-muted-foreground whitespace-nowrap">Ollama URL:</label>
                        <input
                            type="text"
                            value={ollamaUrl}
                            onChange={(e) => setOllamaUrl(e.target.value)}
                            placeholder="http://localhost:11434"
                            className="flex-1 px-3 py-1.5 rounded-lg border border-border bg-background text-xs font-mono focus:border-primary focus:ring-1 focus:ring-primary/50 outline-none transition-all"
                        />
                    </div>
                )}

                {/* Ollama Available Models */}
                {!loading && data?.ollamaAvailable && data.ollamaModels.length > 0 && (
                    <div>
                        <label className="block text-sm font-medium mb-3">
                            Available Ollama Models <span className="text-muted-foreground font-normal ml-2">({data.ollamaModels.length} found)</span>
                        </label>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            {data.ollamaModels.map((m) => {
                                const registered = isRegistered(m.name);
                                return (
                                    <div key={m.name} className="bg-card border border-border rounded-lg p-4 hover:border-primary/30 transition-colors">
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="flex items-start gap-3 flex-1 min-w-0">
                                                <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center text-primary shrink-0">
                                                    <HardDrive className="w-4 h-4" />
                                                </div>
                                                <div className="flex-1 min-w-0">
                                                    <p className="font-medium text-sm truncate">{m.name}</p>
                                                    <p className="text-xs text-muted-foreground mt-0.5">{formatFileSize(m.size)}</p>
                                                    <p className="text-xs text-muted-foreground">{formatRelativeTime(m.modified_at)}</p>
                                                </div>
                                            </div>
                                            {registered ? (
                                                <span className="px-2 py-0.5 rounded text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 shrink-0">Active</span>
                                            ) : (
                                                <button
                                                    onClick={() => handleRegisterOllama(m.name)}
                                                    disabled={registeringModel === m.name}
                                                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:opacity-90 transition-all disabled:opacity-50 shrink-0"
                                                >
                                                    {registeringModel === m.name ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                                                    Register
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}

                {/* Ollama available but no models */}
                {!loading && data?.ollamaAvailable && data.ollamaModels.length === 0 && (
                    <div className="bg-muted/30 border border-border/50 rounded-lg p-6 text-center">
                        <HardDrive className="w-12 h-12 mx-auto mb-3 text-muted-foreground/50" />
                        <p className="text-sm text-muted-foreground">
                            Ollama is running but no models are installed. Pull models using{" "}
                            <code className="px-1.5 py-0.5 rounded bg-muted text-xs font-mono">ollama pull llama3.2</code>
                        </p>
                    </div>
                )}

                {/* Registered Models */}
                {!loading && data && data.models.length > 0 && (
                    <div>
                        <label className="block text-sm font-medium mb-3">
                            Registered Models <span className="text-muted-foreground font-normal ml-2">({data.models.length})</span>
                        </label>
                        <div className="space-y-3">
                            {data.models.map((model) => (
                                <div key={model.id} className="bg-card border border-border rounded-lg p-4 hover:border-primary/30 transition-colors">
                                    <div className="flex items-start justify-between gap-4">
                                        <div className="flex items-start gap-3 flex-1 min-w-0">
                                            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary shrink-0">
                                                <Cpu className="w-5 h-5" />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2 mb-1 flex-wrap">
                                                    <span className="font-medium text-sm">{model.name}</span>
                                                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${model.is_active
                                                            ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                                                            : "bg-gray-500/10 text-gray-400 border border-gray-500/30"
                                                        }`}>
                                                        {model.is_active ? "Active" : "Inactive"}
                                                    </span>
                                                </div>
                                                <p className="text-xs text-muted-foreground font-mono">{model.model_id}</p>
                                                <p className="text-xs text-muted-foreground mt-1">{model.base_url}</p>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-2 shrink-0">
                                            <button
                                                onClick={() => handleToggle(model.id, !model.is_active)}
                                                className={`relative w-11 h-6 rounded-full transition-colors ${model.is_active ? "bg-primary" : "bg-muted"}`}
                                                title={model.is_active ? "Disable" : "Enable"}
                                            >
                                                <span className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-transform ${model.is_active ? "left-6" : "left-1"}`} />
                                            </button>
                                            {confirmDeleteId === model.id ? (
                                                <div className="flex items-center gap-1">
                                                    <button
                                                        onClick={() => handleDelete(model.id)}
                                                        disabled={deletingId === model.id}
                                                        className="px-2 py-1 rounded text-xs font-medium bg-destructive/10 text-destructive hover:bg-destructive/20 border border-destructive/30 transition-colors disabled:opacity-50"
                                                    >
                                                        {deletingId === model.id ? <Loader2 className="w-3 h-3 animate-spin" /> : "Confirm"}
                                                    </button>
                                                    <button onClick={() => setConfirmDeleteId(null)} className="px-2 py-1 rounded text-xs font-medium text-muted-foreground hover:bg-muted/50 transition-colors">
                                                        Cancel
                                                    </button>
                                                </div>
                                            ) : (
                                                <button onClick={() => setConfirmDeleteId(model.id)} className="p-2 rounded-lg hover:bg-destructive/10 transition-colors text-muted-foreground hover:text-destructive" title="Delete model">
                                                    <Trash2 className="w-4 h-4" />
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* No registered models */}
                {!loading && data && data.models.length === 0 && (
                    <div className="bg-muted/30 border border-border/50 rounded-lg p-6 text-center">
                        <Server className="w-12 h-12 mx-auto mb-3 text-muted-foreground/50" />
                        <p className="text-sm text-muted-foreground">No local models registered yet.</p>
                    </div>
                )}

                {/* Add Custom Model */}
                {!showAddForm && !loading && (
                    <button
                        onClick={() => setShowAddForm(true)}
                        className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-muted hover:bg-muted/80 border border-border transition-all"
                    >
                        <Plus className="w-4 h-4" />
                        Add Custom Model
                    </button>
                )}

                {showAddForm && (
                    <div className="bg-muted/30 border border-border/50 rounded-lg p-5 space-y-4 animate-in fade-in slide-in-from-top-2 duration-200">
                        <div className="flex items-center justify-between">
                            <h4 className="text-sm font-semibold">Add Custom Local Model</h4>
                            <button onClick={() => { setShowAddForm(false); setNewName(""); setNewModelId(""); setNewBaseUrl(ollamaUrl); }} className="p-1 rounded hover:bg-muted/50 text-muted-foreground">
                                <X className="w-4 h-4" />
                            </button>
                        </div>
                        <div>
                            <label className="block text-sm font-medium mb-2">Model Name</label>
                            <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. My Local LLaMA" maxLength={100}
                                className="w-full px-4 py-2.5 rounded-lg border border-border bg-background focus:border-primary focus:ring-1 focus:ring-primary/50 outline-none transition-all text-sm" />
                        </div>
                        <div>
                            <label className="block text-sm font-medium mb-2">Model ID</label>
                            <input type="text" value={newModelId} onChange={(e) => setNewModelId(e.target.value)} placeholder="e.g. llama3.2:latest" maxLength={200}
                                className="w-full px-4 py-2.5 rounded-lg border border-border bg-background focus:border-primary focus:ring-1 focus:ring-primary/50 outline-none transition-all text-sm font-mono" />
                        </div>
                        <div>
                            <label className="block text-sm font-medium mb-2">Base URL</label>
                            <input type="url" value={newBaseUrl} onChange={(e) => setNewBaseUrl(e.target.value)} placeholder="http://localhost:11434" maxLength={500}
                                className="w-full px-4 py-2.5 rounded-lg border border-border bg-background focus:border-primary focus:ring-1 focus:ring-primary/50 outline-none transition-all text-sm" />
                        </div>
                        <div className="flex items-center gap-3 pt-1">
                            <button
                                onClick={handleAdd}
                                disabled={!newName.trim() || !newModelId.trim() || saving}
                                className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium transition-all ${!newName.trim() || !newModelId.trim() || saving
                                        ? "bg-muted text-muted-foreground cursor-not-allowed"
                                        : "bg-primary text-primary-foreground hover:opacity-90 shadow-[0_0_15px_oklch(0.58_0.2_260/0.3)]"
                                    }`}
                            >
                                {saving ? (<><Loader2 className="w-4 h-4 animate-spin" /> Adding...</>) : (<><Plus className="w-4 h-4" /> Add Model</>)}
                            </button>
                            <button onClick={() => { setShowAddForm(false); setNewName(""); setNewModelId(""); setNewBaseUrl(ollamaUrl); }} className="px-4 py-2.5 rounded-lg text-sm font-medium text-muted-foreground hover:bg-muted/50 transition-colors">Cancel</button>
                        </div>
                    </div>
                )}

                {/* Refresh */}
                {!loading && (
                    <div className="flex justify-end pt-2">
                        <button onClick={fetchModels} className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-muted hover:bg-muted/80 border border-border transition-all">
                            <RefreshCw className="w-4 h-4" /> Refresh Models
                        </button>
                    </div>
                )}
            </div>
        </SettingsSection>
    );
}
