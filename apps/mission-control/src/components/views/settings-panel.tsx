"use client";

import {
  useEffect,
  useState,
  useCallback,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  Bell,
  BellOff,
  Keyboard,
  Download,
  Upload,
  Settings2,
  Clock,
  Trash2,
  Info,
  Volume2,
  VolumeX,
  LayoutGrid,
  Timer,
  Layers,
  ExternalLink,
  LayoutDashboard,
} from "lucide-react";

// Sub-components from the new settings module
import { SettingsSection, Toggle } from "./settings/settings-shared";
import { AppearanceSection } from "./settings/appearance-section";
import { GatewaySection } from "./settings/gateway-section";
import { RiskLevelSection } from "./settings/risk-level-section";
import { LocalModelsSection } from "./settings/local-models-section";
import { AiModelSection } from "./settings/ai-model-section";
import { AiApiCommandCenter } from "./settings/ai-api-command-center";
import { IntegrationsSection } from "./settings/integrations-section";
import { ToastProvider } from "@/components/ui/toast";

import type { ThemeMode, AppSettings } from "./settings/settings-types";
import {
  DEFAULT_SETTINGS,
  KEYBOARD_SHORTCUTS,
  loadSettings,
  saveSettings,
  resolveTheme,
  applyTheme,
} from "./settings/settings-types";

// ============================================================================
// SettingsPanel — orchestrator for all settings sections
// ============================================================================

