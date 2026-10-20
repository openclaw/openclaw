/**
 * Session settings manager.
 *
 * Loads and persists user/session defaults for models, transports, retry policy, UI, packages, and telemetry.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createInvalidConfigError, isInvalidConfigError } from "../../config/io.invalid-config.js";
import { mergeDeep } from "../../infra/deep-merge.js";
import { getAgentDir } from "../config.js";
import {
  FileSettingsStorage,
  InMemorySettingsStorage,
  readSettingsScope,
  SETTINGS_SCOPES,
  type Settings,
  type SettingsError,
  type SettingsScope,
  type SettingsStorage,
  type ThinkingBudgetsSettings,
  type TransportSetting,
} from "./settings-storage.js";

export type {
  Settings,
  SettingsError,
  SettingsScope,
  SettingsStorage,
  ThinkingBudgetsSettings,
  TransportSetting,
} from "./settings-storage.js";

/** Deep merge settings: project/overrides take precedence, nested objects merge recursively */
function deepMergeSettings(base: Settings, overrides: Settings): Settings {
  return mergeDeep(base, overrides) as Settings;
}

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

interface SettingsScopeState {
  settings: Settings;
  loadError: Error | null;
}

export class SettingsManager {
  private settings: Settings = {};
  // Non-persisted overrides layered above global/project settings for this manager.
  private runtimeOverrides: Settings = {};
  private writeQueue: Promise<void> = Promise.resolve();
  private modified = new Map<keyof Settings, Set<string> | null>();
  private errors: SettingsError[];

  private constructor(
    private storage: SettingsStorage,
    private scopes: Record<SettingsScope, SettingsScopeState>,
  ) {
    this.errors = SETTINGS_SCOPES.flatMap((scope) => {
      const error = scopes[scope].loadError;
      return error ? [{ scope, error }] : [];
    });
    this.recomputeSettings();
  }

  static create(cwd: string, agentDir: string = getAgentDir()): SettingsManager {
    return SettingsManager.fromStorage(new FileSettingsStorage(cwd, agentDir));
  }

  static fromStorage(storage: SettingsStorage): SettingsManager {
    return new SettingsManager(storage, {
      global: SettingsManager.loadScope(storage, "global"),
      project: SettingsManager.loadScope(storage, "project"),
    });
  }

  static inMemory(settings: Partial<Settings> = {}): SettingsManager {
    const storage = new InMemorySettingsStorage();
    const initialSettings = requireSupportedSettings(settings, "global");
    storage.withLock("global", () => JSON.stringify(initialSettings, null, 2));
    return SettingsManager.fromStorage(storage);
  }

  private static loadScope(storage: SettingsStorage, scope: SettingsScope): SettingsScopeState {
    const state: SettingsScopeState = readSettingsScope(storage, scope);
    if (isInvalidConfigError(state.loadError)) {
      throw state.loadError;
    }
    try {
      state.settings = requireSupportedSettings(state.settings, scope);
    } catch (error) {
      if (isInvalidConfigError(error)) {
        throw error;
      }
      state.loadError = error as Error;
    }
    return state;
  }

  getGlobalSettings(): Settings {
    return structuredClone(this.scopes.global.settings);
  }

  getProjectSettings(): Settings {
    return structuredClone(this.scopes.project.settings);
  }

  private recomputeSettings(): void {
    this.settings = deepMergeSettings(
      deepMergeSettings(this.scopes.global.settings, this.scopes.project.settings),
      this.runtimeOverrides,
    );
  }

  async reload(): Promise<void> {
    await this.writeQueue;
    for (const scope of SETTINGS_SCOPES) {
      const state = this.scopes[scope];
      const loaded = SettingsManager.loadScope(this.storage, scope);
      if (loaded.loadError) {
        state.loadError = loaded.loadError;
        this.recordError(scope, loaded.loadError);
      } else {
        state.settings = loaded.settings;
        state.loadError = null;
      }
      if (scope === "global") {
        this.modified.clear();
      }
    }

    this.recomputeSettings();
  }

  /** Apply non-persisted overrides on top of global/project settings. */
  applyOverrides(overrides: Partial<Settings>): void {
    this.runtimeOverrides = deepMergeSettings(this.runtimeOverrides, overrides);
    this.recomputeSettings();
  }

  private recordError(scope: SettingsScope, error: unknown): void {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    this.errors.push({ scope, error: normalizedError });
  }

  private persistGlobalSettings(
    snapshotSettings: Settings,
    modified: Map<keyof Settings, Set<string> | null>,
  ): void {
    this.storage.withLock("global", (current) => {
      const currentFileSettings = current
        ? requireSupportedSettings(JSON.parse(current), "global")
        : {};
      const mergedSettings: Settings = { ...currentFileSettings };
      for (const [field, nestedModified] of modified) {
        const value = snapshotSettings[field];
        if (nestedModified && typeof value === "object" && value !== null) {
          const baseNested = (currentFileSettings[field] as Record<string, unknown>) ?? {};
          const inMemoryNested = value as Record<string, unknown>;
          const mergedNested = { ...baseNested };
          for (const nestedKey of nestedModified) {
            mergedNested[nestedKey] = inMemoryNested[nestedKey];
          }
          (mergedSettings as Record<string, unknown>)[field] = mergedNested;
        } else {
          (mergedSettings as Record<string, unknown>)[field] = value;
        }
      }

      return JSON.stringify(mergedSettings, null, 2);
    });
  }

  private save(): void {
    this.recomputeSettings();
    const state = this.scopes.global;
    if (state.loadError) {
      return;
    }
    const snapshotSettings = structuredClone(state.settings);
    const modified = new Map(
      [...this.modified].map(([field, nested]) => [field, nested && new Set(nested)]),
    );
    this.writeQueue = this.writeQueue
      .then(() => {
        this.persistGlobalSettings(snapshotSettings, modified);
        this.modified.clear();
      })
      .catch((error: unknown) => {
        this.recordError("global", error);
      });
  }

  private setGlobalSettings(values: Settings, nestedField?: string): void {
    Object.assign(this.scopes.global.settings, values);
    for (const field of Object.keys(values) as (keyof Settings)[]) {
      const existing = this.modified.get(field);
      if (!nestedField || existing === null) {
        this.modified.set(field, null);
      } else {
        const nestedFields = existing ?? new Set<string>();
        nestedFields.add(nestedField);
        this.modified.set(field, nestedFields);
      }
    }
    this.save();
  }

  private setGlobalNestedSetting(
    field: "compaction" | "retry",
    nestedField: string,
    value: unknown,
  ): void {
    const current = this.scopes.global.settings[field];
    const nested = isRecord(current) ? { ...current } : {};
    nested[nestedField] = value;
    this.setGlobalSettings({ [field]: nested }, nestedField);
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  drainErrors(): SettingsError[] {
    const drained = this.errors;
    this.errors = [];
    return drained;
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
