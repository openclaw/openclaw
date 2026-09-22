/** Stateless convergence of the memory-core-owned dreaming cron job family. */
import {
  LEGACY_MEMORY_LIGHT_DREAMING_CRON_NAME as LEGACY_LIGHT_SLEEP_CRON_NAME,
  LEGACY_MEMORY_LIGHT_DREAMING_CRON_TAG as LEGACY_LIGHT_SLEEP_CRON_TAG,
  LEGACY_MEMORY_LIGHT_DREAMING_EVENT_TEXT as LEGACY_LIGHT_SLEEP_EVENT_TEXT,
  LEGACY_MEMORY_REM_DREAMING_CRON_NAME as LEGACY_REM_SLEEP_CRON_NAME,
  LEGACY_MEMORY_REM_DREAMING_CRON_TAG as LEGACY_REM_SLEEP_CRON_TAG,
  LEGACY_MEMORY_REM_DREAMING_EVENT_TEXT as LEGACY_REM_SLEEP_EVENT_TEXT,
  MANAGED_MEMORY_DREAMING_CRON_NAME as MANAGED_DREAMING_CRON_NAME,
  MANAGED_MEMORY_DREAMING_CRON_TAG as MANAGED_DREAMING_CRON_TAG,
  MEMORY_DREAMING_SYSTEM_EVENT_TEXT as DREAMING_SYSTEM_EVENT_TEXT,
  type resolveMemoryDeepDreamingConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  isRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatErrorMessage } from "./dreaming-shared.js";

const MANAGED_DREAMING_DECLARATION_KEY = "memory-core:memory-dreaming-promotion";

type Logger = Pick<OpenClawPluginApi["logger"], "info" | "warn" | "error">;
type ShortTermPromotionDreamingConfig = ReturnType<typeof resolveMemoryDeepDreamingConfig>;

type CronSchedule = { kind: "cron"; expr: string; tz?: string };
type CronPayload =
  | { kind: "systemEvent"; text: string }
  | { kind: "agentTurn"; message: string; lightContext?: boolean };
type ManagedCronJobCreate = {
  declarationKey: string;
  name: string;
  description: string;
  enabled: boolean;
  schedule: CronSchedule;
  sessionTarget: "main" | "isolated";
  wakeMode: "now";
  payload: CronPayload;
  delivery?: {
    mode: "none";
  };
};

type ManagedCronJobPatch = Partial<Omit<ManagedCronJobCreate, "declarationKey">>;

type ManagedCronJobLike = {
  id: string;
  declarationKey?: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  schedule?: {
    kind?: string;
    expr?: string;
    tz?: string;
  };
  sessionTarget?: string;
  wakeMode?: string;
  payload?: {
    kind?: string;
    text?: string;
    message?: string;
    lightContext?: boolean;
  };
  delivery?: {
    mode?: string;
  };
  createdAtMs?: number;
};

export type CronServiceLike = {
  isEnabled?: () => Promise<boolean>;
  list: (opts?: { includeDisabled?: boolean }) => Promise<ManagedCronJobLike[]>;
  add: (input: ManagedCronJobCreate) => Promise<unknown>;
  update: (id: string, patch: ManagedCronJobPatch) => Promise<unknown>;
  remove: (id: string) => Promise<{ removed?: boolean }>;
  removeStaleJobFamily: (family: {
    declarationKey: string;
    name: string;
    ownerPluginTag: string;
  }) => Promise<number>;
};

type ReconcileResult = {
  status: "unavailable" | "disabled" | "added" | "updated" | "noop";
  removed: number;
};

type LegacyPhaseMigrationMode = "enabled" | "disabled";

function resolveManagedCronDescription(config: ShortTermPromotionDreamingConfig): string {
  const recencyHalfLifeDays = config.recencyHalfLifeDays;
  return `${MANAGED_DREAMING_CRON_TAG} Promote weighted short-term recalls into MEMORY.md (limit=${config.limit}, minScore=${config.minScore.toFixed(3)}, minRecallCount=${config.minRecallCount}, minUniqueQueries=${config.minUniqueQueries}, recencyHalfLifeDays=${recencyHalfLifeDays}, maxAgeDays=${config.maxAgeDays ?? "none"}).`;
}

function buildManagedDreamingCronJob(
  config: ShortTermPromotionDreamingConfig,
): ManagedCronJobCreate {
  return {
    declarationKey: MANAGED_DREAMING_DECLARATION_KEY,
    name: MANAGED_DREAMING_CRON_NAME,
    description: resolveManagedCronDescription(config),
    enabled: true,
    schedule: {
      kind: "cron",
      expr: config.cron,
      ...(config.timezone ? { tz: config.timezone } : {}),
    },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message: DREAMING_SYSTEM_EVENT_TEXT,
      lightContext: true,
    },
    // Dreaming is a maintenance sweep, not a user-facing announce job.
    delivery: {
      mode: "none",
    },
  };
}

