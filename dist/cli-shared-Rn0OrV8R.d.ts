import { On as CliBackendConfig } from "./types.openclaw-BLF4DJTX.js";
import { br as CliBackendResolveExecutionArgsContext, hr as CliBackendNormalizeConfigContext } from "./types-Vx7Jq4_-2.js";
//#region extensions/anthropic/cli-shared.d.ts
declare const CLAUDE_CLI_CLEAR_ENV: readonly ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_OLD", "ANTHROPIC_API_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_UNIX_SOCKET", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_SCOPES", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "CLAUDE_CODE_PLUGIN_CACHE_DIR", "CLAUDE_CODE_PLUGIN_SEED_DIR", "CLAUDE_CODE_REMOTE", "CLAUDE_CODE_USE_COWORK_PLUGINS", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_VERTEX", "OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_HEADERS", "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "OTEL_EXPORTER_OTLP_LOGS_HEADERS", "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL", "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "OTEL_EXPORTER_OTLP_METRICS_HEADERS", "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL", "OTEL_EXPORTER_OTLP_PROTOCOL", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_HEADERS", "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL", "OTEL_LOGS_EXPORTER", "OTEL_METRICS_EXPORTER", "OTEL_SDK_DISABLED", "OTEL_TRACES_EXPORTER"];
type ClaudeCliEffort = "low" | "medium" | "high" | "xhigh" | "max";
declare function isClaudeCliProvider(providerId: string): boolean;
declare function resolveClaudePermissionMode(context?: CliBackendNormalizeConfigContext): {
  mode?: string;
  overrideExisting: boolean;
};
declare function normalizeClaudePermissionArgs(args?: string[], options?: {
  mode?: string;
  overrideExisting?: boolean;
}): string[] | undefined;
declare function normalizeClaudeSettingSourcesArgs(args?: string[]): string[] | undefined;
declare function mapClaudeCliThinkingLevelToEffort(thinkingLevel?: string | null): ClaudeCliEffort | undefined;
declare function resolveClaudeCliExecutionArgs(context: CliBackendResolveExecutionArgsContext): string[];
declare function normalizeClaudeBackendConfig(config: CliBackendConfig, context?: CliBackendNormalizeConfigContext): CliBackendConfig;
//#endregion
export { normalizeClaudePermissionArgs as a, resolveClaudePermissionMode as c, normalizeClaudeBackendConfig as i, isClaudeCliProvider as n, normalizeClaudeSettingSourcesArgs as o, mapClaudeCliThinkingLevelToEffort as r, resolveClaudeCliExecutionArgs as s, CLAUDE_CLI_CLEAR_ENV as t };