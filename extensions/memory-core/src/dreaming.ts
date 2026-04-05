import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/memory-core";
import {
  applyShortTermPromotions,
  DEFAULT_PROMOTION_MIN_RECALL_COUNT,
  DEFAULT_PROMOTION_MIN_SCORE,
  DEFAULT_PROMOTION_MIN_UNIQUE_QUERIES,
  repairShortTermPromotionArtifacts,
  rankShortTermPromotionCandidates,
} from "./short-term-promotion.js";

const MANAGED_DREAMING_CRON_NAME = "Memory Dreaming Promotion";
const MANAGED_DREAMING_CRON_TAG = "[managed-by=memory-core.short-term-promotion]";
const DREAMING_SYSTEM_EVENT_TEXT = "__openclaw_memory_core_short_term_promotion_dream__";
const DEFAULT_DREAMING_CRON_EXPR = "0 3 * * *";
const DEFAULT_DREAMING_LIMIT = 10;
const DEFAULT_DREAMING_MIN_SCORE = DEFAULT_PROMOTION_MIN_SCORE;
const DEFAULT_DREAMING_MIN_RECALL_COUNT = DEFAULT_PROMOTION_MIN_RECALL_COUNT;
const DEFAULT_DREAMING_MIN_UNIQUE_QUERIES = DEFAULT_PROMOTION_MIN_UNIQUE_QUERIES;
const DEFAULT_DREAMING_MODE = "off";
const DEFAULT_DREAMING_PRESET = "core";

type DreamingPreset = "core" | "deep" | "rem";
type DreamingMode = DreamingPreset | "off";

const DREAMING_PRESET_DEFAULTS: Record<
  DreamingPreset,
  {
    cron: string;
    limit: number;
    minScore: number;
    minRecallCount: number;
    minUniqueQueries: number;
  }
> = {
  core: {
    cron: DEFAULT_DREAMING_CRON_EXPR,
    limit: DEFAULT_DREAMING_LIMIT,
    minScore: DEFAULT_DREAMING_MIN_SCORE,
    minRecallCount: DEFAULT_DREAMING_MIN_RECALL_COUNT,
    minUniqueQueries: DEFAULT_DREAMING_MIN_UNIQUE_QUERIES,
  },
  deep: {
    cron: "0 */12 * * *",
    limit: DEFAULT_DREAMING_LIMIT,
    minScore: 0.8,
    minRecallCount: 3,
    minUniqueQueries: 3,
  },
  rem: {
    cron: "0 */6 * * *",
    limit: DEFAULT_DREAMING_LIMIT,
    minScore: 0.85,
    minRecallCount: 4,
    minUniqueQueries: 3,
  },
};

type Logger = Pick<OpenClawPluginApi["logger"], "info" | "warn" | "error">;

type CronSchedule = { kind: "cron"; expr: string; tz?: string };
type CronPayload = { kind: "systemEvent"; text: string };
type ManagedCronJobCreate = {
  name: string;
  description: string;
  enabled: boolean;
  schedule: CronSchedule;
  sessionTarget: "main";
  wakeMode: "next-heartbeat";
  payload: CronPayload;
};

type ManagedCronJobPatch = {
  name?: string;
  description?: string;
  enabled?: boolean;
  schedule?: CronSchedule;
  sessionTarget?: "main";
  wakeMode?: "next-heartbeat";
  payload?: CronPayload;
};

type ManagedCronJobLike = {
  id: string;
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
  };
  createdAtMs?: number;
};

type CronServiceLike = {
  list: (opts?: { includeDisabled?: boolean }) => Promise<ManagedCronJobLike[]>;
  add: (input: ManagedCronJobCreate) => Promise<unknown>;
  update: (id: string, patch: ManagedCronJobPatch) => Promise<unknown>;
  remove: (id: string) => Promise<{ removed?: boolean }>;
};

export type ShortTermPromotionDreamingConfig = {
  enabled: boolean;
  cron: string;
  timezone?: string;
  limit: number;
  minScore: number;
  minRecallCount: number;
  minUniqueQueries: number;
  verboseLogging: boolean;
};

type ReconcileResult =
  | { status: "unavailable"; removed: number }
  | { status: "disabled"; removed: number }
  | { status: "added"; removed: number }
  | { status: "updated"; removed: number }
  | { status: "noop"; removed: number };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeDreamingMode(value: unknown): DreamingMode {
  const normalized = normalizeTrimmedString(value)?.toLowerCase();
  if (
    normalized === "off" ||
    normalized === "core" ||
    normalized === "deep" ||
    normalized === "rem"
  ) {
    return normalized;
  }
  return DEFAULT_DREAMING_MODE;
}

function normalizeNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value === "string" && value.trim().length === 0) {
    return fallback;
  }
  const num = typeof value === "string" ? Number(value.trim()) : Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  const floored = Math.floor(num);
  if (floored < 0) {
    return fallback;
  }
  return floored;
}

function normalizeScore(value: unknown, fallback: number): number {
  if (typeof value === "string" && value.trim().length === 0) {
    return fallback;
  }
  const num = typeof value === "string" ? Number(value.trim()) : Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  if (num < 0 || num > 1) {
    return fallback;
  }
  return num;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return fallback;
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function resolveTimezoneFallback(cfg: OpenClawConfig | undefined): string | undefined {
  const agents = asRecord(cfg?.agents);
  const defaults = asRecord(agents?.defaults);
  return normalizeTrimmedString(defaults?.userTimezone);
}

function formatRepairSummary(repair: {
  rewroteStore: boolean;
  removedInvalidEntries: number;
  removedStaleLock: boolean;
}): string {
  const actions: string[] = [];
  if (repair.rewroteStore) {
    actions.push(
      `rewrote recall store${repair.removedInvalidEntries > 0 ? ` (-${repair.removedInvalidEntries} invalid)` : ""}`,
    );
  }
  if (repair.removedStaleLock) {
    actions.push("removed stale promotion lock");
  }
  return actions.join(", ");
}

function resolveManagedCronDescription(config: ShortTermPromotionDreamingConfig): string {
  return `${MANAGED_DREAMING_CRON_TAG} Promote weighted short-term recalls into MEMORY.md (limit=${config.limit}, minScore=${config.minScore.toFixed(3)}, minRecallCount=${config.minRecallCount}, minUniqueQueries=${config.minUniqueQueries}).`;
}

function buildManagedDreamingCronJob(
  config: ShortTermPromotionDreamingConfig,
): ManagedCronJobCreate {
  return {
    name: MANAGED_DREAMING_CRON_NAME,
    description: resolveManagedCronDescription(config),
    enabled: true,
    schedule: {
      kind: "cron",
      expr: config.cron,
      ...(config.timezone ? { tz: config.timezone } : {}),
    },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "systemEvent",
      text: DREAMING_SYSTEM_EVENT_TEXT,
    },
  };
}

function isManagedDreamingJob(job: ManagedCronJobLike): boolean {
  const description = normalizeTrimmedString(job.description);
  if (description?.includes(MANAGED_DREAMING_CRON_TAG)) {
    return true;
  }
  const name = normalizeTrimmedString(job.name);
  const payloadText = normalizeTrimmedString(job.payload?.text);
  return name === MANAGED_DREAMING_CRON_NAME && payloadText === DREAMING_SYSTEM_EVENT_TEXT;
}

function compareOptionalStrings(a: string | undefined, b: string | undefined): boolean {
  return a === b;
}

