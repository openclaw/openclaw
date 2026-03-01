import {
  useState,
  useEffect,
  useCallback,
  useReducer,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Button,
  Dropdown,
  Input,
  Label,
  Option,
  Spinner,
  Text,
  tokens,
  makeStyles,
} from "@fluentui/react-components";
import {
  DeleteRegular,
  AddRegular,
  MicRegular,
  KeyboardRegular,
  DismissRegular,
} from "@fluentui/react-icons";
import { SettingsRow } from "../components/SettingsRow";
import {
  DEFAULT_VOICE_WAKE_TRIGGERS,
  sanitizeVoiceWakeAdditionalLocales,
  sanitizeVoiceWakeTriggers,
  useVoiceWake,
} from "../../../hooks/useVoiceWake";
import { formatError } from "../../../utils/error";
import {
  makeCustomChimeValue,
  playVoiceChime,
  voiceChimeLabel,
} from "../../../utils/voiceChime";

const CHIMES = [
  "None",
  "Glass",
  "Ping",
  "Basso",
  "Blow",
  "Bottle",
  "Funk",
  "Hero",
  "Morse",
  "Pop",
  "Purr",
  "Sosumi",
  "Submarine",
];
const DEFAULT_TRIGGERS = DEFAULT_VOICE_WAKE_TRIGGERS;

const useStyles = makeStyles({
  section: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    marginBottom: "20px",
  },
  sectionTitle: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    marginBottom: "4px",
  },
  fieldRow: {
    display: "grid",
    gridTemplateColumns: "140px 1fr",
    gap: "8px",
    alignItems: "center",
  },
  fieldLabel: {
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground2,
  },
  fieldNote: {
    fontSize: tokens.fontSizeBase100,
    color: tokens.colorNeutralForeground3,
  },
  triggerRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "6px 8px",
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  triggerInput: { flex: 1 },
  triggerTable: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: "6px",
    overflow: "hidden",
  },
  chimeRow: {
    display: "grid",
    gridTemplateColumns: "140px 1fr auto",
    gap: "8px",
    alignItems: "center",
  },
  testCard: {
    padding: "12px",
    borderRadius: "8px",
    backgroundColor: tokens.colorNeutralBackground3,
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  testStatus: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground2,
    fontStyle: "italic",
  },
  levelBar: {
    height: "6px",
    borderRadius: "3px",
    backgroundColor: tokens.colorNeutralBackground5,
    overflow: "hidden",
  },
  levelFill: {
    height: "100%",
    backgroundColor: tokens.colorBrandForeground1,
    transition: "width 0.1s",
  },
  errorBanner: {
    padding: "8px 12px",
    backgroundColor: tokens.colorPaletteRedBackground1,
    color: tokens.colorPaletteRedForeground1,
    borderRadius: "6px",
    fontSize: tokens.fontSizeBase200,
  },
});

type TestState =
  | "idle"
  | "requesting"
  | "listening"
  | "detected"
  | { error: string };

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

function hotkeyMainKeyFromEvent(event: KeyboardEvent): string | null {
  const code = event.code;
  const key = event.key;

  if (MODIFIER_KEYS.has(key) || MODIFIER_KEYS.has(code)) {
    return null;
  }

  if (/^Key[A-Z]$/.test(code)) {
    return code.slice(3);
  }

  if (/^Digit[0-9]$/.test(code)) {
    return code.slice(5);
  }

  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key.toUpperCase())) {
    return key.toUpperCase();
  }

  if (/^Numpad[0-9]$/.test(code)) {
    return code;
  }

  if (
    code === "NumpadAdd" ||
    code === "NumpadSubtract" ||
    code === "NumpadMultiply" ||
    code === "NumpadDivide" ||
    code === "NumpadDecimal" ||
    code === "NumpadEnter" ||
    code === "NumpadEqual"
  ) {
    return code;
  }

  const specialCodeMap: Record<string, string> = {
    Space: "Space",
    Enter: "Enter",
    Tab: "Tab",
    Escape: "Escape",
    Backspace: "Backspace",
    Delete: "Delete",
    Insert: "Insert",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Backquote: "Backquote",
    Minus: "Minus",
    Equal: "Equal",
    BracketLeft: "BracketLeft",
    BracketRight: "BracketRight",
    Backslash: "Backslash",
    Semicolon: "Semicolon",
    Quote: "Quote",
    Comma: "Comma",
    Period: "Period",
    Slash: "Slash",
    CapsLock: "CapsLock",
    PrintScreen: "PrintScreen",
    ScrollLock: "ScrollLock",
    Pause: "Pause",
    NumLock: "NumLock",
  };

  return specialCodeMap[code] ?? null;
}

