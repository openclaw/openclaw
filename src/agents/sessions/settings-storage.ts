import { readFileSync } from "node:fs";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { hasErrnoCode } from "../../infra/errno.js";
import type { ThinkingBudgets, Transport } from "../../llm/types.js";

interface CompactionSettings {
  enabled?: boolean; // default: true
  reserveTokens?: number; // default: 16384
  keepRecentTokens?: number; // default: 20000
}

interface BranchSummarySettings {
  reserveTokens?: number; // default: 16384 (tokens reserved for prompt + LLM response)
  skipPrompt?: boolean; // default: false - when true, skips "Summarize branch?" prompt and defaults to no summary
}

interface ProviderRetrySettings {
  timeoutMs?: number; // SDK/provider request timeout in milliseconds
  maxRetries?: number; // transient provider retry attempts
  maxRetryDelayMs?: number; // default: 60000 (max server-requested delay before failing)
}

interface RetrySettings {
  enabled?: boolean; // default: true
  maxRetries?: number; // default: 3
  baseDelayMs?: number; // default: 2000 (exponential backoff: 2s, 4s, 8s)
  provider?: ProviderRetrySettings;
}

interface TerminalSettings {
  showImages?: boolean; // default: true (only relevant if terminal supports images)
  imageWidthCells?: number; // default: 60 (preferred inline image width in terminal cells)
  clearOnShrink?: boolean; // default: false (clear empty rows when content shrinks)
  showTerminalProgress?: boolean; // default: false (OSC 9;4 terminal progress indicators)
}

interface ImageSettings {
  autoResize?: boolean; // default: true (resize images to 2000x2000 max for better model compatibility)
  blockImages?: boolean; // default: false - when true, prevents all images from being sent to LLM providers
}

export interface ThinkingBudgetsSettings extends ThinkingBudgets {}

interface MarkdownSettings {
  codeBlockIndent?: string; // default: "  "
}

interface WarningSettings {
  anthropicExtraUsage?: boolean; // default: true
}

export type TransportSetting = Transport;

/**
 * Package source for npm/git packages.
 * - String form: load all resources from the package
 * - Object form: filter which resources to load
 */
type PackageSource =
  | string
  | {
      source: string;
      extensions?: string[];
      skills?: string[];
      prompts?: string[];
      themes?: string[];
    };

export interface Settings {
  lastChangelogVersion?: string;
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  transport?: TransportSetting; // default: "auto"
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  theme?: string;
  compaction?: CompactionSettings;
  branchSummary?: BranchSummarySettings;
  retry?: RetrySettings;
  hideThinkingBlock?: boolean;
  shellPath?: string; // Custom shell path (e.g., for Cygwin users on Windows)
  quietStartup?: boolean;
  shellCommandPrefix?: string; // Prefix prepended to every bash command (e.g., "shopt -s expand_aliases" for alias support)
  npmCommand?: string[]; // Command used for npm package lookup/install operations, argv-style (e.g., ["mise", "exec", "node@20", "--", "npm"])
  collapseChangelog?: boolean; // Show condensed changelog after update (use /changelog for full)
  enableInstallTelemetry?: boolean; // default: true - anonymous version/update ping after changelog-detected updates
  packages?: PackageSource[]; // Array of npm/git package sources (string or object with filtering)
  extensions?: string[]; // Array of local extension file paths or directories
  skills?: string[]; // Array of local skill file paths or directories
  prompts?: string[]; // Array of local prompt template paths or directories
  themes?: string[]; // Array of local theme file paths or directories
  enableSkillCommands?: boolean; // default: true - register skills as /skill:name commands
  terminal?: TerminalSettings;
  images?: ImageSettings;
  enabledModels?: string[]; // Model patterns for cycling (same format as --models CLI flag)
  doubleEscapeAction?: "fork" | "tree" | "none"; // Action for double-escape with empty editor (default: "tree")
  treeFilterMode?: "default" | "no-tools" | "user-only" | "labeled-only" | "all"; // Default filter when opening /tree
  thinkingBudgets?: ThinkingBudgetsSettings; // Custom token budgets for thinking levels
  editorPaddingX?: number; // Horizontal padding for input editor (default: 0)
  autocompleteMaxVisible?: number; // Max visible items in autocomplete dropdown (default: 5)
  showHardwareCursor?: boolean; // Show terminal cursor while still positioning it for IME
  markdown?: MarkdownSettings;
  warnings?: WarningSettings;
  sessionDir?: string; // Custom session storage directory (same format as --session-dir CLI flag)
  httpIdleTimeoutMs?: number; // HTTP header/body idle timeout in milliseconds; 0 disables it
}

export type SettingsScope = "global" | "project";

/** Read one settings file without applying runtime-specific validation or defaults. */
export function readSettingsScope(path: string): { settings: Settings; loadError: Error | null } {
  try {
    const content = readFileSync(path, "utf-8");
    const settings: unknown = content ? JSON.parse(content) : {};
    if (!isRecord(settings)) {
      throw new TypeError("Session settings must be an object");
    }
    return { settings, loadError: null };
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return { settings: {}, loadError: null };
    }
    return {
      settings: {},
      loadError: toErrorObject(error, "Session settings could not be loaded"),
    };
  }
}
