import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/memory-core";
import {
  resolveMemoryCorePluginConfig,
  resolveMemoryLightDreamingConfig,
  resolveMemoryRemDreamingConfig,
  resolveMemoryDreamingWorkspaces,
  type MemoryLightDreamingConfig,
  type MemoryRemDreamingConfig,
  type MemoryDreamingPhaseName,
} from "openclaw/plugin-sdk/memory-core-host-status";
import { writeDailyDreamingPhaseBlock } from "./dreaming-markdown.js";
import { readShortTermRecallEntries, type ShortTermRecallEntry } from "./short-term-promotion.js";

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

const LIGHT_SLEEP_CRON_NAME = "Memory Light Dreaming";
const LIGHT_SLEEP_CRON_TAG = "[managed-by=memory-core.dreaming.light]";
const LIGHT_SLEEP_EVENT_TEXT = "__openclaw_memory_core_light_sleep__";

const REM_SLEEP_CRON_NAME = "Memory REM Dreaming";
const REM_SLEEP_CRON_TAG = "[managed-by=memory-core.dreaming.rem]";
const REM_SLEEP_EVENT_TEXT = "__openclaw_memory_core_rem_sleep__";

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

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function buildCronDescription(params: {
  tag: string;
  phase: "light" | "rem";
  cron: string;
  limit: number;
  lookbackDays: number;
}): string {
  return `${params.tag} Run ${params.phase} dreaming (cron=${params.cron}, limit=${params.limit}, lookbackDays=${params.lookbackDays}).`;
}

function buildManagedCronJob(params: {
  name: string;
  tag: string;
  payloadText: string;
  cron: string;
  timezone?: string;
  phase: "light" | "rem";
  limit: number;
  lookbackDays: number;
}): ManagedCronJobCreate {
  return {
    name: params.name,
    description: buildCronDescription({
      tag: params.tag,
      phase: params.phase,
      cron: params.cron,
      limit: params.limit,
      lookbackDays: params.lookbackDays,
    }),
    enabled: true,
    schedule: {
      kind: "cron",
      expr: params.cron,
      ...(params.timezone ? { tz: params.timezone } : {}),
    },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "systemEvent",
      text: params.payloadText,
    },
  };
}

function isManagedPhaseJob(
  job: ManagedCronJobLike,
  params: {
    name: string;
    tag: string;
    payloadText: string;
  },
): boolean {
  const description = normalizeTrimmedString(job.description);
  if (description?.includes(params.tag)) {
    return true;
  }
  const name = normalizeTrimmedString(job.name);
  const payloadText = normalizeTrimmedString(job.payload?.text);
  return name === params.name && payloadText === params.payloadText;
}

