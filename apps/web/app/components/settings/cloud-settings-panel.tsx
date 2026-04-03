"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { ChatModelSelector, type ChatModelSelectorOption } from "../chat-model-selector";
import { Button } from "../ui/button";
import { DenchIntegrationsSection } from "../integrations/dench-integrations-section";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

type CloudStatus = "no_key" | "invalid_key" | "valid";

type CatalogModel = {
  id: string;
  stableId: string;
  displayName: string;
  provider: string;
  reasoning: boolean;
};

type VoiceOption = {
  voiceId: string;
  name: string;
  description: string | null;
  category: string | null;
  previewUrl: string | null;
  labels: string[];
};

type CloudState = {
  status: CloudStatus;
  apiKeySource: "config" | "env" | "missing";
  gatewayUrl: string;
  primaryModel: string | null;
  isDenchPrimary: boolean;
  selectedDenchModel: string | null;
  selectedVoiceId: string | null;
  elevenLabsEnabled: boolean;
  models: CatalogModel[];
  recommendedModelId: string;
  validationError?: string;
};

type RefreshInfo = {
  attempted: boolean;
  restarted: boolean;
  error: string | null;
  profile: string;
};

type ActionNotice = {
  tone: "success" | "warning" | "error";
  message: string;
};

const DENCH_API_KEY_URL = "https://dench.com/api";

/** Sentinel for “default voice” in radio group (empty string is avoided for Radix value). */
const DEFAULT_VOICE_RADIO_VALUE = "__dench_default_voice__";

function NoticeBanner({ notice }: { notice: ActionNotice }) {
  const toneClass =
    notice.tone === "success"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
      : notice.tone === "warning"
        ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
        : "border-red-500/30 bg-red-500/10 text-red-300";

  return (
    <div className={`rounded-xl border px-4 py-3 text-sm ${toneClass}`}>
      {notice.message}
    </div>
  );
}

function CloudIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4" />
      <path d="m21 2-9.6 9.6" />
      <circle cx="7.5" cy="15.5" r="5.5" />
    </svg>
  );
}

function ExternalLinkIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  );
}

function ApiKeyEntry({
  onSave,
  saving,
  notice,
  validationError,
}: {
  onSave: (key: string) => void;
  saving: boolean;
  notice: ActionNotice | null;
  validationError?: string;
}) {
  const [keyInput, setKeyInput] = useState("");

  return (
    <div className="space-y-4">
      <div
        className="flex items-center gap-3 rounded-xl border px-4 py-3"
        style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
      >
        <div
          className="flex h-9 w-9 items-center justify-center rounded-lg shrink-0"
          style={{ background: "var(--color-surface-hover)", color: "var(--color-text)" }}
        >
          <CloudIcon />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium" style={{ color: "var(--color-text)" }}>
            Dench Cloud
          </div>
          <div className="text-[11px] mt-0.5" style={{ color: "var(--color-text-muted)" }}>
            {validationError
              ? "Your API key is invalid. Enter a new one below."
              : "Connect to Dench Cloud for AI model access."}
          </div>
        </div>
        <a
          href={DENCH_API_KEY_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg transition-colors hover:bg-stone-200 dark:hover:bg-stone-700"
          style={{ color: "var(--color-accent)" }}
        >
          Get API Key <ExternalLinkIcon />
        </a>
      </div>

      {validationError && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {validationError}
        </div>
      )}

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <span
            className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: "var(--color-text-muted)" }}
          >
            <KeyIcon />
          </span>
          <input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && keyInput.trim() && !saving) {
                onSave(keyInput.trim());
              }
            }}
            placeholder="Paste your Dench API key..."
            className="w-full pl-9 pr-3 py-2.5 rounded-xl text-sm outline-none transition-colors"
            style={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text)",
            }}
            disabled={saving}
          />
        </div>
        <Button
          type="button"
          onClick={() => { if (keyInput.trim()) onSave(keyInput.trim()); }}
          disabled={!keyInput.trim() || saving}
        >
          {saving ? "Validating..." : "Save"}
        </Button>
      </div>

      {notice && <NoticeBanner notice={notice} />}
    </div>
  );
}