function resolveManagedDreamingPayloadToken(
  payload: ManagedCronJobLike["payload"],
): string | undefined {
  const payloadKind = normalizeLowercaseStringOrEmpty(normalizeOptionalString(payload?.kind));
  if (payloadKind === "systemevent") {
    return normalizeOptionalString(payload?.text);
  }
  if (payloadKind === "agentturn") {
    return normalizeOptionalString(payload?.message);
  }
  return undefined;
}

function isManagedDreamingJob(job: ManagedCronJobLike): boolean {
  if (normalizeOptionalString(job.declarationKey) === MANAGED_DREAMING_DECLARATION_KEY) {
    return true;
  }
  const name = normalizeOptionalString(job.name);
  if (name !== MANAGED_DREAMING_CRON_NAME) {
    return false;
  }
  const description = normalizeOptionalString(job.description);
  if (description?.includes(MANAGED_DREAMING_CRON_TAG)) {
    return true;
  }
  return resolveManagedDreamingPayloadToken(job.payload) === DREAMING_SYSTEM_EVENT_TEXT;
}

function isLegacyPhaseDreamingJob(job: ManagedCronJobLike): boolean {
  const description = normalizeOptionalString(job.description);
  if (
    description?.includes(LEGACY_LIGHT_SLEEP_CRON_TAG) ||
    description?.includes(LEGACY_REM_SLEEP_CRON_TAG)
  ) {
    return true;
  }
  const name = normalizeOptionalString(job.name);
  const payloadText = normalizeOptionalString(job.payload?.text);
  if (name === LEGACY_LIGHT_SLEEP_CRON_NAME && payloadText === LEGACY_LIGHT_SLEEP_EVENT_TEXT) {
    return true;
  }
  return name === LEGACY_REM_SLEEP_CRON_NAME && payloadText === LEGACY_REM_SLEEP_EVENT_TEXT;
}

async function removeStaleManagedDreamingRows(cron: CronServiceLike): Promise<number> {
  // Adopt legacy pre-declaration-key jobs copied under obsolete store keys. Leaving one
  // behind means both it and the declared replacement can run, producing duplicate sweeps.
  return (
    (await cron.removeStaleJobFamily({
      declarationKey: MANAGED_DREAMING_DECLARATION_KEY,
      name: MANAGED_DREAMING_CRON_NAME,
      ownerPluginTag: MANAGED_DREAMING_CRON_TAG,
    })) ?? 0
  );
}

async function migrateLegacyPhaseDreamingCronJobs(params: {
  cron: CronServiceLike;
  legacyJobs: ManagedCronJobLike[];
  logger: Logger;
  mode: LegacyPhaseMigrationMode;
}): Promise<number> {
  let migrated = 0;
  for (const job of params.legacyJobs) {
    try {
      const result = await params.cron.remove(job.id);
      if (result.removed === true) {
        migrated += 1;
      }
    } catch (err) {
      params.logger.warn(
        `memory-core: failed to migrate legacy phase dreaming cron job ${job.id}: ${formatErrorMessage(err)}`,
      );
    }
  }
  if (migrated > 0) {
    if (params.mode === "enabled") {
      params.logger.info(
        `memory-core: migrated ${migrated} legacy phase dreaming cron job(s) to the unified dreaming controller.`,
      );
    } else {
      params.logger.info(
        `memory-core: completed legacy phase dreaming cron migration while unified dreaming is disabled (${migrated} job(s) removed).`,
      );
    }
  }
  return migrated;
}

