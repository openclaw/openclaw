import fs from "node:fs/promises";
import path from "node:path";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import {
  createMigrationItem,
  createMigrationManualItem,
  summarizeMigrationItems,
} from "openclaw/plugin-sdk/migration";
import type {
  MigrationItem,
  MigrationPlan,
  MigrationProviderContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { planGrokAutomations } from "./automations.js";
import { grokAgentIdentityDigest, grokContentDigest, renderGrokWorkspace } from "./content.js";
import { planGrokPrimaryIdentity } from "./identity.js";
import { planGrokIntegrations } from "./integrations.js";
import { planGrokSettings } from "./settings.js";
import { readGrokSource } from "./source/index.js";
import { resolveGrokAgentTargets } from "./targets.js";

export async function buildGrokPlan(ctx: MigrationProviderContext): Promise<MigrationPlan> {
  const inventory = await readGrokSource({ source: ctx.source });
  const targets = resolveGrokAgentTargets(inventory, ctx);
  const items: MigrationItem[] = [...planGrokSettings({ inventory, ctx })];
  const warnings = inventory.issues.map((issue) => issue.message);
  for (const [name, section] of Object.entries({
    settings: inventory.settings,
    agents: inventory.agents,
    mcpServers: inventory.mcpServers,
  })) {
    if (section.status !== "complete") {
      warnings.push(`${name}: ${section.reason ?? section.status}`);
    }
  }
  for (const agent of inventory.agents.value) {
    const target = targets.get(agent.id)!;
    const applyPhase = target.isPrimary ? "before-promotion" : "after-promotion";
    items.push(...planGrokPrimaryIdentity({ agent, target, ctx, source: inventory.source }));
    if (!target.isPrimary) {
      items.push(
        createMigrationItem({
          id: `agent:${agent.id}`,
          kind: "agent",
          action: "create-agent",
          source: inventory.source,
          target: target.agentId,
          applyPhase,
          sourceRevision: { algorithm: "sha256", digest: grokAgentIdentityDigest(agent) },
          message: `Create OpenClaw agent ${JSON.stringify(agent.name)}.`,
          details: { sourceAgentId: agent.id },
        }),
      );
    }
    for (const [name, section] of Object.entries({
      memory: agent.memory,
      skills: agent.skills,
      automations: agent.automations,
      plugins: agent.plugins,
    })) {
      if (section.status !== "complete") {
        const message = `${agent.name}: ${name} ${section.status}. ${section.reason ?? ""}`.trim();
        warnings.push(message);
        items.push(
          createMigrationManualItem({
            id: `manual:${agent.id}:${name}`,
            source: inventory.source,
            message,
            recommendation:
              "Supply an export containing this content, or review it in Grok before retiring the source account.",
          }),
        );
      }
    }
    const rendered = renderGrokWorkspace(agent);
    warnings.push(...rendered.warnings);
    for (const file of rendered.files) {
      const destination = path.join(target.workspaceDir, file.path);
      const existing = await fs.readFile(destination).catch((error: unknown) => {
        if (extractErrorCode(error) === "ENOENT") {
          return undefined;
        }
        throw error;
      });
      const digest = grokContentDigest(file.content);
      const conflict =
        file.kind !== "memory" &&
        existing !== undefined &&
        grokContentDigest(existing) !== digest &&
        !ctx.overwrite;
      items.push(
        createMigrationItem({
          id: `file:${agent.id}:${file.path}`,
          kind: file.kind,
          action: file.kind === "memory" ? "append" : "copy",
          source: inventory.source,
          target: destination,
          applyPhase,
          status: conflict ? "conflict" : "planned",
          reason: conflict ? "target exists" : undefined,
          sourceRevision: { algorithm: "sha256", digest },
          details: {
            sourceAgentId: agent.id,
            relativePath: file.path,
            ...(file.skillName ? { skillName: file.skillName } : {}),
          },
        }),
      );
    }
  }
  items.push(...planGrokIntegrations({ inventory, ctx, agentTargets: targets }));
  items.push(...(await planGrokAutomations({ inventory, ctx, agentTargets: targets })));
  items.push(
    createMigrationItem({
      id: "archive:grok-source",
      kind: "archive",
      action: "archive-grok-source",
      source: inventory.source,
      message:
        "Preserve source settings and original automation/integration definitions for manual follow-up; credential values are excluded.",
    }),
  );
  return {
    providerId: "grok",
    source: inventory.source,
    items,
    summary: summarizeMigrationItems(items),
    warnings: [...new Set(warnings)],
    nextSteps: [
      "Review the migration report, reconnect integrations marked manual, and test imported agents before retiring Grok Bot.",
    ],
    metadata: {
      primaryTargetAgentId: [...targets.values()].find((target) => target.isPrimary)?.agentId,
    },
  };
}