function buildManagedDreamingPatch(
  job: ManagedCronJobLike,
  desired: ManagedCronJobCreate,
): ManagedCronJobPatch | null {
  const patch: ManagedCronJobPatch = {};

  if (!compareOptionalStrings(normalizeTrimmedString(job.name), desired.name)) {
    patch.name = desired.name;
  }
  if (!compareOptionalStrings(normalizeTrimmedString(job.description), desired.description)) {
    patch.description = desired.description;
  }
  if (job.enabled !== true) {
    patch.enabled = true;
  }

  const scheduleKind = normalizeTrimmedString(job.schedule?.kind)?.toLowerCase();
  const scheduleExpr = normalizeTrimmedString(job.schedule?.expr);
  const scheduleTz = normalizeTrimmedString(job.schedule?.tz);
  if (
    scheduleKind !== "cron" ||
    !compareOptionalStrings(scheduleExpr, desired.schedule.expr) ||
    !compareOptionalStrings(scheduleTz, desired.schedule.tz)
  ) {
    patch.schedule = desired.schedule;
  }

  const sessionTarget = normalizeTrimmedString(job.sessionTarget)?.toLowerCase();
  if (sessionTarget !== "main") {
    patch.sessionTarget = "main";
  }
  const wakeMode = normalizeTrimmedString(job.wakeMode)?.toLowerCase();
  if (wakeMode !== "next-heartbeat") {
    patch.wakeMode = "next-heartbeat";
  }

  const payloadKind = normalizeTrimmedString(job.payload?.kind)?.toLowerCase();
  const payloadText = normalizeTrimmedString(job.payload?.text);
  if (payloadKind !== "systemevent" || !compareOptionalStrings(payloadText, desired.payload.text)) {
    patch.payload = desired.payload;
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

function resolveCronServiceFromStartupEvent(event: unknown): CronServiceLike | null {
  const payload = asRecord(event);
  if (!payload) {
    return null;
  }
  if (payload.type !== "gateway" || payload.action !== "startup") {
    return null;
  }
  const context = asRecord(payload.context);
  const deps = asRecord(context?.deps);
  const cronCandidate = context?.cron ?? deps?.cron;
  if (!cronCandidate || typeof cronCandidate !== "object") {
    return null;
  }
  const cron = cronCandidate as Partial<CronServiceLike>;
  if (
    typeof cron.list !== "function" ||
    typeof cron.add !== "function" ||
    typeof cron.update !== "function" ||
    typeof cron.remove !== "function"
  ) {
    return null;
  }
  return cron as CronServiceLike;
}

export function resolveShortTermPromotionDreamingConfig(params: {
  pluginConfig?: Record<string, unknown>;
  cfg?: OpenClawConfig;
}): ShortTermPromotionDreamingConfig {
  const dreaming = asRecord(params.pluginConfig?.dreaming);
  const mode = normalizeDreamingMode(dreaming?.mode);
  const enabled = mode !== "off";
  const thresholdPreset: DreamingPreset = mode === "off" ? DEFAULT_DREAMING_PRESET : mode;
  const thresholdDefaults = DREAMING_PRESET_DEFAULTS[thresholdPreset];
  const cron =
    normalizeTrimmedString(dreaming?.cron) ??
    normalizeTrimmedString(dreaming?.frequency) ??
    thresholdDefaults.cron;
  const timezone =
    normalizeTrimmedString(dreaming?.timezone) ?? resolveTimezoneFallback(params.cfg);
  const limit = normalizeNonNegativeInt(dreaming?.limit, thresholdDefaults.limit);
  const minScore = normalizeScore(dreaming?.minScore, thresholdDefaults.minScore);
  const minRecallCount = normalizeNonNegativeInt(
    dreaming?.minRecallCount,
    thresholdDefaults.minRecallCount,
  );
  const minUniqueQueries = normalizeNonNegativeInt(
    dreaming?.minUniqueQueries,
    thresholdDefaults.minUniqueQueries,
  );

  return {
    enabled,
    cron,
    ...(timezone ? { timezone } : {}),
    limit,
    minScore,
    minRecallCount,
    minUniqueQueries,
    verboseLogging: normalizeBoolean(dreaming?.verboseLogging, false),
  };
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

  if (!params.config.enabled) {
    let removed = 0;
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
    if (removed > 0) {
      params.logger.info(`memory-core: removed ${removed} managed dreaming cron job(s).`);
    }
    return { status: "disabled", removed };
  }

  const desired = buildManagedDreamingCronJob(params.config);
  if (managed.length === 0) {
    await cron.add(desired);
    params.logger.info("memory-core: created managed dreaming cron job.");
    return { status: "added", removed: 0 };
  }

  const [primary, ...duplicates] = sortManagedJobs(managed);
  let removed = 0;
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

export async function runShortTermDreamingPromotionIfTriggered(params: {
  cleanedBody: string;
  trigger?: string;
  workspaceDir?: string;
  config: ShortTermPromotionDreamingConfig;
  logger: Logger;
}): Promise<{ handled: true; reason: string } | undefined> {
  if (params.trigger !== "heartbeat") {
    return undefined;
  }
  if (params.cleanedBody.trim() !== DREAMING_SYSTEM_EVENT_TEXT) {
    return undefined;
  }
  if (!params.config.enabled) {
    return { handled: true, reason: "memory-core: short-term dreaming disabled" };
  }

  const workspaceDir = normalizeTrimmedString(params.workspaceDir);
  if (!workspaceDir) {
    params.logger.warn(
      "memory-core: dreaming promotion skipped because workspaceDir is unavailable.",
    );
    return { handled: true, reason: "memory-core: short-term dreaming missing workspace" };
  }
  if (params.config.limit === 0) {
    params.logger.info("memory-core: dreaming promotion skipped because limit=0.");
    return { handled: true, reason: "memory-core: short-term dreaming disabled by limit" };
  }

  try {
    if (params.config.verboseLogging) {
      params.logger.info(
        `memory-core: dreaming verbose enabled (cron=${params.config.cron}, limit=${params.config.limit}, minScore=${params.config.minScore.toFixed(3)}, minRecallCount=${params.config.minRecallCount}, minUniqueQueries=${params.config.minUniqueQueries}).`,
      );
    }
    const repair = await repairShortTermPromotionArtifacts({ workspaceDir });
    if (repair.changed) {
      params.logger.info(
        `memory-core: normalized recall artifacts before dreaming (${formatRepairSummary(repair)}).`,
      );
    }
    const candidates = await rankShortTermPromotionCandidates({
      workspaceDir,
      limit: params.config.limit,
      minScore: params.config.minScore,
      minRecallCount: params.config.minRecallCount,
      minUniqueQueries: params.config.minUniqueQueries,
    });
    if (params.config.verboseLogging) {
      const candidateSummary =
        candidates.length > 0
          ? candidates
              .map(
                (candidate) =>
                  `${candidate.path}:${candidate.startLine}-${candidate.endLine} score=${candidate.score.toFixed(3)} recalls=${candidate.recallCount} queries=${candidate.uniqueQueries} components={freq=${candidate.components.frequency.toFixed(3)},rel=${candidate.components.relevance.toFixed(3)},div=${candidate.components.diversity.toFixed(3)},rec=${candidate.components.recency.toFixed(3)},cons=${candidate.components.consolidation.toFixed(3)},concept=${candidate.components.conceptual.toFixed(3)}}`,
              )
              .join(" | ")
          : "none";
      params.logger.info(`memory-core: dreaming candidate details ${candidateSummary}`);
    }
    const applied = await applyShortTermPromotions({
      workspaceDir,
      candidates,
      limit: params.config.limit,
      minScore: params.config.minScore,
      minRecallCount: params.config.minRecallCount,
      minUniqueQueries: params.config.minUniqueQueries,
    });
    if (params.config.verboseLogging) {
      const appliedSummary =
        applied.appliedCandidates.length > 0
          ? applied.appliedCandidates
              .map(
                (candidate) =>
                  `${candidate.path}:${candidate.startLine}-${candidate.endLine} score=${candidate.score.toFixed(3)} recalls=${candidate.recallCount}`,
              )
              .join(" | ")
          : "none";
      params.logger.info(`memory-core: dreaming applied details ${appliedSummary}`);
    }
    params.logger.info(
      `memory-core: dreaming promotion complete (candidates=${candidates.length}, applied=${applied.applied}).`,
    );
  } catch (err) {
    params.logger.error(`memory-core: dreaming promotion failed: ${formatErrorMessage(err)}`);
  }

  return { handled: true, reason: "memory-core: short-term dreaming processed" };
}

export function registerShortTermPromotionDreaming(api: OpenClawPluginApi): void {
  api.registerHook(
    "gateway:startup",
    async (event: unknown) => {
      try {
        const config = resolveShortTermPromotionDreamingConfig({
          pluginConfig: api.pluginConfig,
          cfg: api.config,
        });
        const cron = resolveCronServiceFromStartupEvent(event);
        if (!cron && config.enabled) {
          api.logger.warn(
            "memory-core: managed dreaming cron could not be reconciled (cron service unavailable).",
          );
        }
        await reconcileShortTermDreamingCronJob({
          cron,
          config,
          logger: api.logger,
        });
      } catch (err) {
        api.logger.error(
          `memory-core: dreaming startup reconciliation failed: ${formatErrorMessage(err)}`,
        );
      }
    },
    { name: "memory-core-short-term-dreaming-cron" },
  );

  api.on("before_agent_reply", async (event, ctx) => {
    try {
      const config = resolveShortTermPromotionDreamingConfig({
        pluginConfig: api.pluginConfig,
        cfg: api.config,
      });
      return await runShortTermDreamingPromotionIfTriggered({
        cleanedBody: event.cleanedBody,
        trigger: ctx.trigger,
        workspaceDir: ctx.workspaceDir,
        config,
        logger: api.logger,
      });
    } catch (err) {
      api.logger.error(`memory-core: dreaming trigger failed: ${formatErrorMessage(err)}`);
      return undefined;
    }
  });
}

export const __testing = {
  buildManagedDreamingCronJob,
  buildManagedDreamingPatch,
  isManagedDreamingJob,
  resolveCronServiceFromStartupEvent,
  constants: {
    MANAGED_DREAMING_CRON_NAME,
    MANAGED_DREAMING_CRON_TAG,
    DREAMING_SYSTEM_EVENT_TEXT,
    DEFAULT_DREAMING_MODE,
    DEFAULT_DREAMING_PRESET,
    DEFAULT_DREAMING_CRON_EXPR,
    DEFAULT_DREAMING_LIMIT,
    DEFAULT_DREAMING_MIN_SCORE,
    DEFAULT_DREAMING_MIN_RECALL_COUNT,
    DEFAULT_DREAMING_MIN_UNIQUE_QUERIES,
    DREAMING_PRESET_DEFAULTS,
  },
};
