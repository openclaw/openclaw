/**
 * Session settings manager.
 *
 * Holds attempt-local settings after global, plugin, and project preparation.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createInvalidConfigError } from "../../config/io.invalid-config.js";
import { mergeDeep } from "../../infra/deep-merge.js";
import type {
  Settings,
  SettingsScope,
  ThinkingBudgetsSettings,
  TransportSetting,
} from "./settings-storage.js";

export type { Settings, ThinkingBudgetsSettings, TransportSetting } from "./settings-storage.js";

export function requireSupportedSettings(value: unknown, scope: SettingsScope): Settings {
  if (!isRecord(value)) {
    throw new TypeError("Session settings must be an object");
  }
  const retired: string[] = [];
  if (Object.hasOwn(value, "queueMode")) {
    retired.push("queueMode: use steeringMode");
  }
  if (Object.hasOwn(value, "websockets")) {
    retired.push('websockets: use transport (true becomes "websocket", false becomes "sse")');
  }
  if (isRecord(value.skills)) {
    retired.push(
      "skills: use its customDirectories array (or []), and move skills.enableSkillCommands to top-level enableSkillCommands if present",
    );
  }
  if (isRecord(value.retry) && Object.hasOwn(value.retry, "maxDelayMs")) {
    retired.push("retry.maxDelayMs: use retry.provider.maxRetryDelayMs");
  }
  if (retired.length > 0) {
    throw createInvalidConfigError(
      `${scope} session settings.json`,
      `Retired session settings: ${retired.join("; ")}. ` +
        "Preserve the original file and replace the retired forms while retaining values that already use the current forms before retrying. " +
        "For a staged upgrade, OpenClaw 2026.9.7 retains the former settings reader. " +
        "See https://docs.openclaw.ai/gateway/doctor/config-migrations#session-settings.",
      { recovery: "manual" },
    );
  }
  return value as Settings;
}

export class SettingsManager {
  private settings: Settings = {};
  private baseSettings: Settings;
  private runtimeOverrides: Settings = {};

  private constructor(settings: Settings) {
    // Prepared snapshots are shared and frozen; setters own this top-level record.
    this.baseSettings = { ...settings };
    this.recomputeSettings();
  }

  static inMemory(settings: Partial<Settings> = {}): SettingsManager {
    return new SettingsManager(requireSupportedSettings(settings, "global"));
  }

  getGlobalSettings(): Settings {
    return this.baseSettings;
  }

  private recomputeSettings(): void {
    this.settings = mergeDeep(this.baseSettings, this.runtimeOverrides) as Settings;
  }

  /** Layer runtime policy above the prepared settings and local default changes. */
  applyOverrides(overrides: Partial<Settings>): void {
    this.runtimeOverrides = mergeDeep(this.runtimeOverrides, overrides) as Settings;
    this.recomputeSettings();
  }

  private setGlobalSettings(values: Settings): void {
    Object.assign(this.baseSettings, values);
    this.recomputeSettings();
  }

  private setGlobalNestedSetting(
    field: "compaction" | "retry",
    nestedField: string,
    value: unknown,
  ): void {
    const current = this.baseSettings[field];
    const nested = isRecord(current) ? { ...current } : {};
    nested[nestedField] = value;
    this.setGlobalSettings({ [field]: nested });
  }

  setDefaultModelAndProvider(provider: string, modelId: string): void {
    this.setGlobalSettings({ defaultProvider: provider, defaultModel: modelId });
  }

  getSteeringMode(): "all" | "one-at-a-time" {
    return this.settings.steeringMode || "one-at-a-time";
  }

  setSteeringMode(mode: "all" | "one-at-a-time"): void {
    this.setGlobalSettings({ steeringMode: mode });
  }

  getFollowUpMode(): "all" | "one-at-a-time" {
    return this.settings.followUpMode || "one-at-a-time";
  }

  setFollowUpMode(mode: "all" | "one-at-a-time"): void {
    this.setGlobalSettings({ followUpMode: mode });
  }

  getDefaultThinkingLevel(): Settings["defaultThinkingLevel"] {
    return this.settings.defaultThinkingLevel;
  }

  setDefaultThinkingLevel(level: NonNullable<Settings["defaultThinkingLevel"]>): void {
    this.setGlobalSettings({ defaultThinkingLevel: level });
  }

  getTransport(): TransportSetting {
    return this.settings.transport ?? "auto";
  }

  getCompactionEnabled(): boolean {
    return this.settings.compaction?.enabled ?? true;
  }

  setCompactionEnabled(enabled: boolean): void {
    this.setGlobalNestedSetting("compaction", "enabled", enabled);
  }

  getCompactionReserveTokens(): number {
    return this.settings.compaction?.reserveTokens ?? 16384;
  }

  getCompactionKeepRecentTokens(): number {
    return this.settings.compaction?.keepRecentTokens ?? 20000;
  }

  getCompactionSettings(): { enabled: boolean; reserveTokens: number; keepRecentTokens: number } {
    return {
      enabled: this.getCompactionEnabled(),
      reserveTokens: this.getCompactionReserveTokens(),
      keepRecentTokens: this.getCompactionKeepRecentTokens(),
    };
  }

  getRetryEnabled(): boolean {
    return this.settings.retry?.enabled ?? true;
  }

  setRetryEnabled(enabled: boolean): void {
    this.setGlobalNestedSetting("retry", "enabled", enabled);
  }

  getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number } {
    return {
      enabled: this.getRetryEnabled(),
      maxRetries: this.settings.retry?.maxRetries ?? 3,
      baseDelayMs: this.settings.retry?.baseDelayMs ?? 2000,
    };
  }

  getProviderRetrySettings(): { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs: number } {
    return {
      timeoutMs: this.settings.retry?.provider?.timeoutMs,
      maxRetries: this.settings.retry?.provider?.maxRetries,
      maxRetryDelayMs: this.settings.retry?.provider?.maxRetryDelayMs ?? 60000,
    };
  }

  getEnableInstallTelemetry(): boolean {
    return this.settings.enableInstallTelemetry ?? true;
  }

  getThinkingBudgets(): ThinkingBudgetsSettings | undefined {
    return this.settings.thinkingBudgets;
  }

  getBlockImages(): boolean {
    return this.settings.images?.blockImages ?? false;
  }
}
