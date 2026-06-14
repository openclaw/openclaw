// Feishu plugin module implements dynamic agent behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig, PluginRuntime } from "../runtime-api.js";
import type { DynamicAgentCreationConfig } from "./types.js";

type MaybeCreateDynamicAgentResult = {
  created: boolean;
  updatedCfg: OpenClawConfig;
  agentId?: string;
};

type DynamicAgentMutationResult = {
  created: boolean;
  agentId?: string;
};

function hasDirectBinding(cfg: OpenClawConfig, senderOpenId: string): boolean {
  return (cfg.bindings ?? []).some(
    (binding) =>
      binding.match?.channel === "feishu" &&
      binding.match?.peer?.kind === "direct" &&
      binding.match?.peer?.id === senderOpenId,
  );
}

/**
 * Check if a dynamic agent should be created for a DM user and create it if needed.
 * This creates a unique agent instance with its own workspace for each DM user.
 */
export async function maybeCreateDynamicAgent(params: {
  cfg: OpenClawConfig;
  runtime: PluginRuntime;
  senderOpenId: string;
  dynamicCfg: DynamicAgentCreationConfig;
  configWritesAllowed: boolean;
  log: (msg: string) => void;
}): Promise<MaybeCreateDynamicAgentResult> {
  const { cfg, runtime, senderOpenId, dynamicCfg, configWritesAllowed, log } = params;

  if (!configWritesAllowed) {
    log(`feishu: config writes disabled, not creating agent for ${senderOpenId}`);
    return { created: false, updatedCfg: cfg };
  }

  if (hasDirectBinding(cfg, senderOpenId)) {
    return { created: false, updatedCfg: cfg };
  }

  const currentCfg = runtime.config.current() as OpenClawConfig;
  if (hasDirectBinding(currentCfg, senderOpenId)) {
    return { created: false, updatedCfg: currentCfg };
  }

  if (dynamicCfg.maxAgents !== undefined) {
    const feishuAgentCount = (currentCfg.agents?.list ?? []).filter((a) =>
      a.id.startsWith("feishu-"),
    ).length;
    if (feishuAgentCount >= dynamicCfg.maxAgents) {
      log(
        `feishu: maxAgents limit (${dynamicCfg.maxAgents}) reached, not creating agent for ${senderOpenId}`,
      );
      return { created: false, updatedCfg: currentCfg };
    }
  }

  const agentId = `feishu-${senderOpenId}`;
  const workspaceTemplate = dynamicCfg.workspaceTemplate ?? "~/.openclaw/workspace-{agentId}";
  const agentDirTemplate = dynamicCfg.agentDirTemplate ?? "~/.openclaw/agents/{agentId}/agent";
  const workspace = resolveUserPath(
    workspaceTemplate.replace("{userId}", senderOpenId).replace("{agentId}", agentId),
  );
  const agentDir = resolveUserPath(
    agentDirTemplate.replace("{userId}", senderOpenId).replace("{agentId}", agentId),
  );

  // The config mutation lock owns the final duplicate/limit checks. This keeps
  // simultaneous DM creations from replacing each other's agents or bindings.
  const committed = await runtime.config.mutateConfigFile<DynamicAgentMutationResult>({
    base: "runtime",
    afterWrite: { mode: "auto" },
    mutate: async (draft) => {
      if (hasDirectBinding(draft, senderOpenId)) {
        return { created: false };
      }

      if (dynamicCfg.maxAgents !== undefined) {
        const feishuAgentCount = (draft.agents?.list ?? []).filter((agent) =>
          agent.id.startsWith("feishu-"),
        ).length;
        if (feishuAgentCount >= dynamicCfg.maxAgents) {
          log(
            `feishu: maxAgents limit (${dynamicCfg.maxAgents}) reached, not creating agent for ${senderOpenId}`,
          );
          return { created: false };
        }
      }

      if (!(draft.agents?.list ?? []).some((agent) => agent.id === agentId)) {
        log(`feishu: creating dynamic agent "${agentId}" for user ${senderOpenId}`);
        log(`  workspace: ${workspace}`);
        log(`  agentDir: ${agentDir}`);
        await fs.promises.mkdir(workspace, { recursive: true });
        await fs.promises.mkdir(agentDir, { recursive: true });
        draft.agents = {
          ...draft.agents,
          list: [...(draft.agents?.list ?? []), { id: agentId, workspace, agentDir }],
        };
      } else {
        log(`feishu: agent "${agentId}" exists, adding missing binding for ${senderOpenId}`);
      }

      draft.bindings = [
        ...(draft.bindings ?? []),
        {
          agentId,
          match: {
            channel: "feishu",
            peer: { kind: "direct", id: senderOpenId },
          },
        },
      ];
      return { created: true, agentId };
    },
  });

  return {
    created: committed.result?.created ?? false,
    updatedCfg: committed.nextConfig,
    agentId: committed.result?.agentId,
  };
}

/**
 * Resolve a path that may start with ~ to the user's home directory.
 */
function resolveUserPath(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}