function buildManagedDreamingPatch(
  job: ManagedCronJobLike,
  desired: ManagedCronJobCreate,
): ManagedCronJobPatch | null {
  const patch: ManagedCronJobPatch = {};

  if (normalizeOptionalString(job.name) !== desired.name) {
    patch.name = desired.name;
  }
  if (normalizeOptionalString(job.description) !== desired.description) {
    patch.description = desired.description;
  }
  if (job.enabled !== true) {
    patch.enabled = true;
  }

  const scheduleKind = normalizeLowercaseStringOrEmpty(normalizeOptionalString(job.schedule?.kind));
  const scheduleExpr = normalizeOptionalString(job.schedule?.expr);
  const scheduleTz = normalizeOptionalString(job.schedule?.tz);
  if (
    scheduleKind !== "cron" ||
    scheduleExpr !== desired.schedule.expr ||
    scheduleTz !== desired.schedule.tz
  ) {
    patch.schedule = desired.schedule;
  }

  const sessionTarget = normalizeLowercaseStringOrEmpty(normalizeOptionalString(job.sessionTarget));
  if (sessionTarget !== desired.sessionTarget) {
    patch.sessionTarget = desired.sessionTarget;
  }
  const wakeMode = normalizeLowercaseStringOrEmpty(normalizeOptionalString(job.wakeMode));
  if (wakeMode !== "now") {
    patch.wakeMode = "now";
  }

  const payloadKind = normalizeLowercaseStringOrEmpty(normalizeOptionalString(job.payload?.kind));
  const payloadToken = resolveManagedDreamingPayloadToken(job.payload);
  const desiredPayloadToken =
    desired.payload.kind === "systemEvent" ? desired.payload.text : desired.payload.message;
  const payloadNeedsUpdate =
    payloadKind !== normalizeLowercaseStringOrEmpty(desired.payload.kind) ||
    payloadToken !== desiredPayloadToken ||
    (desired.payload.kind === "agentTurn" &&
      job.payload?.lightContext !== desired.payload.lightContext);
  if (payloadNeedsUpdate) {
    patch.payload = desired.payload;
  }
  const deliveryMode = normalizeLowercaseStringOrEmpty(normalizeOptionalString(job.delivery?.mode));
  if (deliveryMode !== "none") {
    patch.delivery = desired.delivery;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

function sortManagedJobs(managed: ManagedCronJobLike[]): ManagedCronJobLike[] {
  return managed.toSorted((a, b) => {
    const aCreated =
      typeof a.createdAtMs === "number" && Number.isFinite(a.createdAtMs)
        ? a.createdAtMs
        : Number.MAX_SAFE_INTEGER;
    const bCreated =
      typeof b.createdAtMs === "number" && Number.isFinite(b.createdAtMs)
        ? b.createdAtMs
        : Number.MAX_SAFE_INTEGER;
    if (aCreated !== bCreated) {
      return aCreated - bCreated;
    }
    return a.id.localeCompare(b.id);
  });
}

function isCronServiceLike(candidate: unknown): candidate is CronServiceLike {
  return (
    isRecord(candidate) &&
    (candidate.isEnabled === undefined || typeof candidate.isEnabled === "function") &&
    typeof candidate.list === "function" &&
    typeof candidate.add === "function" &&
    typeof candidate.update === "function" &&
    typeof candidate.remove === "function" &&
    typeof candidate.removeStaleJobFamily === "function"
  );
}

export function resolveCronServiceFromGatewayContext(context: { getCron?: () => unknown }) {
  const cron = context.getCron?.();
  return isCronServiceLike(cron) ? cron : null;
}

export async function reconcileShortTermDreamingCronJob(params: {
  cron: CronServiceLike | null;
  config: ShortTermPromotionDreamingConfig;
  logger: Logger;
}): Promise<ReconcileResult> {
  const cron = params.cron;
  if (!cron) {
    return { status: "unavailable", removed: 0 };
  }

  const allJobs = await cron.list({ includeDisabled: true });
  const managed = allJobs.filter(isManagedDreamingJob);
  const legacyPhaseJobs = allJobs.filter(isLegacyPhaseDreamingJob);

  if (!params.config.enabled) {
    let removed = await migrateLegacyPhaseDreamingCronJobs({
      cron,
      legacyJobs: legacyPhaseJobs,
      logger: params.logger,
      mode: "disabled",
    });
    for (const job of managed) {
      try {
        const result = await cron.remove(job.id);
        if (result.removed === true) {
          removed += 1;
        }
      } catch (err) {
        params.logger.warn(
          `memory-core: failed to remove managed dreaming cron job ${job.id}: ${formatErrorMessage(err)}`,
        );
      }
    }
    removed += await removeStaleManagedDreamingRows(cron);
    if (removed > 0) {
      params.logger.info(`memory-core: removed ${removed} managed dreaming cron job(s).`);
    }
    return { status: "disabled", removed };
  }

  const desired = buildManagedDreamingCronJob(params.config);
  const primary = managed.find((job) => job.declarationKey === MANAGED_DREAMING_DECLARATION_KEY);
  if (!primary) {
    await cron.add(desired);
    let removed = await migrateLegacyPhaseDreamingCronJobs({
      cron,
      legacyJobs: legacyPhaseJobs,
      logger: params.logger,
      mode: "enabled",
    });
    for (const job of managed) {
      const result = await cron.remove(job.id);
      if (result.removed !== true) {
        throw new Error(`failed to replace legacy managed dreaming cron job ${job.id}`);
      }
      removed += 1;
    }
    removed += await removeStaleManagedDreamingRows(cron);
    params.logger.info(
      managed.length === 0
        ? "memory-core: created managed dreaming cron job."
        : "memory-core: replaced legacy managed dreaming cron job identity.",
    );
    return { status: "added", removed };
  }

  const duplicates = sortManagedJobs(managed.filter((job) => job.id !== primary.id));
  let removed = await migrateLegacyPhaseDreamingCronJobs({
    cron,
    legacyJobs: legacyPhaseJobs,
    logger: params.logger,
    mode: "enabled",
  });
  for (const duplicate of duplicates) {
    try {
      const result = await cron.remove(duplicate.id);
      if (result.removed === true) {
        removed += 1;
      }
    } catch (err) {
      params.logger.warn(
        `memory-core: failed to prune duplicate managed dreaming cron job ${duplicate.id}: ${formatErrorMessage(err)}`,
      );
    }
  }
  removed += await removeStaleManagedDreamingRows(cron);

  const patch = buildManagedDreamingPatch(primary, desired);
  if (!patch) {
    if (removed > 0) {
      params.logger.info("memory-core: pruned duplicate managed dreaming cron jobs.");
    }
    return { status: "noop", removed };
  }

  await cron.update(primary.id, patch);
  params.logger.info("memory-core: updated managed dreaming cron job.");
  return { status: "updated", removed };
}
