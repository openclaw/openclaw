import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  resolveMemoryLightDreamingConfig,
  resolveMemoryRemDreamingConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { SessionAdmissionPolicy } from "./session-ingestion.js";
import type { WorkspaceFileMode } from "./workspace-file-mode.js";

export type NarrativePhaseData = {
  phase: "light" | "deep" | "rem";
  /** Short memory snippets the phase processed. */
  snippets: string[];
  /** Concept tags / themes that surfaced (REM and light). */
  themes?: string[];
  /** Snippets that were promoted to durable memory (deep). */
  promotions?: string[];
  currentDate?: string;
  recentDiaryEntries?: string[];
  /** Tracked inputs that must still exist when generated text is published. */
  sourceEntryKeys?: readonly string[];
};

export type PreparedDreamNarrative = {
  data: NarrativePhaseData;
  model?: string;
  timezone?: string;
};

export type LightDreamingConfig = ReturnType<typeof resolveMemoryLightDreamingConfig>;
export type RemDreamingConfig = ReturnType<typeof resolveMemoryRemDreamingConfig>;
export type DreamingSweepParams = {
  agentId?: string;
  workspaceDir: string;
  workspaceFileMode?: WorkspaceFileMode;
  pluginConfig?: Record<string, unknown>;
  cfg?: OpenClawConfig;
  logger: Pick<OpenClawPluginApi["logger"], "info" | "warn" | "error">;
  nowMs?: number;
};
export type DreamingPhaseRunParams<TConfig extends LightDreamingConfig | RemDreamingConfig> =
  DreamingSweepParams & {
    config: TConfig;
    nowMs: number;
    admissionPolicy?: SessionAdmissionPolicy;
  };
export type DreamingPhasePreparation = {
  bodyLines: string[];
  keys: string[];
  consideredKeys?: string[];
  logMessage: string;
  data?: NarrativePhaseData;
};
