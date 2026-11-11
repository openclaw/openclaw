import type {
  CodexAppServerConnectionClass,
  CodexDynamicToolsLoading,
  CodexPluginConfig,
} from "./config-contracts.js";

/** Replacement policy for tools owned by Codex app-server. */
const CODEX_NATIVE_TOOLS = new Map<string, "workspace" | "shell" | "always">([
  ["read", "workspace"],
  ["write", "workspace"],
  ["edit", "workspace"],
  ["apply_patch", "workspace"],
  ["exec", "shell"],
  ["process", "shell"],
  ["update_plan", "always"],
  ["tool_call", "always"],
  ["dispatch_action", "always"],
  ["tool_describe", "always"],
  ["tool_search", "always"],
]);

const DYNAMIC_TOOL_NAME_ALIASES: Record<string, string> = {
  bash: "exec",
  "apply-patch": "apply_patch",
};

type CodexDynamicToolProfileEnv = {
  OPENCLAW_BUILD_PRIVATE_QA?: string;
  OPENCLAW_QA_FORCE_RUNTIME?: string;
};

export function normalizeCodexDynamicToolName(name: string): string {
  const normalized = name.trim().toLowerCase();
  return DYNAMIC_TOOL_NAME_ALIASES[normalized] ?? normalized;
}

/** True only for the host-scoped OpenClaw run's exact tool contract. */
export function isSystemAgentOnlyCodexDynamicToolAllowlist(
  toolsAllow: readonly string[] | undefined,
): boolean {
  return (
    toolsAllow?.length === 1 && normalizeCodexDynamicToolName(toolsAllow[0] ?? "") === "openclaw"
  );
}

/** True when a private source reply may use the message delivery tool only. */
export function isMessageOnlyCodexSourceReply(params: {
  toolsAllow?: readonly string[];
  sourceReplyDeliveryMode?: string;
}): boolean {
  return (
    params.sourceReplyDeliveryMode === "message_tool_only" &&
    params.toolsAllow?.length === 1 &&
    normalizeCodexDynamicToolName(params.toolsAllow[0] ?? "") === "message"
  );
}

export function isForcedPrivateQaCodexRuntime(
  env: CodexDynamicToolProfileEnv = process.env,
): boolean {
  return (
    env.OPENCLAW_BUILD_PRIVATE_QA === "1" &&
    env.OPENCLAW_QA_FORCE_RUNTIME?.trim().toLowerCase() === "codex"
  );
}

export function resolveCodexDynamicToolsLoading(
  config: Pick<CodexPluginConfig, "codexDynamicToolsLoading">,
  env: CodexDynamicToolProfileEnv = process.env,
): CodexDynamicToolsLoading {
  return isForcedPrivateQaCodexRuntime(env)
    ? "direct"
    : (config.codexDynamicToolsLoading ?? "searchable");
}

/** Returns true for models whose tool-search path is unsupported or inefficient. */
export function shouldDisableCodexToolSearchForModel(modelId: string | undefined): boolean {
  return modelId?.trim().toLowerCase().split("/").at(-1) === "gpt-5.4-nano";
}

/** Resolves dynamic-tool loading for the app-server connection that will execute the turn. */
export function resolveCodexDynamicToolsLoadingForRuntime(
  config: Pick<CodexPluginConfig, "codexDynamicToolsLoading">,
  modelId: string | undefined,
  options: {
    connectionClass?: CodexAppServerConnectionClass;
    nativeToolSurfaceEnabled?: boolean;
  } = {},
): CodexDynamicToolsLoading {
  // Without native JavaScript discovery, model metadata may also omit tool_search.
  // Publish callable schemas rather than leaving allowed tools unreachable.
  const loading = resolveCodexDynamicToolsLoading(config);
  return loading === "searchable" &&
    (options.nativeToolSurfaceEnabled === false ||
      shouldDisableCodexToolSearchForModel(modelId) ||
      options.connectionClass === "remote")
    ? "direct"
    : loading;
}

/** Filters OpenClaw tools that Codex owns natively or config explicitly excludes. */
export function filterCodexDynamicTools<T extends { name: string }>(
  tools: T[],
  config: Pick<CodexPluginConfig, "codexDynamicToolsExclude">,
  options: {
    disabledNativeSurface?: { preserveShell: boolean };
  } = {},
): T[] {
  const { disabledNativeSurface } = options;
  const excludes = new Set<string>();
  const privateQa = isForcedPrivateQaCodexRuntime();
  for (const [name, replacement] of CODEX_NATIVE_TOOLS) {
    if (privateQa) {
      // Native apply_patch must never collide with a second QA handler.
      if (name === "apply_patch") {
        excludes.add(name);
      }
      continue;
    }
    if (
      (replacement === "workspace" && disabledNativeSurface) ||
      (replacement === "shell" && disabledNativeSurface?.preserveShell)
    ) {
      continue;
    }
    excludes.add(name);
  }
  for (const name of config.codexDynamicToolsExclude ?? []) {
    const trimmed = normalizeCodexDynamicToolName(name);
    if (trimmed) {
      excludes.add(trimmed);
    }
  }
  return excludes.size === 0
    ? tools
    : tools.filter((tool) => !excludes.has(normalizeCodexDynamicToolName(tool.name)));
}