function ModelSelector({
  models,
  selectedModel,
  selectedVoiceId,
  elevenLabsEnabled,
  isDenchPrimary,
  recommendedModelId,
  onSelect,
  onSelectVoice,
  selecting,
  savingVoice,
  voiceLoading,
  voices,
  notice,
}: {
  models: CatalogModel[];
  selectedModel: string | null;
  selectedVoiceId: string | null;
  elevenLabsEnabled: boolean;
  isDenchPrimary: boolean;
  recommendedModelId: string;
  onSelect: (stableId: string) => void;
  onSelectVoice: (voiceId: string | null) => void;
  selecting: boolean;
  savingVoice: boolean;
  voiceLoading: boolean;
  voices: VoiceOption[];
  notice: ActionNotice | null;
}) {
  const pickerModels: ChatModelSelectorOption[] = models
    .filter((model) => model.provider === "anthropic")
    .map((model) => ({
      stableId: model.stableId,
      displayName: model.displayName,
      provider: model.provider,
      reasoning: model.reasoning,
      isRecommended: model.id === recommendedModelId,
    }));
  const selectedVoice = voices.find((voice) => voice.voiceId === selectedVoiceId) ?? null;

  return (
    <div className="space-y-4">
      <div
        className="flex items-center gap-3 rounded-xl border px-4 py-3"
        style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
      >
        <div
          className="flex h-9 w-9 items-center justify-center rounded-lg shrink-0"
          style={{ background: "var(--color-surface-hover)", color: "var(--color-text)" }}
        >
          <CloudIcon />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium" style={{ color: "var(--color-text)" }}>
            Dench Cloud
          </div>
          <div className="text-[11px] mt-0.5" style={{ color: "var(--color-text-muted)" }}>
            {isDenchPrimary
              ? "Connected and active as your primary provider."
              : "Connected. Select a model to use Dench Cloud as your primary provider."}
          </div>
        </div>
        <span
          className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-medium"
          style={{
            background: isDenchPrimary ? "rgba(16,185,129,0.15)" : "var(--color-surface-hover)",
            color: isDenchPrimary ? "rgb(16,185,129)" : "var(--color-text-muted)",
          }}
        >
          {isDenchPrimary ? "Active" : "Available"}
        </span>
      </div>

      <div>
        <label
          className="block text-xs font-medium mb-2"
          style={{ color: "var(--color-text-muted)" }}
        >
          Primary Model
        </label>
        <ChatModelSelector
          models={pickerModels}
          selectedModel={isDenchPrimary ? selectedModel : null}
          onSelect={onSelect}
          fallbackToFirst={isDenchPrimary}
          placeholder="Choose a model..."
          ariaLabel="Select primary model"
        />
      </div>

      <div>
        <label
          className="block text-xs font-medium mb-2"
          style={{ color: "var(--color-text-muted)" }}
        >
          ElevenLabs Voice
        </label>
        <DropdownMenu>
          <DropdownMenuTrigger
            className="inline-flex max-w-full items-center gap-1.5 rounded-lg p-0 text-sm font-medium transition-opacity hover:opacity-100 disabled:cursor-default disabled:opacity-60 cursor-pointer outline-none ring-0 border-none"
            style={{ color: "var(--color-text-secondary)", opacity: 0.9 }}
            aria-label="Select ElevenLabs voice"
            title={selectedVoice?.name ?? undefined}
            disabled={voiceLoading || savingVoice || voices.length === 0}
          >
            <span
              className="max-w-[240px] truncate"
              style={
                voiceLoading || (!selectedVoice && voices.length === 0)
                  ? { color: "var(--color-text-muted)" }
                  : undefined
              }
            >
              {voiceLoading
                ? "Loading voices..."
                : voices.length === 0
                  ? "No voices available"
                  : selectedVoice
                    ? `${selectedVoice.name}${selectedVoice.category ? ` · ${selectedVoice.category}` : ""}`
                    : "Default voice (first available)"}
            </span>
            {voiceLoading || savingVoice ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden />
            ) : (
              <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            side="bottom"
            sideOffset={8}
            className="min-w-[15rem] max-w-[20rem] p-1.5"
          >
            <DropdownMenuRadioGroup
              value={selectedVoiceId ?? DEFAULT_VOICE_RADIO_VALUE}
              onValueChange={(value) => {
                onSelectVoice(
                  value === DEFAULT_VOICE_RADIO_VALUE ? null : value,
                );
              }}
            >
              <DropdownMenuRadioItem value={DEFAULT_VOICE_RADIO_VALUE}>
                Default voice (first available)
              </DropdownMenuRadioItem>
              {voices.map((voice) => (
                <DropdownMenuRadioItem key={voice.voiceId} value={voice.voiceId}>
                  <span className="truncate">
                    {voice.name}
                    {voice.category ? ` · ${voice.category}` : ""}
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="mt-2 space-y-1">
          <p className="text-[11px]" style={{ color: "var(--color-text-muted)" }}>
            {elevenLabsEnabled
              ? "Used for message playback and server-side voice input."
              : "Choose a voice now. Playback and server-side voice input stay off until ElevenLabs is enabled in Integrations."}
          </p>
          {selectedVoice?.description && (
            <p className="text-[11px]" style={{ color: "var(--color-text-muted)" }}>
              {selectedVoice.description}
            </p>
          )}
        </div>
      </div>

      {notice && <NoticeBanner notice={notice} />}
    </div>
  );
}

export function CloudSettingsPanel() {
  const [data, setData] = useState<CloudState | null>(null);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [voiceLoading, setVoiceLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [savingVoice, setSavingVoice] = useState(false);
  const [notice, setNotice] = useState<ActionNotice | null>(null);

  const fetchState = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/cloud");
      if (!res.ok) throw new Error(`Failed to load cloud settings (${res.status})`);
      const payload = (await res.json()) as CloudState;
      setData(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load cloud settings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchState();
  }, [fetchState]);

  useEffect(() => {
    if (data?.status !== "valid") {
      setVoices([]);
      return;
    }

    let cancelled = false;
    setVoiceLoading(true);

    void (async () => {
      try {
        const response = await fetch("/api/voice/voices");
        if (!response.ok) {
          if (!cancelled) {
            setVoices([]);
          }
          return;
        }
        const payload = await response.json() as { voices?: VoiceOption[] };
        if (!cancelled) {
          setVoices(Array.isArray(payload.voices) ? payload.voices : []);
        }
      } catch {
        if (!cancelled) {
          setVoices([]);
        }
      } finally {
        if (!cancelled) {
          setVoiceLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [data?.status, data?.gatewayUrl]);

  const handleSaveKey = useCallback(async (apiKey: string) => {
    setSaving(true);
    setNotice(null);
    try {
      const res = await fetch("/api/settings/cloud", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save_key", apiKey }),
      });
      const payload = await res.json();
      if (!res.ok) {
        setNotice({
          tone: "error",
          message: payload.error ?? "Failed to save API key.",
        });
        return;
      }
      setData(payload.state);
      const refresh = payload.refresh as RefreshInfo;
      if (refresh.restarted) {
        setNotice({
          tone: "success",
          message: `API key saved and the ${refresh.profile} gateway restarted successfully.`,
        });
      } else if (refresh.attempted) {
        setNotice({
          tone: "warning",
          message: `API key saved, but the gateway restart did not complete: ${refresh.error ?? "unknown error"}.`,
        });
      } else {
        setNotice({ tone: "success", message: "API key saved successfully." });
      }
    } catch (err) {
      setNotice({
        tone: "error",
        message: err instanceof Error ? err.message : "Failed to save API key.",
      });
    } finally {
      setSaving(false);
    }
  }, []);

  const handleSelectModel = useCallback(async (stableId: string) => {
    setSelecting(true);
    setNotice(null);
    try {
      const res = await fetch("/api/settings/cloud", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "select_model", stableId }),
      });
      const payload = await res.json();
      if (!res.ok) {
        setNotice({
          tone: "error",
          message: payload.error ?? "Failed to select model.",
        });
        return;
      }
      setData(payload.state);
      const refresh = payload.refresh as RefreshInfo;
      const modelName = payload.state?.models?.find(
        (m: CatalogModel) => m.stableId === stableId,
      )?.displayName ?? stableId;
      if (refresh.restarted) {
        setNotice({
          tone: "success",
          message: `Switched to ${modelName} and the ${refresh.profile} gateway restarted successfully.`,
        });
      } else if (refresh.attempted) {
        setNotice({
          tone: "warning",
          message: `Switched to ${modelName}, but the gateway restart did not complete: ${refresh.error ?? "unknown error"}.`,
        });
      } else {
        setNotice({ tone: "success", message: `Switched to ${modelName}.` });
      }
    } catch (err) {
      setNotice({
        tone: "error",
        message: err instanceof Error ? err.message : "Failed to select model.",
      });
    } finally {
      setSelecting(false);
    }
  }, []);

  const handleSelectVoice = useCallback(async (voiceId: string | null) => {
    setSavingVoice(true);
    setNotice(null);
    try {
      const res = await fetch("/api/settings/cloud", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save_voice", voiceId }),
      });
      const payload = await res.json();
      if (!res.ok) {
        setNotice({
          tone: "error",
          message: payload.error ?? "Failed to save voice.",
        });
        return;
      }
      setData(payload.state);
      const selectedName = voices.find((voice) => voice.voiceId === voiceId)?.name;
      setNotice({
        tone: "success",
        message: voiceId
          ? `Saved ${selectedName ?? "your selected voice"} for ElevenLabs playback.`
          : "Cleared the custom ElevenLabs voice selection.",
      });
    } catch (err) {
      setNotice({
        tone: "error",
        message: err instanceof Error ? err.message : "Failed to save voice.",
      });
    } finally {
      setSavingVoice(false);
    }
  }, [voices]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div
          className="h-6 w-6 animate-spin rounded-full border-2"
          style={{ borderColor: "var(--color-border)", borderTopColor: "var(--color-accent)" }}
        />
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="rounded-xl border px-4 py-6 text-center"
        style={{ borderColor: "var(--color-border)" }}
      >
        <p className="text-sm mb-3" style={{ color: "var(--color-text-muted)" }}>
          {error}
        </p>
        <Button type="button" variant="outline" onClick={() => void fetchState()}>
          Retry
        </Button>
      </div>
    );
  }

  if (!data) return null;

  if (data.status === "no_key" || data.status === "invalid_key") {
    return (
      <div className="space-y-8">
        <ApiKeyEntry
          onSave={handleSaveKey}
          saving={saving}
          notice={notice}
          validationError={data.status === "invalid_key" ? data.validationError : undefined}
        />
        <div>
          <h2 className="text-sm font-medium mb-3" style={{ color: "var(--color-text)" }}>Integrations</h2>
          <DenchIntegrationsSection />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <ModelSelector
        models={data.models}
        selectedModel={data.selectedDenchModel}
        selectedVoiceId={data.selectedVoiceId}
        elevenLabsEnabled={data.elevenLabsEnabled}
        isDenchPrimary={data.isDenchPrimary}
        recommendedModelId={data.recommendedModelId}
        onSelect={handleSelectModel}
        onSelectVoice={handleSelectVoice}
        selecting={selecting}
        savingVoice={savingVoice}
        voiceLoading={voiceLoading}
        voices={voices}
        notice={notice}
      />
      <div>
        <h2 className="text-sm font-medium mb-3" style={{ color: "var(--color-text)" }}>Integrations</h2>
        <DenchIntegrationsSection />
      </div>
    </div>
  );
}
