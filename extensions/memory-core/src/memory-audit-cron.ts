import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  MANAGED_MEMORY_AUDIT_DAILY_CRON_NAME,
  MANAGED_MEMORY_AUDIT_DAILY_CRON_TAG,
  MANAGED_MEMORY_AUDIT_WEEKLY_CRON_NAME,
  MANAGED_MEMORY_AUDIT_WEEKLY_CRON_TAG,
  resolveMemoryAuditConfig,
  resolveMemoryCorePluginConfig,
  type MemoryAuditCadence,
  type MemoryAuditConfig,
  type MemoryAuditDeliveryConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatErrorMessage, normalizeTrimmedString } from "./dreaming-shared.js";

type CronSchedule = { kind: "cron"; expr: string; tz?: string };
type ManagedCronJobCreate = {
  name: string;
  description: string;
  enabled: boolean;
  schedule: CronSchedule;
  agentId?: string;
  sessionTarget: string;
  wakeMode: "now";
  payload: { kind: "agentTurn"; message: string; lightContext?: boolean };
  delivery?: MemoryAuditDeliveryConfig;
};
type ManagedCronJobPatch = Partial<ManagedCronJobCreate>;
type ManagedCronJobLike = {
  id: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  schedule?: { kind?: string; expr?: string; tz?: string };
  agentId?: string;
  sessionTarget?: string;
  wakeMode?: string;
  payload?: { kind?: string; message?: string; lightContext?: boolean };
  delivery?: MemoryAuditDeliveryConfig;
  createdAtMs?: number;
};
type CronServiceLike = {
  list: (opts?: { includeDisabled?: boolean }) => Promise<ManagedCronJobLike[]>;
  add: (input: ManagedCronJobCreate) => Promise<unknown>;
  update: (id: string, patch: ManagedCronJobPatch) => Promise<unknown>;
  remove: (id: string) => Promise<{ removed?: boolean }>;
};
type Logger = Pick<OpenClawPluginApi["logger"], "info" | "warn" | "error" | "debug">;

function cadenceName(cadence: MemoryAuditCadence): string {
  return cadence === "daily"
    ? MANAGED_MEMORY_AUDIT_DAILY_CRON_NAME
    : MANAGED_MEMORY_AUDIT_WEEKLY_CRON_NAME;
}

function cadenceTag(cadence: MemoryAuditCadence): string {
  return cadence === "daily"
    ? MANAGED_MEMORY_AUDIT_DAILY_CRON_TAG
    : MANAGED_MEMORY_AUDIT_WEEKLY_CRON_TAG;
}

function buildAuditInstruction(cadence: MemoryAuditCadence): string {
  return [
    `Run the OpenClaw ${cadence} memory audit.`,
    "Use memory_audit_collect to inspect durable memory surfaces.",
    "Use memory_audit_stage to stage only high-value add, edit, delete, or move recommendations.",
    "Do not edit memory files directly; a human applies or rejects staged recommendations.",
    "Prefer removing junk, correcting stale memories, and moving facts to the right surface over adding more memory.",
  ].join(" ");
}

function buildManagedAuditCronJob(
  config: MemoryAuditConfig,
  cadence: MemoryAuditCadence,
): ManagedCronJobCreate | null {
  if (!config.enabled) {
    return null;
  }
  const cadenceConfig = cadence === "daily" ? config.daily : config.weekly;
  if (!cadenceConfig.enabled) {
    return null;
  }
  return {
    name: cadenceName(cadence),
    description: `${cadenceTag(cadence)} Review durable memory quality and stage human-approved recommendations.`,
    enabled: true,
    ...(config.agentId ? { agentId: config.agentId } : {}),
    schedule: {
      kind: "cron",
      expr: cadenceConfig.cron,
      ...(config.timezone ? { tz: config.timezone } : {}),
    },
    sessionTarget: config.sessionTarget,
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message: buildAuditInstruction(cadence),
      lightContext: true,
    },
    delivery: config.delivery,
  };
}

function isManagedAuditJob(job: ManagedCronJobLike): boolean {
  const description = normalizeTrimmedString(job.description);
  if (
    description?.includes(MANAGED_MEMORY_AUDIT_DAILY_CRON_TAG) ||
    description?.includes(MANAGED_MEMORY_AUDIT_WEEKLY_CRON_TAG)
  ) {
    return true;
  }
  const name = normalizeTrimmedString(job.name);
  return (
    name === MANAGED_MEMORY_AUDIT_DAILY_CRON_NAME || name === MANAGED_MEMORY_AUDIT_WEEKLY_CRON_NAME
  );
}

function isManagedAuditCadenceJob(job: ManagedCronJobLike, cadence: MemoryAuditCadence): boolean {
  return (
    normalizeTrimmedString(job.description)?.includes(cadenceTag(cadence)) === true ||
    normalizeTrimmedString(job.name) === cadenceName(cadence)
  );
}

function sameDelivery(
  a: MemoryAuditDeliveryConfig | undefined,
  b: MemoryAuditDeliveryConfig | undefined,
): boolean {
  return JSON.stringify(a ?? { mode: "none" }) === JSON.stringify(b ?? { mode: "none" });
}

