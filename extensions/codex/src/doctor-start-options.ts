import { resolveDefaultModelForAgent } from "openclaw/plugin-sdk/agent-runtime";
import { listAgentIds, resolveAgentDir } from "openclaw/plugin-sdk/agent-scope-runtime";
import { resolveEffectiveAgentRuntime } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/health";
import { readCodexPluginConfig } from "./app-server/config-parsing.js";
import {
  resolveCodexAppServerRuntimeOptions,
  resolveCodexAppServerStartOptionsForAgent,
  type CodexAppServerStartOptions,
} from "./app-server/config.js";
import {
  isManagedCodexDesktopCommand,
  resolveManagedCodexAppServerStartOptions,
} from "./app-server/managed-binary.js";

export type CodexDoctorStartOptionsDependencies = {
  resolveAgentStartOptions?: typeof resolveCodexAppServerStartOptionsForAgent;
  resolveStartOptions?: typeof resolveManagedCodexAppServerStartOptions;
  isDesktopCommand?: typeof isManagedCodexDesktopCommand;
};

/** Selects the same local agent or passive-catalog command for both Doctor probes. */
export async function resolveCodexDoctorStartOptions(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  pluginRoot: string;
  managedOnly?: boolean;
  deps?: CodexDoctorStartOptionsDependencies;
}): Promise<
  { status: "selected"; start: CodexAppServerStartOptions } | { status: "skipped"; reason: string }
> {
  const pluginConfig = params.cfg.plugins?.entries?.codex?.config;
  const start = resolveCodexAppServerRuntimeOptions({ pluginConfig, env: params.env }).start;
  if (start.transport !== "stdio") {
    return { status: "skipped", reason: "Codex uses a remote app-server transport." };
  }
  if (params.managedOnly && start.commandSource !== "managed") {
    return { status: "skipped", reason: "Codex uses a custom app-server command." };
  }
  const resolveAgentStartOptions =
    params.deps?.resolveAgentStartOptions ?? resolveCodexAppServerStartOptionsForAgent;
  const resolveStartOptions =
    params.deps?.resolveStartOptions ?? resolveManagedCodexAppServerStartOptions;
  const isDesktopCommand = params.deps?.isDesktopCommand ?? isManagedCodexDesktopCommand;
  const candidates: CodexAppServerStartOptions[] = [];
  for (const agentId of listAgentIds(params.cfg)) {
    const model = resolveDefaultModelForAgent({ cfg: params.cfg, agentId });
    if (
      resolveEffectiveAgentRuntime({
        cfg: params.cfg,
        provider: model.provider,
        modelId: model.model,
        agentId,
      }) !== "codex"
    ) {
      continue;
    }
    candidates.push(
      resolveAgentStartOptions({
        startOptions: start,
        agentDir: resolveAgentDir(params.cfg, agentId, params.env),
        env: params.env,
      }),
    );
  }
  if (
    params.cfg.plugins?.entries?.codex?.enabled === true &&
    readCodexPluginConfig(pluginConfig).sessionCatalog?.enabled !== false
  ) {
    // Passive catalogs use the package even when no agent routes turns through Codex.
    candidates.push({ ...start, managedCommandOrder: "package-only" });
  }
  for (const candidate of candidates) {
    const resolved = await resolveStartOptions(candidate, { pluginRoot: params.pluginRoot });
    if (!isDesktopCommand(resolved.command)) {
      return { status: "selected", start: resolved };
    }
  }
  return {
    status: "skipped",
    reason: candidates.length
      ? "Only desktop-owned Codex commands are configured."
      : "No local Codex runtime is configured.",
  };
}
