import {
  createMigrationManualItem,
  markMigrationItemConflict,
  markMigrationItemError,
} from "openclaw/plugin-sdk/migration";
import {
  applyMigrationCronJob,
  validateMigrationCronJob,
  type MigrationCronJob,
} from "openclaw/plugin-sdk/migration-runtime";
import type { MigrationItem, MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { grokTimezone } from "./settings.js";
import type { GrokSourceInventory } from "./source/types.js";
import { grokImportId, type GrokAgentTargets } from "./targets.js";

export async function planGrokAutomations(params: {
  inventory: GrokSourceInventory;
  ctx: MigrationProviderContext;
  agentTargets: GrokAgentTargets;
}): Promise<MigrationItem[]> {
  const { inventory, agentTargets } = params;
  const timezone = grokTimezone(inventory);
  const items: MigrationItem[] = [];
  for (const agent of inventory.agents.value) {
    for (const automation of agent.automations.value) {
      const id = grokImportId(JSON.stringify(["automation", agent.id, automation.id]));
      const source = `${inventory.source}#agents.${agent.id}.automations.${automation.id}`;
      const record = automation.record;
      const trigger = isRecord(record.trigger) ? record.trigger : undefined;
      const expr = trigger && normalizeOptionalString(trigger.schedule);
      const message = typeof record.prompt === "string" ? record.prompt : undefined;
      const agentId = agentTargets.get(agent.id)?.agentId;
      let reason: string | undefined;
      if (!agentId) {
        reason = "The source agent has no migration destination.";
      } else if (
        trigger?.type !== "cron" ||
        !expr ||
        Object.keys(trigger).some((key) => !["type", "schedule"].includes(key))
      ) {
        reason = "The source trigger has no verified native schedule mapping.";
      } else if (!timezone) {
        reason = "The source timezone is unavailable or invalid.";
      } else if (!message?.trim() || typeof record.isEnabled !== "boolean") {
        reason = "The source routine has no explicit prompt or activation state.";
      } else if (record.delivery !== undefined || record.dependencies !== undefined) {
        reason = "The routine's delivery or dependency configuration needs manual translation.";
      } else if (agent.plugins.status !== "complete" || agent.plugins.value.length > 0) {
        reason = "The agent's Grok plugin dependencies need native integration setup first.";
      }
      const job: MigrationCronJob | undefined =
        !reason && agentId && expr && message && timezone
          ? {
              id,
              agentId,
              name: automation.name,
              message,
              enabled: false,
              schedule: { kind: "cron", expr, tz: timezone },
            }
          : undefined;
      if (job) {
        reason = await validateMigrationCronJob(job);
      }
      if (reason || !job) {
        items.push(
          createMigrationManualItem({
            id: `manual:${id}`,
            source,
            message: `Routine "${automation.name}" was not activated. ${reason ?? "Its definition is incomplete."}`,
            recommendation:
              "Review the archived original routine, complete its integrations, and create the equivalent native schedule.",
          }),
        );
        continue;
      }
      items.push({
        id: `automation:${id}`,
        kind: "automation",
        action: "create-cron",
        status: "planned",
        applyPhase: "after-promotion",
        source,
        target: `cron:${id}`,
        message: `Import "${automation.name}" for ${agent.name}, disabled${record.isEnabled ? " pending native permission and delivery review" : " as in Grok"}.`,
        details: { sourceAgentId: agent.id, sourceEnabled: record.isEnabled, job },
      });
      if (record.isEnabled) {
        items.push(
          createMigrationManualItem({
            id: `manual:${id}:activation`,
            source,
            message: `Routine "${automation.name}" was enabled in Grok and is disabled in OpenClaw until its permissions and delivery are reviewed.`,
            recommendation:
              "Review native tool permissions and delivery, then enable the imported schedule. Results currently stay in OpenClaw job history; Grok conversation routing and notifications are not reproduced.",
          }),
        );
      }
    }
  }
  return items;
}

function readJob(value: unknown): MigrationCronJob | undefined {
  if (!isRecord(value) || !isRecord(value.schedule)) {
    return undefined;
  }
  const { id, agentId, name, message, enabled, schedule } = value;
  if (
    typeof id !== "string" ||
    typeof agentId !== "string" ||
    typeof name !== "string" ||
    typeof message !== "string" ||
    typeof enabled !== "boolean" ||
    schedule.kind !== "cron" ||
    typeof schedule.expr !== "string" ||
    typeof schedule.tz !== "string"
  ) {
    return undefined;
  }
  return {
    id,
    agentId,
    name,
    message,
    enabled,
    schedule: { kind: "cron", expr: schedule.expr, tz: schedule.tz },
  };
}

export async function applyGrokAutomationItem(
  ctx: MigrationProviderContext,
  item: MigrationItem,
): Promise<MigrationItem> {
  if (item.status !== "planned") {
    return item;
  }
  const job = readJob(item.details?.job);
  if (item.action !== "create-cron" || !job) {
    return markMigrationItemError(
      item,
      "The reviewed automation definition is missing or invalid.",
    );
  }
  try {
    const status = await applyMigrationCronJob(ctx, job);
    return status === "conflict"
      ? markMigrationItemConflict(
          item,
          "A different or edited schedule already has this source identity.",
        )
      : { ...item, status: "migrated", deferredCompletion: true };
  } catch (error) {
    return markMigrationItemError(item, error instanceof Error ? error.message : String(error));
  }
}
