import fs from "node:fs";
import os from "node:os";
import path from "node:path";
async function maybeCreateDynamicAgent(params) {
  const { cfg, runtime, senderOpenId, dynamicCfg, log } = params;
  const existingBindings = cfg.bindings ?? [];
  const hasBinding = existingBindings.some(
    (b) => b.match?.channel === "feishu" && b.match?.peer?.kind === "direct" && b.match?.peer?.id === senderOpenId
  );
  if (hasBinding) {
    return { created: false, updatedCfg: cfg };
  }
  if (dynamicCfg.maxAgents !== void 0) {
    const feishuAgentCount = (cfg.agents?.list ?? []).filter(
      (a) => a.id.startsWith("feishu-")
    ).length;
    if (feishuAgentCount >= dynamicCfg.maxAgents) {
      log(
        `feishu: maxAgents limit (${dynamicCfg.maxAgents}) reached, not creating agent for ${senderOpenId}`
      );
      return { created: false, updatedCfg: cfg };
    }
  }
  const agentId = `feishu-${senderOpenId}`;
  const existingAgent = (cfg.agents?.list ?? []).find((a) => a.id === agentId);
  if (existingAgent) {
    log(`feishu: agent "${agentId}" exists, adding missing binding for ${senderOpenId}`);
    const updatedCfg2 = {
      ...cfg,
      bindings: [
        ...existingBindings,
        {
          agentId,
          match: {
            channel: "feishu",
            peer: { kind: "direct", id: senderOpenId }
          }
        }
      ]
    };
    await runtime.config.writeConfigFile(updatedCfg2);
    return { created: true, updatedCfg: updatedCfg2, agentId };
  }
  const workspaceTemplate = dynamicCfg.workspaceTemplate ?? "~/.openclaw/workspace-{agentId}";
  const agentDirTemplate = dynamicCfg.agentDirTemplate ?? "~/.openclaw/agents/{agentId}/agent";
  const workspace = resolveUserPath(
    workspaceTemplate.replace("{userId}", senderOpenId).replace("{agentId}", agentId)
  );
  const agentDir = resolveUserPath(
    agentDirTemplate.replace("{userId}", senderOpenId).replace("{agentId}", agentId)
  );
  log(`feishu: creating dynamic agent "${agentId}" for user ${senderOpenId}`);
  log(`  workspace: ${workspace}`);
  log(`  agentDir: ${agentDir}`);
  await fs.promises.mkdir(workspace, { recursive: true });
  await fs.promises.mkdir(agentDir, { recursive: true });
  const updatedCfg = {
    ...cfg,
    agents: {
      ...cfg.agents,
      list: [...cfg.agents?.list ?? [], { id: agentId, workspace, agentDir }]
    },
    bindings: [
      ...existingBindings,
      {
        agentId,
        match: {
          channel: "feishu",
          peer: { kind: "direct", id: senderOpenId }
        }
      }
    ]
  };
  await runtime.config.writeConfigFile(updatedCfg);
  return { created: true, updatedCfg, agentId };
}
function resolveUserPath(p) {
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}
export {
  maybeCreateDynamicAgent
};