function buildManagedPhasePatch(
  job: ManagedCronJobLike,
  desired: ManagedCronJobCreate,
): ManagedCronJobPatch | null {
  const patch: ManagedCronJobPatch = {};
  const scheduleKind = normalizeTrimmedString(job.schedule?.kind)?.toLowerCase();
  const scheduleExpr = normalizeTrimmedString(job.schedule?.expr);
  const scheduleTz = normalizeTrimmedString(job.schedule?.tz);
  if (normalizeTrimmedString(job.name) !== desired.name) {
    patch.name = desired.name;
  }
  if (normalizeTrimmedString(job.description) !== desired.description) {
    patch.description = desired.description;
  }
  if (job.enabled !== true) {
    patch.enabled = true;
  }
  if (
    scheduleKind !== "cron" ||
    scheduleExpr !== desired.schedule.expr ||
    scheduleTz !== desired.schedule.tz
  ) {
    patch.schedule = desired.schedule;
  }
  if (normalizeTrimmedString(job.sessionTarget)?.toLowerCase() !== "main") {
    patch.sessionTarget = "main";
  }
  if (normalizeTrimmedString(job.wakeMode)?.toLowerCase() !== "next-heartbeat") {
    patch.wakeMode = "next-heartbeat";
  }
  const payloadKind = normalizeTrimmedString(job.payload?.kind)?.toLowerCase();
  const payloadText = normalizeTrimmedString(job.payload?.text);
  if (payloadKind !== "systemevent" || payloadText !== desired.payload.text) {
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
  if (!payload || payload.type !== "gateway" || payload.action !== "startup") {
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

async function reconcileManagedPhaseCronJob(params: {
  cron: CronServiceLike | null;
  desired: ManagedCronJobCreate;
  match: { name: string; tag: string; payloadText: string };
  enabled: boolean;
  logger: Logger;
}): Promise<void> {
  const cron = params.cron;
  if (!cron) {
    return;
  }
  const allJobs = await cron.list({ includeDisabled: true });
  const managed = allJobs.filter((job) => isManagedPhaseJob(job, params.match));
  if (!params.enabled) {
    for (const job of managed) {
      try {
        await cron.remove(job.id);
      } catch (err) {
        params.logger.warn(
          `memory-core: failed to remove managed ${params.match.name} cron job ${job.id}: ${formatErrorMessage(err)}`,
        );
      }
    }
    return;
  }

  if (managed.length === 0) {
    await cron.add(params.desired);
    return;
  }

  const [primary, ...duplicates] = sortManagedJobs(managed);
  for (const duplicate of duplicates) {
    try {
      await cron.remove(duplicate.id);
    } catch (err) {
      params.logger.warn(
        `memory-core: failed to prune duplicate managed ${params.match.name} cron job ${duplicate.id}: ${formatErrorMessage(err)}`,
      );
    }
  }

  const patch = buildManagedPhasePatch(primary, params.desired);
  if (patch) {
    await cron.update(primary.id, patch);
  }
}

function resolveWorkspaces(params: {
  cfg?: OpenClawConfig;
  fallbackWorkspaceDir?: string;
}): string[] {
  const workspaceCandidates = params.cfg
    ? resolveMemoryDreamingWorkspaces(params.cfg).map((entry) => entry.workspaceDir)
    : [];
  const seen = new Set<string>();
  const workspaces = workspaceCandidates.filter((workspaceDir) => {
    if (seen.has(workspaceDir)) {
      return false;
    }
    seen.add(workspaceDir);
    return true;
  });
  const fallbackWorkspaceDir = normalizeTrimmedString(params.fallbackWorkspaceDir);
  if (workspaces.length === 0 && fallbackWorkspaceDir) {
    workspaces.push(fallbackWorkspaceDir);
  }
  return workspaces;
}

function calculateLookbackCutoffMs(nowMs: number, lookbackDays: number): number {
  return nowMs - Math.max(0, lookbackDays) * 24 * 60 * 60 * 1000;
}

function entryAverageScore(entry: ShortTermRecallEntry): number {
  return entry.recallCount > 0 ? Math.max(0, Math.min(1, entry.totalScore / entry.recallCount)) : 0;
}

function tokenizeSnippet(snippet: string): Set<string> {
  return new Set(
    snippet
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .map((token) => token.trim())
      .filter(Boolean),
  );
}

function jaccardSimilarity(left: string, right: string): number {
  const leftTokens = tokenizeSnippet(left);
  const rightTokens = tokenizeSnippet(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return left.trim().toLowerCase() === right.trim().toLowerCase() ? 1 : 0;
  }
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union > 0 ? intersection / union : 0;
}

function dedupeEntries(entries: ShortTermRecallEntry[], threshold: number): ShortTermRecallEntry[] {
  const deduped: ShortTermRecallEntry[] = [];
  for (const entry of entries) {
    const duplicate = deduped.find(
      (candidate) =>
        candidate.path === entry.path &&
        jaccardSimilarity(candidate.snippet, entry.snippet) >= threshold,
    );
    if (duplicate) {
      if (entry.recallCount > duplicate.recallCount) {
        duplicate.recallCount = entry.recallCount;
      }
      duplicate.totalScore = Math.max(duplicate.totalScore, entry.totalScore);
      duplicate.maxScore = Math.max(duplicate.maxScore, entry.maxScore);
      duplicate.queryHashes = [...new Set([...duplicate.queryHashes, ...entry.queryHashes])];
      duplicate.recallDays = [
        ...new Set([...duplicate.recallDays, ...entry.recallDays]),
      ].toSorted();
      duplicate.conceptTags = [...new Set([...duplicate.conceptTags, ...entry.conceptTags])];
      duplicate.lastRecalledAt =
        Date.parse(entry.lastRecalledAt) > Date.parse(duplicate.lastRecalledAt)
          ? entry.lastRecalledAt
          : duplicate.lastRecalledAt;
      continue;
    }
    deduped.push({ ...entry });
  }
  return deduped;
}

function buildLightDreamingBody(entries: ShortTermRecallEntry[]): string[] {
  if (entries.length === 0) {
    return ["- No notable updates."];
  }
  const lines: string[] = [];
  for (const entry of entries) {
    const snippet = entry.snippet || "(no snippet captured)";
    lines.push(`- Candidate: ${snippet}`);
    lines.push(`  - confidence: ${entryAverageScore(entry).toFixed(2)}`);
    lines.push(`  - evidence: ${entry.path}:${entry.startLine}-${entry.endLine}`);
    lines.push(`  - recalls: ${entry.recallCount}`);
    lines.push(`  - status: staged`);
  }
  return lines;
}

function buildRemDreamingBody(
  entries: ShortTermRecallEntry[],
  limit: number,
  minPatternStrength: number,
): string[] {
  const tagStats = new Map<string, { count: number; evidence: Set<string> }>();
  for (const entry of entries) {
    for (const tag of entry.conceptTags) {
      if (!tag) {
        continue;
      }
      const stat = tagStats.get(tag) ?? { count: 0, evidence: new Set<string>() };
      stat.count += 1;
      stat.evidence.add(`${entry.path}:${entry.startLine}-${entry.endLine}`);
      tagStats.set(tag, stat);
    }
  }

  const ranked = [...tagStats.entries()]
    .map(([tag, stat]) => {
      const strength = Math.min(1, (stat.count / Math.max(1, entries.length)) * 2);
      return { tag, strength, stat };
    })
    .filter((entry) => entry.strength >= minPatternStrength)
    .toSorted(
      (a, b) =>
        b.strength - a.strength || b.stat.count - a.stat.count || a.tag.localeCompare(b.tag),
    )
    .slice(0, limit);

  if (ranked.length === 0) {
    return ["- No strong patterns surfaced."];
  }

  const lines: string[] = [];
  for (const entry of ranked) {
    lines.push(`- Theme: \`${entry.tag}\` kept surfacing across ${entry.stat.count} memories.`);
    lines.push(`  - confidence: ${entry.strength.toFixed(2)}`);
    lines.push(`  - evidence: ${[...entry.stat.evidence].slice(0, 3).join(", ")}`);
    lines.push(`  - note: reflection`);
  }
  return lines;
}

async function runLightDreaming(params: {
  workspaceDir: string;
  config: MemoryLightDreamingConfig & {
    timezone?: string;
    storage: { mode: "inline" | "separate" | "both"; separateReports: boolean };
  };
  logger: Logger;
  nowMs?: number;
}): Promise<void> {
  const nowMs = Number.isFinite(params.nowMs) ? (params.nowMs as number) : Date.now();
  const cutoffMs = calculateLookbackCutoffMs(nowMs, params.config.lookbackDays);
  const entries = dedupeEntries(
    (await readShortTermRecallEntries({ workspaceDir: params.workspaceDir, nowMs }))
      .filter((entry) => Date.parse(entry.lastRecalledAt) >= cutoffMs)
      .toSorted((a, b) => {
        const byTime = Date.parse(b.lastRecalledAt) - Date.parse(a.lastRecalledAt);
        if (byTime !== 0) {
          return byTime;
        }
        return b.recallCount - a.recallCount;
      })
      .slice(0, params.config.limit),
    params.config.dedupeSimilarity,
  );
  const bodyLines = buildLightDreamingBody(entries.slice(0, params.config.limit));
  await writeDailyDreamingPhaseBlock({
    workspaceDir: params.workspaceDir,
    phase: "light",
    bodyLines,
    nowMs,
    timezone: params.config.timezone,
    storage: params.config.storage,
  });
  if (params.config.enabled && entries.length > 0 && params.config.storage.mode !== "separate") {
    params.logger.info(
      `memory-core: light dreaming staged ${Math.min(entries.length, params.config.limit)} candidate(s) [workspace=${params.workspaceDir}].`,
    );
  }
}

async function runRemDreaming(params: {
  workspaceDir: string;
  config: MemoryRemDreamingConfig & {
    timezone?: string;
    storage: { mode: "inline" | "separate" | "both"; separateReports: boolean };
  };
  logger: Logger;
  nowMs?: number;
}): Promise<void> {
  const nowMs = Number.isFinite(params.nowMs) ? (params.nowMs as number) : Date.now();
  const cutoffMs = calculateLookbackCutoffMs(nowMs, params.config.lookbackDays);
  const entries = (
    await readShortTermRecallEntries({ workspaceDir: params.workspaceDir, nowMs })
  ).filter((entry) => Date.parse(entry.lastRecalledAt) >= cutoffMs);
  const bodyLines = buildRemDreamingBody(
    entries,
    params.config.limit,
    params.config.minPatternStrength,
  );
  await writeDailyDreamingPhaseBlock({
    workspaceDir: params.workspaceDir,
    phase: "rem",
    bodyLines,
    nowMs,
    timezone: params.config.timezone,
    storage: params.config.storage,
  });
  if (params.config.enabled && entries.length > 0 && params.config.storage.mode !== "separate") {
    params.logger.info(
      `memory-core: REM dreaming wrote reflections from ${entries.length} recent memory trace(s) [workspace=${params.workspaceDir}].`,
    );
  }
}

async function runPhaseIfTriggered(params: {
  cleanedBody: string;
  trigger?: string;
  workspaceDir?: string;
  cfg?: OpenClawConfig;
  logger: Logger;
  phase: "light" | "rem";
  eventText: string;
  config:
    | (MemoryLightDreamingConfig & {
        timezone?: string;
        storage: { mode: "inline" | "separate" | "both"; separateReports: boolean };
      })
    | (MemoryRemDreamingConfig & {
        timezone?: string;
        storage: { mode: "inline" | "separate" | "both"; separateReports: boolean };
      });
}): Promise<{ handled: true; reason: string } | undefined> {
  if (params.trigger !== "heartbeat" || params.cleanedBody.trim() !== params.eventText) {
    return undefined;
  }
  if (!params.config.enabled) {
    return { handled: true, reason: `memory-core: ${params.phase} dreaming disabled` };
  }
  const workspaces = resolveWorkspaces({
    cfg: params.cfg,
    fallbackWorkspaceDir: params.workspaceDir,
  });
  if (workspaces.length === 0) {
    params.logger.warn(
      `memory-core: ${params.phase} dreaming skipped because no memory workspace is available.`,
    );
    return { handled: true, reason: `memory-core: ${params.phase} dreaming missing workspace` };
  }
  if (params.config.limit === 0) {
    params.logger.info(`memory-core: ${params.phase} dreaming skipped because limit=0.`);
    return { handled: true, reason: `memory-core: ${params.phase} dreaming disabled by limit` };
  }
  for (const workspaceDir of workspaces) {
    try {
      if (params.phase === "light") {
        await runLightDreaming({
          workspaceDir,
          config: params.config as MemoryLightDreamingConfig & {
            timezone?: string;
            storage: { mode: "inline" | "separate" | "both"; separateReports: boolean };
          },
          logger: params.logger,
        });
      } else {
        await runRemDreaming({
          workspaceDir,
          config: params.config as MemoryRemDreamingConfig & {
            timezone?: string;
            storage: { mode: "inline" | "separate" | "both"; separateReports: boolean };
          },
          logger: params.logger,
        });
      }
    } catch (err) {
      params.logger.error(
        `memory-core: ${params.phase} dreaming failed for workspace ${workspaceDir}: ${formatErrorMessage(err)}`,
      );
    }
  }
  return { handled: true, reason: `memory-core: ${params.phase} dreaming processed` };
}

export function registerMemoryDreamingPhases(api: OpenClawPluginApi): void {
  api.registerHook(
    "gateway:startup",
    async (event: unknown) => {
      const cron = resolveCronServiceFromStartupEvent(event);
      const pluginConfig = resolveMemoryCorePluginConfig(api.config) ?? api.pluginConfig;
      const light = resolveMemoryLightDreamingConfig({ pluginConfig, cfg: api.config });
      const rem = resolveMemoryRemDreamingConfig({ pluginConfig, cfg: api.config });
      const lightDesired = buildManagedCronJob({
        name: LIGHT_SLEEP_CRON_NAME,
        tag: LIGHT_SLEEP_CRON_TAG,
        payloadText: LIGHT_SLEEP_EVENT_TEXT,
        cron: light.cron,
        timezone: light.timezone,
        phase: "light",
        limit: light.limit,
        lookbackDays: light.lookbackDays,
      });
      const remDesired = buildManagedCronJob({
        name: REM_SLEEP_CRON_NAME,
        tag: REM_SLEEP_CRON_TAG,
        payloadText: REM_SLEEP_EVENT_TEXT,
        cron: rem.cron,
        timezone: rem.timezone,
        phase: "rem",
        limit: rem.limit,
        lookbackDays: rem.lookbackDays,
      });
      try {
        await reconcileManagedPhaseCronJob({
          cron,
          desired: lightDesired,
          match: {
            name: LIGHT_SLEEP_CRON_NAME,
            tag: LIGHT_SLEEP_CRON_TAG,
            payloadText: LIGHT_SLEEP_EVENT_TEXT,
          },
          enabled: light.enabled,
          logger: api.logger,
        });
        await reconcileManagedPhaseCronJob({
          cron,
          desired: remDesired,
          match: {
            name: REM_SLEEP_CRON_NAME,
            tag: REM_SLEEP_CRON_TAG,
            payloadText: REM_SLEEP_EVENT_TEXT,
          },
          enabled: rem.enabled,
          logger: api.logger,
        });
      } catch (err) {
        api.logger.error(
          `memory-core: dreaming startup reconciliation failed: ${formatErrorMessage(err)}`,
        );
      }
    },
    { name: "memory-core-dreaming-phase-cron" },
  );

  api.on("before_agent_reply", async (event, ctx) => {
    const pluginConfig = resolveMemoryCorePluginConfig(api.config) ?? api.pluginConfig;
    const light = resolveMemoryLightDreamingConfig({ pluginConfig, cfg: api.config });
    const lightResult = await runPhaseIfTriggered({
      cleanedBody: event.cleanedBody,
      trigger: ctx.trigger,
      workspaceDir: ctx.workspaceDir,
      cfg: api.config,
      logger: api.logger,
      phase: "light",
      eventText: LIGHT_SLEEP_EVENT_TEXT,
      config: light,
    });
    if (lightResult) {
      return lightResult;
    }
    const rem = resolveMemoryRemDreamingConfig({ pluginConfig, cfg: api.config });
    return await runPhaseIfTriggered({
      cleanedBody: event.cleanedBody,
      trigger: ctx.trigger,
      workspaceDir: ctx.workspaceDir,
      cfg: api.config,
      logger: api.logger,
      phase: "rem",
      eventText: REM_SLEEP_EVENT_TEXT,
      config: rem,
    });
  });
}