export default function SettingsPanel() {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const mounted = useSyncExternalStore(
    () => () => { },
    () => true,
    () => false
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Apply theme on mount and theme change
  useEffect(() => {
    if (!mounted) return;
    applyTheme(resolveTheme(settings.theme));
  }, [settings.theme, mounted]);

  // Watch for system theme changes
  useEffect(() => {
    if (settings.theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => applyTheme(resolveTheme("system"));
    mq.addEventListener("change", handleChange);
    return () => mq.removeEventListener("change", handleChange);
  }, [settings.theme]);

  // Persist settings
  const updateSettings = useCallback(
    (updated: AppSettings) => {
      setSettings(updated);
      saveSettings(updated);
    },
    []
  );

  const handleThemeChange = useCallback(
    (theme: ThemeMode) => {
      updateSettings({ ...settings, theme });
    },
    [settings, updateSettings]
  );

  // --- Data Management Handlers ---

  const handleExport = () => {
    const data = JSON.stringify(settings, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `openclaw-settings-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const imported = JSON.parse(ev.target?.result as string);
        const merged = { ...DEFAULT_SETTINGS, ...imported };
        updateSettings(merged);
      } catch {
        // Invalid JSON
      }
    };
    reader.readAsText(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleReset = () => {
    if (window.confirm("Reset all settings to defaults? This cannot be undone.")) {
      updateSettings(DEFAULT_SETTINGS);
    }
  };

  if (!mounted) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-pulse text-muted-foreground">Loading settings...</div>
      </div>
    );
  }

  return (
    <ToastProvider>
      <div className="max-w-4xl mx-auto space-y-4 p-4 sm:p-6 pb-20">
        {/* Page Header */}
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
              <Settings2 className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-bold">Settings</h1>
              <p className="text-sm text-muted-foreground">
                Configure OpenClaw Mission Control to your liking
              </p>
            </div>
          </div>
        </div>

        {/* ───────── Section 1: Appearance ───────── */}
        <AppearanceSection settings={settings} onThemeChange={handleThemeChange} />

        {/* ───────── Section 2: Risk Level (NEW) ───────── */}
        <RiskLevelSection />

        {/* ───────── Section 3: Gateway Connection ───────── */}
        <GatewaySection settings={settings} onSettingsChange={updateSettings} />

        {/* ───────── Section 4: Session Management ───────── */}
        <SettingsSection
          id="session"
          icon={<Clock className="w-5 h-5" />}
          title="Session Management"
          description="Auto-save, history, and view preferences"
          defaultOpen={false}
        >
          <div className="space-y-1">
            <Toggle
              enabled={settings.session.autoSave}
              onChange={(v) =>
                updateSettings({
                  ...settings,
                  session: { ...settings.session, autoSave: v },
                })
              }
              label="Auto-Save Sessions"
              description="Automatically save session state"
              icon={<Timer className="w-4 h-4" />}
            />

            {settings.session.autoSave && (
              <div className="pl-7 pb-3">
                <label className="block text-xs text-muted-foreground mb-1.5">
                  Save interval (minutes)
                </label>
                <input
                  type="number"
                  min={1}
                  max={60}
                  value={settings.session.autoSaveInterval}
                  onChange={(e) =>
                    updateSettings({
                      ...settings,
                      session: {
                        ...settings.session,
                        autoSaveInterval: parseInt(e.target.value, 10) || 5,
                      },
                    })
                  }
                  className="w-24 px-3 py-1.5 rounded-lg border border-border bg-background text-sm focus:border-primary focus:ring-1 focus:ring-primary/50 outline-none transition-all"
                />
              </div>
            )}

            <Toggle
              enabled={settings.session.compactMode}
              onChange={(v) =>
                updateSettings({
                  ...settings,
                  session: { ...settings.session, compactMode: v },
                })
              }
              label="Compact Mode"
              description="Condense the UI for smaller screens"
              icon={<LayoutGrid className="w-4 h-4" />}
            />

            <div className="pt-3">
              <label className="block text-sm font-medium mb-2">
                <div className="flex items-center gap-2">
                  <Layers className="w-4 h-4 text-muted-foreground" />
                  Max History Items
                </div>
              </label>
              <input
                type="number"
                min={10}
                max={1000}
                value={settings.session.maxHistoryItems}
                onChange={(e) =>
                  updateSettings({
                    ...settings,
                    session: {
                      ...settings.session,
                      maxHistoryItems: parseInt(e.target.value, 10) || 100,
                    },
                  })
                }
                className="w-32 px-3 py-1.5 rounded-lg border border-border bg-background text-sm focus:border-primary focus:ring-1 focus:ring-primary/50 outline-none transition-all"
              />
            </div>
          </div>
        </SettingsSection>

        {/* ───────── Section 5: Notifications ───────── */}
        <SettingsSection
          id="notifications"
          icon={<Bell className="w-5 h-5" />}
          title="Notifications"
          description="Control alerts and notification sounds"
          defaultOpen={false}
        >
          <div className="space-y-1">
            <Toggle
              enabled={settings.notifications.enabled}
              onChange={(v) =>
                updateSettings({
                  ...settings,
                  notifications: { ...settings.notifications, enabled: v },
                })
              }
              label="Enable Notifications"
              description="Show desktop and in-app notifications"
              icon={
                settings.notifications.enabled ? (
                  <Bell className="w-4 h-4" />
                ) : (
                  <BellOff className="w-4 h-4" />
                )
              }
            />
            <Toggle
              enabled={settings.notifications.sound}
              onChange={(v) =>
                updateSettings({
                  ...settings,
                  notifications: { ...settings.notifications, sound: v },
                })
              }
              label="Sound Effects"
              description="Play sound on notifications"
              icon={
                settings.notifications.sound ? (
                  <Volume2 className="w-4 h-4" />
                ) : (
                  <VolumeX className="w-4 h-4" />
                )
              }
            />
            <Toggle
              enabled={settings.notifications.taskComplete}
              onChange={(v) =>
                updateSettings({
                  ...settings,
                  notifications: {
                    ...settings.notifications,
                    taskComplete: v,
                  },
                })
              }
              label="Task Complete"
              description="Notify when a task finishes"
            />
            <Toggle
              enabled={settings.notifications.taskError}
              onChange={(v) =>
                updateSettings({
                  ...settings,
                  notifications: {
                    ...settings.notifications,
                    taskError: v,
                  },
                })
              }
              label="Task Errors"
              description="Notify on task failures"
            />
            <Toggle
              enabled={settings.notifications.mentions}
              onChange={(v) =>
                updateSettings({
                  ...settings,
                  notifications: { ...settings.notifications, mentions: v },
                })
              }
              label="Mentions"
              description="Notify when you are mentioned"
            />
          </div>
        </SettingsSection>

        {/* ───────── Section 6: AI API Command Center ───────── */}
        <AiApiCommandCenter />

        {/* ───────── Section 7: Model Selection ───────── */}
        <AiModelSection />

        {/* ───────── Section 8: Integrations ───────── */}
        <IntegrationsSection />

        {/* ───────── Section 9: Local Models ───────── */}
        <LocalModelsSection />

        {/* ───────── Section 10: Keyboard Shortcuts ───────── */}
        <SettingsSection
          id="keyboard-shortcuts"
          icon={<Keyboard className="w-5 h-5" />}
          title="Keyboard Shortcuts"
          description="Speed up your workflow with keyboard shortcuts"
          defaultOpen={false}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {KEYBOARD_SHORTCUTS.map((sc) => (
              <div
                key={sc.description}
                className="flex items-center justify-between px-4 py-3 rounded-lg bg-muted/30 border border-border/50"
              >
                <span className="text-sm text-muted-foreground">{sc.description}</span>
                <div className="flex items-center gap-1">
                  {sc.keys.map((key, i) => (
                    <span key={i}>
                      <kbd className="px-2 py-0.5 rounded bg-muted border border-border text-xs font-mono font-medium">
                        {key}
                      </kbd>
                      {i < sc.keys.length - 1 && (
                        <span className="text-xs text-muted-foreground mx-0.5">+</span>
                      )}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </SettingsSection>

        {/* ───────── Section 11: Data Management ───────── */}
        <SettingsSection
          id="data-management"
          icon={<Download className="w-5 h-5" />}
          title="Data Management"
          description="Export, import, or reset your settings"
          defaultOpen={false}
        >
          <div className="space-y-4">
            <div className="flex flex-wrap gap-3">
              <button
                onClick={handleExport}
                className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 transition-all shadow-[0_0_15px_oklch(0.58_0.2_260/0.3)]"
              >
                <Download className="w-4 h-4" /> Export Settings
              </button>

              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-muted hover:bg-muted/80 border border-border transition-all"
              >
                <Upload className="w-4 h-4" /> Import Settings
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json"
                onChange={handleImport}
                className="hidden"
              />

              <button
                onClick={handleReset}
                className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium text-destructive hover:bg-destructive/10 border border-destructive/30 transition-all"
              >
                <Trash2 className="w-4 h-4" /> Reset to Defaults
              </button>
            </div>

            <p className="text-xs text-muted-foreground">
              Export includes all settings, model preferences, and configuration. Import
              will overwrite your current settings.
            </p>
          </div>
        </SettingsSection>

        {/* ───────── Built-in Dashboard Link ───────── */}
        <SettingsSection
          icon={<LayoutDashboard className="w-5 h-5" />}
          title="OpenClaw Built-in Dashboard"
          description="Access the gateway's native UI"
          defaultOpen={false}
        >
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              The gateway has its own built-in dashboard for low-level controls, raw
              session management, and direct gateway interaction.
            </p>
            <a
              href="http://127.0.0.1:18789"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-medium bg-muted border border-border hover:border-primary/50 hover:bg-primary/5 hover:text-primary transition-all"
            >
              <ExternalLink className="w-4 h-4" />
              Open Built-in Dashboard
            </a>
          </div>
        </SettingsSection>

        {/* ───────── Info Footer ───────── */}
        <div className="bg-card/50 border border-border/50 rounded-xl p-5 text-sm text-muted-foreground space-y-3">
          <div className="flex items-start gap-3">
            <Info className="w-5 h-5 shrink-0 mt-0.5" />
            <div className="space-y-2">
              <p className="font-medium text-foreground">About Settings</p>
              <ul className="list-disc list-inside space-y-1 text-xs">
                <li>All settings are stored locally in your browser</li>
                <li>Risk Level, API keys, and integrations are stored server-side</li>
                <li>Model selection is applied when dispatching new tasks</li>
                <li>Existing in-progress tasks keep their original model assignment</li>
                <li>Use export to backup your settings before clearing browser data</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </ToastProvider>
  );
}
