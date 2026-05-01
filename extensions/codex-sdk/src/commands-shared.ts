import type { OpenClawPluginApi } from "openclaw/plugin-sdk/acpx";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { getActiveCodexController } from "./active.js";
import {
  CODEX_SDK_BACKEND_ID,
  CODEX_SDK_INSTALL_COMMAND,
  type ResolvedCodexSdkPluginConfig,
  resolveCodexSdkPluginConfig,
} from "./config.js";
import type { CodexNativeController } from "./controller.js";
import { createCodexNativeController } from "./controller.js";
import type { CodexProposalRecord } from "./state.js";

export type JsonOption = { json?: boolean };
export type LimitOption = { limit?: string | number };

export function getCodexController(
  api: OpenClawPluginApi,
  workspaceDir?: string,
): CodexNativeController {
  return getCodexControllerContext(api, workspaceDir);
}

export function getCodexControllerContext(
  api: OpenClawPluginApi,
  workspaceDir?: string,
): CodexNativeController {
  const active = getActiveCodexController();
  if (active) {
    return active;
  }
  const config = resolveCodexSdkPluginConfig({
    rawConfig: api.pluginConfig,
    workspaceDir,
  });
  return createCodexNativeController({
    config,
    stateDir: api.runtime.state.resolveStateDir(),
    logger: api.logger,
  });
}

export function buildCodexEnabledConfig(
  current: OpenClawConfig,
  pluginConfig: ResolvedCodexSdkPluginConfig,
): OpenClawConfig {
  const defaultAgent = pluginConfig.allowedAgents.includes("codex")
    ? "codex"
    : pluginConfig.allowedAgents[0];
  const codexAgent = {
    id: "codex",
    name: "Codex",
    default: !(current.agents?.list ?? []).some((agent) => agent.default === true),
    identity: {
      name: "Codex",
      avatar: "C",
    },
    runtime: {
      type: "acp" as const,
      acp: {
        agent: defaultAgent,
        backend: CODEX_SDK_BACKEND_ID,
        mode: "persistent" as const,
        ...(pluginConfig.cwd ? { cwd: pluginConfig.cwd } : {}),
      },
    },
  };
  const existingAgents = current.agents?.list ?? [];
  const hasCodexAgent = existingAgents.some((agent) => agent.id === "codex");
  return {
    ...current,
    acp: {
      ...current.acp,
      enabled: true,
      dispatch: {
        ...current.acp?.dispatch,
        enabled: true,
      },
      backend: CODEX_SDK_BACKEND_ID,
      defaultAgent,
      allowedAgents: pluginConfig.allowedAgents,
      runtime: {
        ...current.acp?.runtime,
        installCommand: CODEX_SDK_INSTALL_COMMAND,
      },
    },
    agents: {
      ...current.agents,
      list: hasCodexAgent
        ? existingAgents.map((agent) =>
            agent.id === "codex"
              ? {
                  ...codexAgent,
                  ...agent,
                  identity: {
                    ...codexAgent.identity,
                    ...agent.identity,
                  },
                  runtime: agent.runtime ?? codexAgent.runtime,
                }
              : agent,
          )
        : [...existingAgents, codexAgent],
    },
    plugins: {
      ...current.plugins,
      entries: {
        ...current.plugins?.entries,
        "codex-sdk": {
          ...current.plugins?.entries?.["codex-sdk"],
          enabled: true,
        },
      },
    },
  };
}

export function parseLimit(value: unknown, fallback: number, max = 200): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : fallback;
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

export function parseExportFormat(value: unknown): "json" | "markdown" {
  return typeof value === "string" && value.trim().toLowerCase() === "json" ? "json" : "markdown";
}

export function splitArgs(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

export function isProposalStatus(value: string): value is CodexProposalRecord["status"] {
  return value === "new" || value === "accepted" || value === "dismissed";
}
