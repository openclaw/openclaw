import { createHash } from "node:crypto";
import path from "node:path";
import { resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-scope-runtime";
import { resolvePlannedMigrationTargets } from "openclaw/plugin-sdk/migration-runtime";
import type { MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import type { GrokSourceInventory } from "./source/types.js";

export type GrokAgentTarget = {
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  isPrimary?: boolean;
};
export type GrokAgentTargets = ReadonlyMap<string, GrokAgentTarget>;

/** Source identity, rather than mutable display names, makes repeated imports stable. */
export function grokImportId(sourceId: string): string {
  return `grok-${createHash("sha256").update(sourceId).digest("hex").slice(0, 16)}`;
}

export function resolveGrokAgentTargets(
  inventory: GrokSourceInventory,
  ctx: MigrationProviderContext,
): GrokAgentTargets {
  const primary = inventory.mainAgentId ? resolvePlannedMigrationTargets(ctx) : undefined;
  const targets = new Map<string, GrokAgentTarget>();
  for (const agent of inventory.agents.value) {
    if (agent.id === inventory.mainAgentId && primary) {
      targets.set(agent.id, {
        agentId: ctx.targetAgentId ?? resolveDefaultAgentId(ctx.config),
        workspaceDir: primary.workspaceDir,
        agentDir: primary.agentDir,
        isPrimary: true,
      });
    } else {
      const agentId = grokImportId(agent.id);
      targets.set(agent.id, {
        agentId,
        workspaceDir: path.join(ctx.stateDir, `workspace-${agentId}`),
        agentDir: path.join(ctx.stateDir, "agents", agentId, "agent"),
      });
    }
  }
  return targets;
}