function formatHotkeyFromEvent(event: KeyboardEvent): string | null {
  const mainKey = hotkeyMainKeyFromEvent(event);
  if (!mainKey) return null;

  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Control");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Super");
  parts.push(mainKey);
  return parts.join("+");
}

function localeLabel(localeId: string): string {
  try {
    const normalized = localeId.replace(/_/g, "-");
    const locale = new Intl.Locale(normalized);
    const display = new Intl.DisplayNames(undefined, { type: "language" });
    const language = locale.language
      ? (display.of(locale.language) ?? locale.language)
      : normalized;
    const region = locale.region
      ? new Intl.DisplayNames(undefined, { type: "region" }).of(locale.region)
      : null;
    return region ? `${language} (${region})` : language;
  } catch {
    return localeId;
  }
}

function sameStringArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

type StrArrayAction = string[] | ((prev: string[]) => string[]);
const strArrayReducer = (state: string[], action: StrArrayAction): string[] =>
  typeof action === "function" ? action(state) : action;

const strReducer = (_: string, action: string): string => action;

export function VoiceWakeTab() {
  const styles = useStyles();
  const [editableTriggers, setEditableTriggers] = useReducer(
    strArrayReducer,
    []
  );
  const [editableAdditionalLocales, setEditableAdditionalLocales] = useReducer(
    strArrayReducer,
    []
  );
  const [pttDraft, setPttDraft] = useReducer(strReducer, "");
  const [capturingPtt, setCapturingPtt] = useState(false);
  const [testState, setTestState] = useState<TestState>("idle");
  const [testHeardText, setTestHeardText] = useState("");
  const [isTesting, setIsTesting] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const testHeardTextRef = useRef("");
  const testTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const testUnlistenRef = useRef<UnlistenFn | null>(null);
  const editableTriggersRef = useRef<string[]>([]);
  const persistedTriggersRef = useRef<string[]>([]);
  const additionalLocalesRef = useRef<string[]>([]);
  const persistedAdditionalLocalesRef = useRef<string[]>([]);
  const pttDraftRef = useRef("");

  const {
    loading,
    error,
    clearError,
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
    setHardware,
    setAdditionalLocales,
    setPtt,
    setChimes,
  } = useVoiceWake();

  const speechPolicyBlocked = Boolean(
    error &&
    (error.includes("0x80045509") ||
      error.toLowerCase().includes("speech policy") ||
      error.toLowerCase().includes("online speech recognition"))
  );

  useEffect(() => {
    const sanitized = sanitizeVoiceWakeTriggers(triggers);
    setEditableTriggers(sanitized);
    persistedTriggersRef.current = sanitized;
  }, [triggers]);

  useEffect(() => {
    const sanitized = sanitizeVoiceWakeAdditionalLocales(additionalLocales);
    setEditableAdditionalLocales(sanitized);
    additionalLocalesRef.current = sanitized;
    persistedAdditionalLocalesRef.current = sanitized;
  }, [additionalLocales]);

  useEffect(() => {
    setPttDraft(pttKey);
    pttDraftRef.current = pttKey;
  }, [pttKey]);

  useEffect(() => {
    editableTriggersRef.current = editableTriggers;
  }, [editableTriggers]);

  useEffect(() => {
    additionalLocalesRef.current = editableAdditionalLocales;
  }, [editableAdditionalLocales]);

  useEffect(() => {
    pttDraftRef.current = pttDraft;
  }, [pttDraft]);

  const stopTest = useCallback((nextState: TestState = "idle") => {
    if (testTimeoutRef.current) {
      clearTimeout(testTimeoutRef.current);
      testTimeoutRef.current = null;
    }
    if (testUnlistenRef.current) {
      testUnlistenRef.current();
      testUnlistenRef.current = null;
    }
    setIsTesting(false);
    setTestState(nextState);
    if (nextState === "idle" || nextState === "detected") {
      setTestHeardText("");
      testHeardTextRef.current = "";
    }
  }, []);

  useEffect(() => {
    return () => stopTest("idle");
  }, [stopTest]);

  useEffect(() => {
    return () => {
      const next = sanitizeVoiceWakeTriggers(editableTriggersRef.current);
      if (!sameStringArray(next, persistedTriggersRef.current)) {
        void setTriggers(next);
      }
    };
  }, [setTriggers]);

  useEffect(() => {
    return () => {
      const next = sanitizeVoiceWakeAdditionalLocales(
        additionalLocalesRef.current
      );
      if (!sameStringArray(next, persistedAdditionalLocalesRef.current)) {
        void setAdditionalLocales(next);
      }
    };
  }, [setAdditionalLocales]);

  useEffect(() => {
    return () => {
      const nextDraft = pttDraftRef.current.trim();
      if (pttEnabled && nextDraft !== pttKey) {
        void setPtt(true, nextDraft);
      }
    };
  }, [pttEnabled, pttKey, setPtt]);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    listen<{ level?: number }>("voice_audio_level", (event) => {
      const rawLevel = Number(event.payload?.level ?? 0);
      if (!Number.isFinite(rawLevel)) return;
      // Speech RMS is usually low; scale gently so users can see movement.
      const normalized = Math.max(0, Math.min(1, rawLevel * 8));
      setMicLevel(normalized);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((error) => {
        console.error("Failed to subscribe voice_audio_level", error);
      });

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const persistTriggers = useCallback(
    async (next: string[]) => {
      const sanitized = sanitizeVoiceWakeTriggers(next);
      await setTriggers(sanitized);
      persistedTriggersRef.current = sanitized;
    },
    [setTriggers]
  );

  const resetDefaults = useCallback(async () => {
    editableTriggersRef.current = DEFAULT_TRIGGERS;
    setEditableTriggers(DEFAULT_TRIGGERS);
    await setTriggers(DEFAULT_TRIGGERS);
    persistedTriggersRef.current = DEFAULT_TRIGGERS;
  }, [setTriggers]);

  const capturePttShortcut = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        setCapturingPtt(false);
        return;
      }

      if (event.key === "Backspace" || event.key === "Delete") {
        pttDraftRef.current = "";
        setPttDraft("");
        void setPtt(pttEnabled, "");
        setCapturingPtt(false);
        return;
      }

      const shortcut = formatHotkeyFromEvent(event.nativeEvent);
      if (!shortcut) return;
      pttDraftRef.current = shortcut;
      setPttDraft(shortcut);
      setCapturingPtt(false);
      void setPtt(pttEnabled, shortcut);
    },
    [pttEnabled, setPtt]
  );

  const addAdditionalLocale = useCallback(async () => {
    const firstLocale = locales[0];
    if (!firstLocale) return;
    const next = sanitizeVoiceWakeAdditionalLocales([
      ...additionalLocalesRef.current,
      firstLocale,
    ]);
    setEditableAdditionalLocales(next);
    additionalLocalesRef.current = next;
    await setAdditionalLocales(next);
    persistedAdditionalLocalesRef.current = next;
  }, [locales, setAdditionalLocales]);

  const updateAdditionalLocale = useCallback(
    async (index: number, value: string) => {
      const next = [...additionalLocalesRef.current];
      next[index] = value;
      const normalized = sanitizeVoiceWakeAdditionalLocales(next);
      setEditableAdditionalLocales(normalized);
      additionalLocalesRef.current = normalized;
      await setAdditionalLocales(normalized);
      persistedAdditionalLocalesRef.current = normalized;
    },
    [setAdditionalLocales]
  );

  const removeAdditionalLocale = useCallback(
    async (index: number) => {
      const next = additionalLocalesRef.current.filter(
        (_, idx) => idx !== index
      );
      const normalized = sanitizeVoiceWakeAdditionalLocales(next);
      setEditableAdditionalLocales(normalized);
      additionalLocalesRef.current = normalized;
      await setAdditionalLocales(normalized);
      persistedAdditionalLocalesRef.current = normalized;
    },
    [setAdditionalLocales]
  );

  const previewChime = useCallback(
    async (name: string, mode: "invoke" | "send") => {
      try {
        await playVoiceChime(name, mode);
      } catch (err) {
        console.error("Failed to preview chime", err);
      }
    },
    []
  );

  const chooseCustomChime = useCallback(
    async (mode: "trigger" | "send") => {
      const selected = await open({
        directory: false,
        multiple: false,
        filters: [
          {
            name: "Audio",
            extensions: ["wav", "mp3", "m4a", "aac", "ogg", "flac", "wma"],
          },
        ],
      });
      if (typeof selected !== "string" || !selected.trim()) return;
      const customValue = makeCustomChimeValue(selected);
      if (mode === "trigger") {
        await setChimes(customValue, sendChime);
        await previewChime(customValue, "invoke");
      } else {
        await setChimes(triggerChime, customValue);
        await previewChime(customValue, "send");
      }
    },
    [previewChime, sendChime, setChimes, triggerChime]
  );

  const toggleTest = useCallback(async () => {
    if (isTesting) {
      stopTest("idle");
      return;
    }
    if (!enabled) {
      setTestState({ error: "Enable Voice Wake before starting the test." });
      return;
    }
    const normalizedTriggers = triggers
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    if (normalizedTriggers.length === 0) {
      setTestState({ error: "Add at least one trigger word before testing." });
      return;
    }

    setIsTesting(true);
    setTestHeardText("");
    testHeardTextRef.current = "";
    setTestState("requesting");
    try {
      const unlisten = await listen<{
        transcript?: string;
        rawTranscript?: string;
      }>("voice_wake_active", (event) => {
        const transcript = (
          event.payload?.rawTranscript ??
          event.payload?.transcript ??
          ""
        ).trim();
        if (!transcript) return;
        setTestHeardText(transcript);
        testHeardTextRef.current = transcript;
        const lowerTranscript = transcript.toLowerCase();
        const matched = normalizedTriggers.some((trigger) =>
          lowerTranscript.startsWith(trigger)
        );
        if (matched) {
          stopTest("detected");
        }
      });
      testUnlistenRef.current = unlisten;
      setTestState("listening");
      testTimeoutRef.current = setTimeout(() => {
        const heard = testHeardTextRef.current.trim();
        stopTest({
          error: heard
            ? `No trigger heard: "${heard}"`
            : "Timeout: no trigger heard",
        });
      }, 10000);
    } catch (e) {
      stopTest({ error: `Failed to start test: ${formatError(e)}` });
    }
  }, [enabled, isTesting, stopTest, triggers]);

  const testStatusText = (): string => {
    if (testState === "idle")
      return "Press start, say a trigger word, and wait for detection.";
    if (testState === "requesting") return "Starting recognition...";
    if (testState === "listening") {
      const heard = testHeardText.trim();
      return heard
        ? `Listening. Heard: "${heard}"`
        : "Listening. Say a trigger word.";
    }
    if (testState === "detected") return "Trigger detected.";
    if (typeof testState === "object") return `Error: ${testState.error}`;
    return "";
  };

  const selectedMic = micId.trim();
  const selectedMicRecord = microphones.find((m) => m.id === selectedMic);
  const selectedMicUnavailable = Boolean(selectedMic && !selectedMicRecord);
  const selectedMicLabel =
    selectedMicRecord?.name ??
    (selectedMicUnavailable ? selectedMic : "System default");

  if (loading) return <Spinner size="small" label="Loading..." />;

  return (
    <div>
      {error && (
        <div className={styles.errorBanner}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-start",
              flexWrap: "wrap",
              gap: "8px",
            }}
          >
            <Text style={{ flex: 1 }}>{error}</Text>
            {speechPolicyBlocked && (
              <Button
                size="small"
                appearance="secondary"
                onClick={() =>
                  invoke("open_windows_permission", {
                    capability: "speech_recognition",
                  })
                }
              >
                Open Speech Settings
              </Button>
            )}
            <Button
              size="small"
              appearance="subtle"
              icon={<DismissRegular />}
              onClick={clearError}
              aria-label="Dismiss voice wake error"
            />
          </div>
        </div>
      )}

      <div className={styles.section}>
        <SettingsRow
          icon={<MicRegular />}
          label="Enable Voice Wake"
          subtitle="Listen for a wake phrase running fully on-device."
          checked={enabled}
          onChange={setEnabled}
        />
        <SettingsRow
          icon={<KeyboardRegular />}
          label="Push-to-Talk"
          subtitle="Start listening while a key is held (shows overlay)."
          checked={pttEnabled}
          onChange={(v) => setPtt(v, pttDraftRef.current.trim())}
        />
      </div>

      <div className={styles.section}>
        <Text className={styles.sectionTitle}>Hardware</Text>
        <div className={styles.fieldRow}>
          <Label className={styles.fieldLabel}>Recognition language</Label>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <Dropdown
              value={locale ? localeLabel(locale) : "System default"}
              selectedOptions={[locale]}
              onOptionSelect={(_, d) => {
                if (typeof d.optionValue !== "string") return;
                void setHardware(micId, d.optionValue);
              }}
              listbox={{
                style: { backgroundColor: tokens.colorNeutralBackground2 },
              }}
            >
              <Option value="">System default</Option>
              {locales.map((l) => (
                <Option key={l} value={l}>
                  {localeLabel(l)}
                </Option>
              ))}
            </Dropdown>
            {editableAdditionalLocales.length > 0 && (
              <div
                style={{ display: "flex", flexDirection: "column", gap: "8px" }}
              >
                <Text className={styles.fieldNote}>Additional languages</Text>
                {editableAdditionalLocales.map((extraLocale, idx) => (
                  <div
                    key={`${idx}-${extraLocale}`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                    }}
                  >
                    <Dropdown
                      value={localeLabel(extraLocale)}
                      selectedOptions={[extraLocale]}
                      onOptionSelect={(_, d) => {
                        if (typeof d.optionValue !== "string") return;
                        void updateAdditionalLocale(idx, d.optionValue);
                      }}
                      listbox={{
                        style: {
                          backgroundColor: tokens.colorNeutralBackground2,
                        },
                      }}
                    >
                      {locales.map((l) => (
                        <Option key={l} value={l}>
                          {localeLabel(l)}
                        </Option>
                      ))}
                    </Dropdown>
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<DeleteRegular />}
                      onClick={() => {
                        void removeAdditionalLocale(idx);
                      }}
                      aria-label={`Remove additional language ${idx + 1}`}
                    />
                  </div>
                ))}
              </div>
            )}
            <Button
              size="small"
              appearance="subtle"
              icon={<AddRegular />}
              disabled={locales.length === 0}
              onClick={() => {
                void addAdditionalLocale();
              }}
            >
              {editableAdditionalLocales.length > 0
                ? "Add language"
                : "Add additional language"}
            </Button>
            <Text className={styles.fieldNote}>
              Languages are tried in order. Models may need a first-use
              download.
            </Text>
          </div>
        </div>
        <div className={styles.fieldRow}>
          <Label className={styles.fieldLabel}>Microphone</Label>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <Dropdown
              value={selectedMicLabel}
              selectedOptions={[micId]}
              onOptionSelect={(_, d) => {
                if (typeof d.optionValue !== "string") return;
                void setHardware(d.optionValue, locale);
              }}
              listbox={{
                style: { backgroundColor: tokens.colorNeutralBackground2 },
              }}
            >
              <Option value="">System default</Option>
              {microphones.map((m) => (
                <Option key={m.id} value={m.id}>
                  {m.name}
                </Option>
              ))}
            </Dropdown>
            <Text className={styles.fieldNote}>
              Recognition uses the OS default input device during runtime.
            </Text>
            {selectedMicUnavailable && (
              <Text className={styles.fieldNote}>
                Disconnected ({selectedMicLabel}). Runtime uses system default.
              </Text>
            )}
          </div>
        </div>

        <div className={styles.fieldRow}>
          <Label className={styles.fieldLabel}>Live level</Label>
          <div>
            <div className={styles.levelBar}>
              <div
                className={styles.levelFill}
                style={{ width: `${micLevel * 100}%` }}
              />
            </div>
            <Text
              style={{
                fontSize: tokens.fontSizeBase100,
                color: tokens.colorNeutralForeground3,
              }}
            >
              {micLevel > 0
                ? `${Math.round(micLevel * 50 - 50)} dB`
                : "Monitoring not active"}
            </Text>
          </div>
        </div>
      </div>

      {pttEnabled && (
        <div className={styles.section}>
          <div className={styles.fieldRow}>
            <Label className={styles.fieldLabel}>PTT Key</Label>
            <div
              style={{ display: "flex", flexDirection: "column", gap: "6px" }}
            >
              <Input
                value={pttDraft}
                readOnly
                placeholder="Click and press a shortcut"
                onFocus={() => setCapturingPtt(true)}
                onBlur={() => setCapturingPtt(false)}
                onPaste={(e) => e.preventDefault()}
                onBeforeInput={(e) => e.preventDefault()}
                onKeyDown={capturePttShortcut}
                style={{
                  borderColor: capturingPtt
                    ? tokens.colorBrandStroke1
                    : undefined,
                }}
              />
              <Text className={styles.fieldNote}>
                {capturingPtt
                  ? "Listening for shortcut. Press Esc to cancel, Backspace to clear."
                  : "Click the field and press the shortcut."}
              </Text>
            </div>
          </div>
        </div>
      )}

      <div className={styles.section}>
        <div className={styles.testCard}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Text style={{ fontWeight: tokens.fontWeightSemibold }}>
              Test Voice Wake
            </Text>
            <Button
              size="small"
              appearance={isTesting ? "outline" : "primary"}
              onClick={toggleTest}
            >
              {isTesting ? "Stop" : "Start Test"}
            </Button>
            {isTesting && <Spinner size="tiny" />}
          </div>
          <Text className={styles.testStatus}>{testStatusText()}</Text>
        </div>
      </div>

      <div className={styles.section}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Text className={styles.sectionTitle}>Trigger words</Text>
          <div style={{ display: "flex", gap: "6px" }}>
            <Button size="small" appearance="subtle" onClick={resetDefaults}>
              Reset defaults
            </Button>
            <Button
              size="small"
              icon={<AddRegular />}
              disabled={editableTriggers.some((t) => !t.trim())}
              onClick={() =>
                setEditableTriggers((prev) => {
                  const next = [...prev, ""];
                  editableTriggersRef.current = next;
                  return next;
                })
              }
            >
              Add word
            </Button>
          </div>
        </div>

        <div className={styles.triggerTable}>
          {editableTriggers.map((trigger, i) => (
            <div key={i} className={styles.triggerRow}>
              <Input
                className={styles.triggerInput}
                value={trigger}
                placeholder="Wake word"
                onChange={(_, d) => {
                  const next = [...editableTriggers];
                  next[i] = d.value;
                  editableTriggersRef.current = next;
                  setEditableTriggers(next);
                }}
                onBlur={async () => {
                  await persistTriggers(editableTriggersRef.current);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void persistTriggers(editableTriggersRef.current);
                  }
                }}
              />
              <Button
                size="small"
                appearance="subtle"
                icon={<DeleteRegular />}
                onClick={async () => {
                  const next = editableTriggers.filter((_, idx) => idx !== i);
                  editableTriggersRef.current = next;
                  setEditableTriggers(next);
                  await persistTriggers(next);
                }}
              />
            </div>
          ))}
          {editableTriggers.length === 0 && (
            <div
              style={{
                padding: "12px",
                color: tokens.colorNeutralForeground3,
                fontSize: tokens.fontSizeBase200,
              }}
            >
              No trigger words. Add one above.
            </div>
          )}
        </div>
        <Text
          style={{
            fontSize: tokens.fontSizeBase100,
            color: tokens.colorNeutralForeground3,
          }}
        >
          OpenClaw reacts when any trigger appears in a transcription. Keep them
          short to avoid false positives.
        </Text>
      </div>

      <div className={styles.section}>
        <Text className={styles.sectionTitle}>Sounds</Text>
        <div className={styles.chimeRow}>
          <Label className={styles.fieldLabel}>Trigger sound</Label>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <Dropdown
              value={voiceChimeLabel(triggerChime)}
              selectedOptions={[triggerChime]}
              onOptionSelect={(_, d) => {
                if (typeof d.optionValue !== "string") return;
                void setChimes(d.optionValue, sendChime);
              }}
              listbox={{
                style: { backgroundColor: tokens.colorNeutralBackground2 },
              }}
            >
              {CHIMES.map((c) => (
                <Option key={c} value={c}>
                  {voiceChimeLabel(c)}
                </Option>
              ))}
              {triggerChime.startsWith("Custom:") && (
                <Option value={triggerChime}>
                  {voiceChimeLabel(triggerChime)}
                </Option>
              )}
            </Dropdown>
            <Button
              size="small"
              appearance="subtle"
              onClick={() => {
                void chooseCustomChime("trigger");
              }}
            >
              Choose file...
            </Button>
          </div>
          <Button
            size="small"
            onClick={() => void previewChime(triggerChime, "invoke")}
          >
            Play
          </Button>
        </div>
        <div className={styles.chimeRow}>
          <Label className={styles.fieldLabel}>Send sound</Label>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <Dropdown
              value={voiceChimeLabel(sendChime)}
              selectedOptions={[sendChime]}
              onOptionSelect={(_, d) => {
                if (typeof d.optionValue !== "string") return;
                void setChimes(triggerChime, d.optionValue);
              }}
              listbox={{
                style: { backgroundColor: tokens.colorNeutralBackground2 },
              }}
            >
              {CHIMES.map((c) => (
                <Option key={c} value={c}>
                  {voiceChimeLabel(c)}
                </Option>
              ))}
              {sendChime.startsWith("Custom:") && (
                <Option value={sendChime}>{voiceChimeLabel(sendChime)}</Option>
              )}
            </Dropdown>
            <Button
              size="small"
              appearance="subtle"
              onClick={() => {
                void chooseCustomChime("send");
              }}
            >
              Choose file...
            </Button>
          </div>
          <Button
            size="small"
            onClick={() => void previewChime(sendChime, "send")}
          >
            Play
          </Button>
        </div>
      </div>
    </div>
  );
}
