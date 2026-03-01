import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { formatError } from "../utils/error";

const VOICE_WAKE_MAX_WORDS = 32;
const VOICE_WAKE_MAX_WORD_LENGTH = 64;
export const DEFAULT_VOICE_WAKE_TRIGGERS = ["openclaw"];

export interface AudioDevice {
  id: string;
  name: string;
}

export interface VoiceWakeSettings {
  enabled: boolean;
  triggers: string[];
  micId: string;
  locale: string;
  additionalLocales: string[];
  pttEnabled: boolean;
  pttKey: string;
  triggerChime: string;
  sendChime: string;
}

export interface VoiceWakeHardware {
  microphones: AudioDevice[];
  locales: string[];
}

export interface UseVoiceWakeReturn
  extends VoiceWakeSettings, VoiceWakeHardware {
  loading: boolean;
  error: string | null;
  clearError: () => void;
  reload: () => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
  setTriggers: (triggers: string[]) => Promise<void>;
  addTrigger: (phrase: string) => Promise<void>;
  removeTrigger: (index: number) => Promise<void>;
  setHardware: (micId: string, locale: string) => Promise<void>;
  setAdditionalLocales: (locales: string[]) => Promise<void>;
  setPtt: (enabled: boolean, key: string) => Promise<void>;
  setChimes: (triggerChime: string, sendChime: string) => Promise<void>;
}

export function sanitizeVoiceWakeAdditionalLocales(values: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const dedupeKey = trimmed.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalized.push(trimmed);
  }
  return normalized;
}

export function sanitizeVoiceWakeTriggers(values: string[]): string[] {
  const normalized: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    normalized.push(trimmed.slice(0, VOICE_WAKE_MAX_WORD_LENGTH));
    if (normalized.length >= VOICE_WAKE_MAX_WORDS) break;
  }
  return normalized.length > 0 ? normalized : [...DEFAULT_VOICE_WAKE_TRIGGERS];
}

export function useVoiceWake(): UseVoiceWakeReturn {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [enabled, setEnabledState] = useState(false);
  const [triggers, setTriggersState] = useState<string[]>([]);
  const [micId, setMicIdState] = useState("");
  const [locale, setLocaleState] = useState("");
  const [additionalLocales, setAdditionalLocalesState] = useState<string[]>([]);
  const [pttEnabled, setPttEnabledState] = useState(false);
  const [pttKey, setPttKeyState] = useState("");
  const [triggerChime, setTriggerChimeState] = useState("Glass");
  const [sendChime, setSendChimeState] = useState("Glass");

  const [microphones, setMicrophones] = useState<AudioDevice[]>([]);
  const [locales, setLocales] = useState<string[]>([]);

  const showError = useCallback((msg: string) => {
    console.error("[useVoiceWake]", msg);
    setError(msg);
    setTimeout(() => setError(null), 5000);
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [settings, hardware]: [VoiceWakeSettings, VoiceWakeHardware] =
        await Promise.all([
          invoke<VoiceWakeSettings>("get_voice_wake_settings"),
          invoke<VoiceWakeHardware>("get_voice_wake_hardware"),
        ]);
      setEnabledState(settings.enabled);
      setTriggersState(sanitizeVoiceWakeTriggers(settings.triggers));
      setMicIdState(settings.micId);
      setLocaleState(settings.locale);
      setAdditionalLocalesState(
        sanitizeVoiceWakeAdditionalLocales(settings.additionalLocales ?? [])
      );
      setPttEnabledState(settings.pttEnabled);
      setPttKeyState(settings.pttKey);
      setTriggerChimeState(settings.triggerChime);
      setSendChimeState(settings.sendChime);
      setMicrophones(hardware.microphones);
      setLocales(hardware.locales);
    } catch (e) {
      showError(`Failed to load settings: ${formatError(e)}`);
    } finally {
      setLoading(false);
    }
  }, [showError]);

  useEffect(() => {
    reload();
  }, [reload]);

  const setEnabled = useCallback(
    async (v: boolean) => {
      try {
        await invoke("set_voice_wake_enabled", { enabled: v });
        setEnabledState(v);
      } catch (e) {
        showError(`Failed to toggle voice wake: ${formatError(e)}`);
      }
    },
    [showError]
  );

  const setTriggers = useCallback(
    async (nextTriggers: string[]) => {
      const normalized = sanitizeVoiceWakeTriggers(nextTriggers);
      try {
        await invoke("set_voice_wake_triggers", { triggers: normalized });
        setTriggersState(normalized);
      } catch (e) {
        showError(`Failed to save triggers: ${formatError(e)}`);
      }
    },
    [showError]
  );

  const addTrigger = useCallback(
    async (phrase: string) => {
      const next = sanitizeVoiceWakeTriggers([...triggers, phrase]);
      try {
        await invoke("set_voice_wake_triggers", { triggers: next });
        setTriggersState(next);
      } catch (e) {
        showError(`Failed to add trigger: ${formatError(e)}`);
      }
    },
    [triggers, showError]
  );

  const removeTrigger = useCallback(
    async (index: number) => {
      const next = sanitizeVoiceWakeTriggers(
        triggers.filter((_, i) => i !== index)
      );
      try {
        await invoke("set_voice_wake_triggers", { triggers: next });
        setTriggersState(next);
      } catch (e) {
        showError(`Failed to remove trigger: ${formatError(e)}`);
      }
    },
    [triggers, showError]
  );

  const setHardware = useCallback(
    async (newMicId: string, newLocale: string) => {
      try {
        await invoke("set_voice_wake_hardware", {
          micId: newMicId,
          locale: newLocale,
        });
        setMicIdState(newMicId);
        setLocaleState(newLocale);
      } catch (e) {
        showError(`Failed to save hardware: ${formatError(e)}`);
      }
    },
    [showError]
  );

  const setPtt = useCallback(
    async (en: boolean, key: string) => {
      try {
        await invoke("set_voice_wake_ptt", { enabled: en, key });
        setPttEnabledState(en);
        setPttKeyState(key);
      } catch (e) {
        showError(`Failed to save PTT: ${formatError(e)}`);
      }
    },
    [showError]
  );

  const setChimes = useCallback(
    async (tc: string, sc: string) => {
      try {
        await invoke("set_voice_wake_chimes", {
          triggerChime: tc,
          sendChime: sc,
        });
        setTriggerChimeState(tc);
        setSendChimeState(sc);
      } catch (e) {
        showError(`Failed to save chimes: ${formatError(e)}`);
      }
    },
    [showError]
  );

  const setAdditionalLocales = useCallback(
    async (nextLocales: string[]) => {
      const normalized = sanitizeVoiceWakeAdditionalLocales(nextLocales);
      try {
        await invoke("set_voice_wake_additional_locales", {
          locales: normalized,
        });
        setAdditionalLocalesState(normalized);
      } catch (e) {
        showError(`Failed to save additional locales: ${formatError(e)}`);
      }
    },
    [showError]
  );

  return {
    loading,
    error,
    clearError: () => setError(null),
    reload,
    enabled,
    triggers,
    micId,
    locale,
    additionalLocales,
    pttEnabled,
    pttKey,
    triggerChime,
    sendChime,
    microphones,
    locales,
    setEnabled,
    setTriggers,
    addTrigger,
    removeTrigger,
    setHardware,
    setAdditionalLocales,
    setPtt,
    setChimes,
  };
}
