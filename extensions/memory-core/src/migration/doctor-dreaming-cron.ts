import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  PluginDoctorCronChange,
  PluginDoctorCronInventory,
  PluginDoctorCronJob,
  PluginDoctorStateMigration,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { MANAGED_DREAMING_DECLARATION_KEY } from "../dreaming-cron-contract.js";
import { classifyDreamingCronJob, type DreamingCronKind } from "./dreaming-cron-classifier.js";

async function planDreamingCronRepair(
  inventory: PluginDoctorCronInventory,
  config: OpenClawConfig,
) {
  // Doctor contract enumeration stays dependency-light; only inspection loads the host constants.
  const constants = await import("openclaw/plugin-sdk/memory-core-host-status");
  const { resolveMemoryDreamingPluginConfig } =
    await import("openclaw/plugin-sdk/memory-core-host-runtime-core");
  const enabled = constants.resolveMemoryDeepDreamingConfig({
    cfg: config,
    pluginConfig: resolveMemoryDreamingPluginConfig(config),
  }).enabled;
  const changes: PluginDoctorCronChange[] = [];
  const warnings: string[] = [];
  const partitions = new Map<
    string,
    { job: PluginDoctorCronJob; kind: Exclude<DreamingCronKind, "ambiguous"> }[]
  >();
  for (const job of inventory.jobs) {
    if (!job.definition) {
      warnings.push(
        `Could not inspect cron job ${job.id} in ${job.storeKey}: invalid definition JSON; row retained.`,
      );
      continue;
    }
    const kind = classifyDreamingCronJob(job.definition, constants);
    if (!kind) {
      continue;
    }
    if (kind === "ambiguous") {
      warnings.push(
        `Dreaming cron job ${job.id} in ${job.storeKey} retains a historical dreaming tag with an authored payload; review its ownership manually. Row retained.`,
      );
      continue;
    }
    if (job.invalidReason) {
      warnings.push(
        `Dreaming cron job ${job.id} in ${job.storeKey} needs cron repair (${job.invalidReason}); row retained.`,
      );
      continue;
    }
    const entries = partitions.get(job.storeKey) ?? [];
    entries.push({ job, kind });
    partitions.set(job.storeKey, entries);
  }
  for (const entries of partitions.values()) {
    if (!enabled) {
      changes.push(...entries.map(({ job }) => ({ job, definition: null })));
      continue;
    }
    const survivor = entries.toSorted((left, right) => {
      if (left.kind !== right.kind) {
        const priority = { declared: 0, legacy: 1, phase: 2 };
        return priority[left.kind] - priority[right.kind];
      }
      const leftCreated = left.job.definition?.createdAtMs;
      const rightCreated = right.job.definition?.createdAtMs;
      const ageOrder =
        (typeof leftCreated === "number" ? leftCreated : Number.MAX_SAFE_INTEGER) -
        (typeof rightCreated === "number" ? rightCreated : Number.MAX_SAFE_INTEGER);
      if (ageOrder !== 0) {
        return ageOrder;
      }
      return left.job.id.localeCompare(right.job.id);
    })[0];
    if (!survivor?.job.definition) {
      continue;
    }
    const raw = survivor.job.definition;
    const definition: Record<string, unknown> = {
      ...raw,
      declarationKey: MANAGED_DREAMING_DECLARATION_KEY,
    };
    const payload = isRecord(raw.payload) ? raw.payload : {};
    const delivery = isRecord(raw.delivery) ? raw.delivery : {};
    definition.sessionTarget = "isolated";
    if (payload.kind !== "agentTurn" || survivor.kind === "phase") {
      const { text: _legacyText, ...retainedPayload } = payload;
      definition.payload = {
        ...retainedPayload,
        kind: "agentTurn",
        message: constants.MEMORY_DREAMING_SYSTEM_EVENT_TEXT,
        lightContext: true,
      };
    } else {
      definition.payload = { ...payload, lightContext: true };
    }
    definition.delivery = { ...delivery, mode: "none" };
    if (survivor.kind === "phase") {
      if (
        raw.name === constants.LEGACY_MEMORY_LIGHT_DREAMING_CRON_NAME ||
        raw.name === constants.LEGACY_MEMORY_REM_DREAMING_CRON_NAME
      ) {
        definition.name = constants.MANAGED_MEMORY_DREAMING_CRON_NAME;
      }
      if (typeof raw.description === "string") {
        definition.description = raw.description
          .replace(
            constants.LEGACY_MEMORY_LIGHT_DREAMING_CRON_TAG,
            constants.MANAGED_MEMORY_DREAMING_CRON_TAG,
          )
          .replace(
            constants.LEGACY_MEMORY_REM_DREAMING_CRON_TAG,
            constants.MANAGED_MEMORY_DREAMING_CRON_TAG,
          );
      }
    }
    if (!isDeepStrictEqual(definition, raw)) {
      changes.push({ job: survivor.job, definition });
    }
    for (const { job } of entries) {
      if (job.id !== survivor.job.id) {
        changes.push({ job, definition: null });
      }
    }
  }
  return { changes, warnings, enabled };
}

export const dreamingCronMigration: PluginDoctorStateMigration = {
  id: "memory-core-dreaming-cron",
  label: "memory-core dreaming cron ownership",
  doctorOnly: true,
  phase: "after-session-repair",
  // The host owns the shared SQLite database and captures it before exact-row repair.
  collectBackupResources: () => [],
  async detectLegacyState({ context, config }) {
    if (!context.inspectCronJobs) {
      return null;
    }
    const plan = await planDreamingCronRepair(await context.inspectCronJobs(), config);
    const preview = [
      ...(plan.changes.length
        ? [
            `Repair ${plan.changes.length} historical dreaming cron row(s) after a verified SQLite backup.`,
          ]
        : []),
      ...plan.warnings,
    ];
    return preview.length ? { preview } : null;
  },
  async migrateLegacyState({ context, config }) {
    if (!context.inspectCronJobs || !context.repairCronJobs) {
      return {
        changes: [],
        warnings: [
          "Dreaming cron repair requires a host with offline Doctor cron maintenance support.",
        ],
        warningDisposition: "recoverable",
      };
    }
    const inventory = await context.inspectCronJobs();
    const plan = await planDreamingCronRepair(inventory, config);
    if (!plan.changes.length) {
      return { changes: [], warnings: plan.warnings, warningDisposition: "recoverable" };
    }
    const result = await context.repairCronJobs(inventory, plan.changes);
    return {
      changes: result.changed
        ? [
            plan.enabled
              ? `Repaired ${result.changed} historical dreaming cron row(s); survivor IDs, order, and runtime state preserved. SQLite backup: ${result.backupPath}.`
              : `Retired ${result.changed} managed dreaming cron row(s) because dreaming is disabled. SQLite backup: ${result.backupPath}.`,
          ]
        : [],
      warnings: plan.warnings,
      warningDisposition: "recoverable",
    };
  },
};