function buildPatch(
  existing: ManagedCronJobLike,
  desired: ManagedCronJobCreate,
): ManagedCronJobPatch | null {
  const patch: ManagedCronJobPatch = {};
  if (normalizeTrimmedString(existing.name) !== desired.name) patch.name = desired.name;
  if (normalizeTrimmedString(existing.description) !== desired.description)
    patch.description = desired.description;
  if (existing.enabled !== desired.enabled) patch.enabled = desired.enabled;
  if (normalizeTrimmedString(existing.agentId) !== desired.agentId) patch.agentId = desired.agentId;
  if (normalizeTrimmedString(existing.sessionTarget) !== desired.sessionTarget)
    patch.sessionTarget = desired.sessionTarget;
  if (normalizeTrimmedString(existing.wakeMode) !== desired.wakeMode)
    patch.wakeMode = desired.wakeMode;
  if (
    normalizeLowercaseStringOrEmpty(existing.schedule?.kind) !== desired.schedule.kind ||
    normalizeTrimmedString(existing.schedule?.expr) !== desired.schedule.expr ||
    normalizeTrimmedString(existing.schedule?.tz) !== desired.schedule.tz
  ) {
    patch.schedule = desired.schedule;
  }
  if (
    normalizeLowercaseStringOrEmpty(existing.payload?.kind) !== "agentturn" ||
    normalizeTrimmedString(existing.payload?.message) !== desired.payload.message ||
    existing.payload?.lightContext !== desired.payload.lightContext
  ) {
    patch.payload = desired.payload;
  }
  if (!sameDelivery(existing.delivery, desired.delivery)) {
    patch.delivery = desired.delivery;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

function sortJobs(jobs: ManagedCronJobLike[]): ManagedCronJobLike[] {
  return [...jobs].sort(
    (a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0) || a.id.localeCompare(b.id),
  );
}

export async function reconcileMemoryAuditCronJobs(params: {
  cron: CronServiceLike | null;
  config: MemoryAuditConfig;
  logger: Logger;
}): Promise<{ status: "unavailable" | "disabled" | "updated" | "noop"; changed: number }> {
  if (!params.cron) {
    return { status: "unavailable", changed: 0 };
  }
  const allJobs = await params.cron.list({ includeDisabled: true });
  const auditJobs = allJobs.filter(isManagedAuditJob);
  const desired = [
    buildManagedAuditCronJob(params.config, "daily"),
    buildManagedAuditCronJob(params.config, "weekly"),
  ].filter((job): job is ManagedCronJobCreate => Boolean(job));
  if (!params.config.enabled) {
    let changed = 0;
    for (const job of auditJobs) {
      const result = await params.cron.remove(job.id);
      if (result.removed === true) {
        changed += 1;
      }
    }
    return { status: "disabled", changed };
  }
  const desiredNames = new Set(desired.map((job) => job.name));
  let changed = 0;
  for (const stale of auditJobs.filter(
    (job) => !desiredNames.has(normalizeTrimmedString(job.name) ?? ""),
  )) {
    const result = await params.cron.remove(stale.id);
    if (result.removed === true) {
      changed += 1;
    }
  }
  for (const desiredJob of desired) {
    const cadence = desiredJob.name === MANAGED_MEMORY_AUDIT_DAILY_CRON_NAME ? "daily" : "weekly";
    const [primary, ...duplicates] = sortJobs(
      auditJobs.filter((job) => isManagedAuditCadenceJob(job, cadence)),
    );
    if (!primary) {
      await params.cron.add(desiredJob);
      changed += 1;
      continue;
    }
    for (const duplicate of duplicates) {
      const result = await params.cron.remove(duplicate.id);
      if (result.removed === true) {
        changed += 1;
      }
    }
    const patch = buildPatch(primary, desiredJob);
    if (patch) {
      await params.cron.update(primary.id, patch);
      changed += 1;
    }
  }
  return { status: changed > 0 ? "updated" : "noop", changed };
}

function resolveCronService(ctx: unknown): CronServiceLike | null {
  const record = ctx as {
    getCron?: () => CronServiceLike | null;
    deps?: { cron?: CronServiceLike };
  };
  return record.getCron?.() ?? record.deps?.cron ?? null;
}

export function registerMemoryAuditCron(api: OpenClawPluginApi): void {
  api.on("gateway_start", async (_event, ctx) => {
    const cfg = (ctx.config ?? api.config) as OpenClawConfig;
    const pluginConfig = resolveMemoryCorePluginConfig(cfg) ?? api.pluginConfig;
    const config = resolveMemoryAuditConfig({ pluginConfig, cfg });
    try {
      const result = await reconcileMemoryAuditCronJobs({
        cron: resolveCronService(ctx),
        config,
        logger: api.logger,
      });
      if (result.changed > 0) {
        api.logger.info(`memory-core: reconciled ${result.changed} memory audit cron job(s).`);
      }
    } catch (err) {
      api.logger.error(
        `memory-core: memory audit cron reconciliation failed: ${formatErrorMessage(err)}`,
      );
    }
  });
}

export const testing = {
  buildManagedAuditCronJob,
  isManagedAuditJob,
  reconcileMemoryAuditCronJobs,
  constants: {
    MANAGED_MEMORY_AUDIT_DAILY_CRON_NAME,
    MANAGED_MEMORY_AUDIT_DAILY_CRON_TAG,
    MANAGED_MEMORY_AUDIT_WEEKLY_CRON_NAME,
    MANAGED_MEMORY_AUDIT_WEEKLY_CRON_TAG,
  },
};
export { testing as __testing };
