import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import type { OpenClawConfig } from "../api.js";
import type { ResolvedBookWriterConfig } from "./config.js";
import { ensureRunDir, resolveRunPaths, writeJsonFile } from "./files.js";
import { normalizeKdpCoverStrategy, prepareKdpDryRun } from "./kdp-dry-run.js";
import { runLiveModelBench } from "./model-bench.js";
import {
  DEFAULT_MODEL_CATALOG,
  estimateBookEndurance,
  estimateSchedule,
  evaluateModelEligibility,
  memoryCapForMode,
  persistBenchRecord,
  readBenchRecords,
  selectBestModel,
} from "./model-governor.js";
import { runOvernightBookWriter } from "./overnight.js";
import { normalizeMode, runBookWriterPipeline } from "./pipeline.js";
import {
  buildBookPlanQualityReport,
  createAndSaveBookPlan,
  createQuickReadAndSave,
  draftAndSaveBookPlan,
  propagateAndSaveStoryImpact,
  readBookPlan,
  saveBookPlan,
  stitchAndSaveBookPlan,
} from "./planning.js";
import { installBookWriterSchedule, runBookWriterSchedulerTick } from "./scheduler.js";
import type { BookPlan, BookWriterRequest, ModelBenchRecord } from "./types.js";

type CommonOptions = {
  json?: boolean;
  outputDir?: string;
  runId?: string;
  topic?: string;
  genre?: string;
  penName?: string;
  targetWords?: string;
  mode?: string;
  model?: string;
  liveModel?: boolean;
  offlineModel?: boolean;
};

type BenchOptions = {
  json?: boolean;
  outputDir?: string;
  model?: string;
  provider?: string;
  measuredPeakGb?: string;
  tokensPerSecond?: string;
  stableContextTokens?: string;
  crashRate?: string;
  qualityScore?: string;
  live?: boolean;
  baseUrl?: string;
  prompt?: string;
  maxTokens?: string;
  recordUnavailable?: boolean;
};

type PublishDryRunOptions = {
  json?: boolean;
  outputDir?: string;
  runId: string;
  allowRevise?: boolean;
  coverStrategy?: string;
};

type OvernightRunOptions = CommonOptions & {
  allowEstimated?: boolean;
  force?: boolean;
  dryRun?: boolean;
  publishPrep?: boolean;
};

type ScheduleInstallCliOptions = OvernightRunOptions & {
  cron?: string;
  timezone?: string;
  installSystemCron?: boolean;
  registerGatewayCron?: boolean;
  gatewayCronDryRun?: boolean;
  gatewayCronJobName?: string;
  openclawCommand?: string;
  enableAutonomousWriting?: boolean;
};

type SchedulerTickCliOptions = OvernightRunOptions & {
  lockTtlMinutes?: string;
  missedAfterHours?: string;
  enableAutonomousWriting?: boolean;
};

type PlanningCreateOptions = CommonOptions & {
  fromJson?: string;
  sourceRunId?: string;
};

function withOutputDir(
  config: ResolvedBookWriterConfig,
  outputDir?: string,
): ResolvedBookWriterConfig {
  return outputDir ? { ...config, outputDir } : config;
}

function writeCliOutput(value: unknown, json?: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (typeof value === "string") {
    process.stdout.write(`${value}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function requestFromOptions(options: CommonOptions): BookWriterRequest {
  return {
    runId: options.runId,
    topic: options.topic,
    genre: options.genre,
    penName: options.penName,
    targetWords: options.targetWords ? Number(options.targetWords) : undefined,
    mode: normalizeMode(options.mode),
    model: options.model,
    liveModel: options.offlineModel ? false : options.liveModel,
  };
}

async function runReviewCommand(
  config: ResolvedBookWriterConfig,
  options: CommonOptions,
  stage: "plan" | "write" | "gate" | "package" | "review-pack",
): Promise<void> {
  const review = await runBookWriterPipeline({
    config: withOutputDir(config, options.outputDir),
    request: requestFromOptions(options),
    stages: stage,
  });
  writeCliOutput(review, options.json);
}

function addCommonOptions(command: Command): Command {
  return command
    .option("--json", "Print JSON output")
    .option("--output-dir <dir>", "Override book-writer output directory")
    .option("--run-id <id>", "Resume or target a run id")
    .option("--topic <text>", "Book topic or premise")
    .option("--genre <genre>", "Book genre lane")
    .option("--pen-name <name>", "Pen name brand")
    .option("--target-words <count>", "Target manuscript word count")
    .option("--mode <mode>", "Memory mode: light, normal, ideal, premium")
    .option("--model <model>", "Preferred model id")
    .option("--live-model", "Attempt live LM Studio generation")
    .option("--offline-model", "Use deterministic offline drafting");
}

export function registerBookWriterCli(
  program: Command,
  config: ResolvedBookWriterConfig,
  _appConfig?: OpenClawConfig,
): void {
  const books = program.command("books").description("Create original review-ready book packages");

  books
    .command("init")
    .description("Initialize the book-writer artifact directory")
    .option("--json", "Print JSON output")
    .option("--output-dir <dir>", "Override book-writer output directory")
    .action(async (options: { json?: boolean; outputDir?: string }) => {
      const resolved = withOutputDir(config, options.outputDir);
      const paths = resolveRunPaths(resolved.outputDir, "init-check");
      await ensureRunDir(paths);
      const configPath = path.join(resolved.outputDir, "book-writer-config.example.json");
      await writeJsonFile(configPath, {
        localProvider: resolved.localProvider,
        localModel: resolved.localModel,
        localBaseUrl: resolved.localBaseUrl,
        memoryPolicy: resolved.memoryPolicy,
        schedule: resolved.schedule,
        publishing: resolved.publishing,
        qualityThresholds: resolved.qualityThresholds,
        penNames: resolved.penNames,
      });
      writeCliOutput({ ok: true, outputDir: resolved.outputDir, configPath }, options.json);
    });

  books
    .command("model-bench")
    .description("Record or inspect local model benchmark facts")
    .option("--json", "Print JSON output")
    .option("--output-dir <dir>", "Override book-writer output directory")
    .option("--model <model>", "Model id to record")
    .option("--provider <provider>", "Provider id")
    .option("--measured-peak-gb <gb>", "Measured peak resident memory in GB")
    .option("--tokens-per-second <rate>", "Measured tokens/sec")
    .option("--stable-context-tokens <tokens>", "Max stable context tokens")
    .option("--crash-rate <rate>", "Crash rate from benchmark attempts")
    .option("--quality-score <score>", "Sample quality score from 0 to 1")
    .option("--live", "Run a live OpenAI-compatible local model benchmark")
    .option("--base-url <url>", "Override local provider base URL for live benchmark")
    .option("--prompt <text>", "Override live benchmark prompt")
    .option("--max-tokens <tokens>", "Max completion tokens for live benchmark")
    .option("--record-unavailable", "Persist unavailable live benchmark results")
    .action(async (options: BenchOptions) => {
      const resolved = withOutputDir(config, options.outputDir);
      await fs.mkdir(resolved.outputDir, { recursive: true });
      if (options.model) {
        if (options.live) {
          const record = await runLiveModelBench({
            config: resolved,
            model: options.model,
            provider: options.provider,
            baseUrl: options.baseUrl,
            prompt: options.prompt,
            maxTokens: options.maxTokens ? Number(options.maxTokens) : undefined,
            stableContextTokens: options.stableContextTokens
              ? Number(options.stableContextTokens)
              : undefined,
            qualityScore: options.qualityScore ? Number(options.qualityScore) : undefined,
          });
          const shouldPersist = record.source === "measured" || options.recordUnavailable;
          const records = shouldPersist
            ? await persistBenchRecord(resolved.outputDir, record)
            : await readBenchRecords(resolved.outputDir);
          writeCliOutput(
            {
              ok: record.source === "measured",
              persisted: shouldPersist,
              record,
              count: records.length,
            },
            options.json,
          );
          return;
        }
        const defaults =
          DEFAULT_MODEL_CATALOG.find((record) => record.model === options.model) ??
          DEFAULT_MODEL_CATALOG[0];
        const record: ModelBenchRecord = {
          provider: options.provider ?? defaults.provider,
          model: options.model,
          source: options.measuredPeakGb ? "measured" : "estimated",
          peakMemoryGb: options.measuredPeakGb
            ? Number(options.measuredPeakGb)
            : defaults.peakMemoryGb,
          tokensPerSecond: options.tokensPerSecond
            ? Number(options.tokensPerSecond)
            : defaults.tokensPerSecond,
          stableContextTokens: options.stableContextTokens
            ? Number(options.stableContextTokens)
            : defaults.stableContextTokens,
          crashRate: options.crashRate ? Number(options.crashRate) : defaults.crashRate,
          qualityScore: options.qualityScore ? Number(options.qualityScore) : defaults.qualityScore,
          measuredAt: new Date().toISOString(),
          notes: [
            options.measuredPeakGb ? "Operator-supplied measured benchmark." : "Estimated record.",
          ],
        };
        const records = await persistBenchRecord(resolved.outputDir, record);
        writeCliOutput({ ok: true, record, count: records.length }, options.json);
        return;
      }
      const records = await readBenchRecords(resolved.outputDir);
      writeCliOutput({ records }, options.json);
    });

  addCommonOptions(
    books.command("plan").description("Create or resume book bible and outline"),
  ).action(async (options: CommonOptions) => runReviewCommand(config, options, "plan"));
  addCommonOptions(books.command("write").description("Draft the manuscript")).action(
    async (options: CommonOptions) => runReviewCommand(config, options, "write"),
  );
  addCommonOptions(books.command("gate").description("Run review gates for a book run")).action(
    async (options: CommonOptions) => runReviewCommand(config, options, "gate"),
  );
  addCommonOptions(
    books.command("package").description("Package EPUB, print HTML, and metadata"),
  ).action(async (options: CommonOptions) => runReviewCommand(config, options, "package"));
  addCommonOptions(
    books.command("review-pack").description("Create the full morning review pack"),
  ).action(async (options: CommonOptions) => runReviewCommand(config, options, "review-pack"));

  addCommonOptions(
    books
      .command("planning-create")
      .description("Create an editable Planning Studio book-plan.json from a topic"),
  ).action(async (options: PlanningCreateOptions) => {
    const resolved = withOutputDir(config, options.outputDir);
    const plan = await createAndSaveBookPlan({
      config: resolved,
      request: requestFromOptions(options),
    });
    writeCliOutput({ ok: true, plan, quality: buildBookPlanQualityReport(plan) }, options.json);
  });

  books
    .command("planning-export")
    .description("Print an existing Planning Studio book-plan.json")
    .option("--json", "Print JSON output")
    .option("--output-dir <dir>", "Override book-writer output directory")
    .requiredOption("--run-id <id>", "Target an existing Planning Studio run id")
    .action(async (options: { json?: boolean; outputDir?: string; runId: string }) => {
      const resolved = withOutputDir(config, options.outputDir);
      const plan = await readBookPlan(resolved, options.runId);
      if (!plan) {
        throw new Error(`book plan not found: ${options.runId}`);
      }
      writeCliOutput({ ok: true, plan, quality: buildBookPlanQualityReport(plan) }, options.json);
    });

  books
    .command("planning-save")
    .description("Replace an editable book-plan.json from a JSON file with version checking")
    .option("--json", "Print JSON output")
    .option("--output-dir <dir>", "Override book-writer output directory")
    .requiredOption("--file <path>", "Path to a complete book-plan JSON document")
    .option("--base-version <version>", "Expected existing plan version")
    .action(
      async (options: {
        json?: boolean;
        outputDir?: string;
        file: string;
        baseVersion?: string;
      }) => {
        const resolved = withOutputDir(config, options.outputDir);
        const raw = await fs.readFile(options.file, "utf8");
        const plan = JSON.parse(raw) as BookPlan;
        const saved = await saveBookPlan({
          config: resolved,
          plan,
          baseVersion: options.baseVersion ? Number(options.baseVersion) : undefined,
          action: "cli-save",
          summary: `Saved Planning Studio plan from ${options.file}.`,
        });
        writeCliOutput(
          { ok: true, plan: saved, quality: buildBookPlanQualityReport(saved) },
          options.json,
        );
      },
    );

  books
    .command("planning-draft")
    .description("Generate text for unlocked paragraphs in a Planning Studio book plan")
    .option("--json", "Print JSON output")
    .option("--output-dir <dir>", "Override book-writer output directory")
    .requiredOption("--run-id <id>", "Target an existing Planning Studio run id")
    .option("--base-version <version>", "Expected existing plan version")
    .action(
      async (options: {
        json?: boolean;
        outputDir?: string;
        runId: string;
        baseVersion?: string;
      }) => {
        const resolved = withOutputDir(config, options.outputDir);
        const plan = await draftAndSaveBookPlan({
          config: resolved,
          runId: options.runId,
          baseVersion: options.baseVersion ? Number(options.baseVersion) : undefined,
        });
        writeCliOutput({ ok: true, plan, quality: buildBookPlanQualityReport(plan) }, options.json);
      },
    );

  books
    .command("planning-stitch")
    .description("Stitch Planning Studio paragraph text into manuscript.md")
    .option("--json", "Print JSON output")
    .option("--output-dir <dir>", "Override book-writer output directory")
    .requiredOption("--run-id <id>", "Target an existing Planning Studio run id")
    .option("--base-version <version>", "Expected existing plan version")
    .action(
      async (options: {
        json?: boolean;
        outputDir?: string;
        runId: string;
        baseVersion?: string;
      }) => {
        const resolved = withOutputDir(config, options.outputDir);
        const result = await stitchAndSaveBookPlan({
          config: resolved,
          runId: options.runId,
          baseVersion: options.baseVersion ? Number(options.baseVersion) : undefined,
        });
        writeCliOutput(
          {
            ok: true,
            plan: result.plan,
            manuscriptPath: result.manuscriptPath,
            quality: buildBookPlanQualityReport(result.plan),
          },
          options.json,
        );
      },
    );

  books
    .command("planning-propagate")
    .description("Propagate a detected story-impact change through editable affected paragraphs")
    .option("--json", "Print JSON output")
    .option("--output-dir <dir>", "Override book-writer output directory")
    .requiredOption("--run-id <id>", "Target an existing Planning Studio run id")
    .option("--base-version <version>", "Expected existing plan version")
    .action(
      async (options: {
        json?: boolean;
        outputDir?: string;
        runId: string;
        baseVersion?: string;
      }) => {
        const resolved = withOutputDir(config, options.outputDir);
        const plan = await propagateAndSaveStoryImpact({
          config: resolved,
          runId: options.runId,
          baseVersion: options.baseVersion ? Number(options.baseVersion) : undefined,
        });
        writeCliOutput({ ok: true, plan, quality: buildBookPlanQualityReport(plan) }, options.json);
      },
    );

  books
    .command("quick-read")
    .description("Create a Quick Read Edition plan from an existing full book plan")
    .option("--json", "Print JSON output")
    .option("--output-dir <dir>", "Override book-writer output directory")
    .requiredOption("--source-run-id <id>", "Source full book plan run id")
    .action(async (options: { json?: boolean; outputDir?: string; sourceRunId: string }) => {
      const resolved = withOutputDir(config, options.outputDir);
      const plan = await createQuickReadAndSave({
        config: resolved,
        sourceRunId: options.sourceRunId,
      });
      writeCliOutput({ ok: true, plan, quality: buildBookPlanQualityReport(plan) }, options.json);
    });

  addCommonOptions(
    books
      .command("overnight-run")
      .description("Run the measured-model overnight workflow and approved backlog selection"),
  )
    .option(
      "--allow-estimated",
      "Allow estimated model records when no measured record is available",
    )
    .option("--force", "Run even when timing or model gates warn")
    .option("--dry-run", "Evaluate model, timing, and backlog without drafting")
    .option("--no-publish-prep", "Skip KDP dry-run preparation from approved backlog")
    .action(async (options: OvernightRunOptions) => {
      const resolved = withOutputDir(config, options.outputDir);
      const report = await runOvernightBookWriter({
        config: resolved,
        request: requestFromOptions(options),
        mode: normalizeMode(options.mode),
        allowEstimated: options.allowEstimated,
        force: options.force,
        dryRun: options.dryRun,
        preparePublish: options.publishPrep !== false,
      });
      writeCliOutput(report, options.json);
    });

  addCommonOptions(
    books
      .command("schedule-install")
      .description("Write explicit scheduler files for the nightly book-writer run"),
  )
    .option("--cron <expr>", "Cron expression for the nightly run", "30 20 * * *")
    .option(
      "--timezone <tz>",
      "Timezone for the Gateway cron registration",
      config.schedule.timezone,
    )
    .option("--install-system-cron", "Install or replace the managed system crontab block")
    .option(
      "--register-gateway-cron",
      "Create or update the managed Gateway cron job after writing scheduler files",
    )
    .option("--gateway-cron-dry-run", "Plan Gateway cron registration without mutating cron")
    .option(
      "--gateway-cron-job-name <name>",
      "Managed Gateway cron job name",
      "Book Writer Overnight",
    )
    .option("--openclaw-command <command>", "Command used to invoke OpenClaw", "pnpm openclaw")
    .option("--enable-autonomous-writing", "Opt in to scheduled autonomous overnight drafting")
    .option(
      "--allow-estimated",
      "Allow estimated model records when no measured record is available",
    )
    .option("--force", "Run even when timing or model gates warn")
    .option("--dry-run", "Evaluate model, timing, and backlog without drafting")
    .option("--no-publish-prep", "Skip KDP dry-run preparation from approved backlog")
    .action(async (options: ScheduleInstallCliOptions) => {
      const resolved = withOutputDir(config, options.outputDir);
      const report = await installBookWriterSchedule({
        config: resolved,
        request: requestFromOptions(options),
        mode: normalizeMode(options.mode),
        cron: options.cron,
        timezone: options.timezone,
        installSystemCron: options.installSystemCron,
        registerGatewayCron: options.registerGatewayCron,
        gatewayCronDryRun: options.gatewayCronDryRun,
        gatewayCronJobName: options.gatewayCronJobName,
        allowEstimated: options.allowEstimated,
        force: options.force,
        dryRun: options.dryRun,
        enableAutonomousWriting: options.enableAutonomousWriting,
        preparePublish: options.publishPrep !== false,
        openclawCommand: options.openclawCommand,
      });
      writeCliOutput(report, options.json);
    });

  addCommonOptions(
    books
      .command("scheduler-tick")
      .description("Run one scheduler tick with locking and missed-run recovery"),
  )
    .option(
      "--allow-estimated",
      "Allow estimated model records when no measured record is available",
    )
    .option("--force", "Run even when timing or model gates warn")
    .option("--dry-run", "Evaluate model, timing, and backlog without drafting")
    .option("--no-publish-prep", "Skip KDP dry-run preparation from approved backlog")
    .option("--lock-ttl-minutes <minutes>", "Recover a lock older than this many minutes")
    .option("--missed-after-hours <hours>", "Mark a missed run after this many idle hours")
    .option(
      "--enable-autonomous-writing",
      "Run this scheduler tick even when the saved Book Studio automation switch is off",
    )
    .action(async (options: SchedulerTickCliOptions) => {
      const resolved = withOutputDir(config, options.outputDir);
      const report = await runBookWriterSchedulerTick({
        config: resolved,
        request: requestFromOptions(options),
        mode: normalizeMode(options.mode),
        allowEstimated: options.allowEstimated,
        force: options.force,
        dryRun: options.dryRun,
        automationEnabled: options.enableAutonomousWriting,
        preparePublish: options.publishPrep !== false,
        lockTtlMinutes: options.lockTtlMinutes ? Number(options.lockTtlMinutes) : undefined,
        missedAfterHours: options.missedAfterHours ? Number(options.missedAfterHours) : undefined,
      });
      writeCliOutput(report, options.json);
    });

  books
    .command("endurance-preview")
    .description("Estimate full-length overnight endurance with retry and packaging reserves")
    .option("--json", "Print JSON output")
    .option("--output-dir <dir>", "Override book-writer output directory")
    .option("--target-words <count>", "Target manuscript word count", "45000")
    .option("--chapters <count>", "Planned chapter count", "8")
    .option("--mode <mode>", "Memory mode: light, normal, ideal, premium", "normal")
    .option("--model <model>", "Preferred model id")
    .action(async (options: CommonOptions & { chapters?: string }) => {
      const resolved = withOutputDir(config, options.outputDir);
      const mode = normalizeMode(options.mode);
      const records = await readBenchRecords(resolved.outputDir);
      const selection = selectBestModel({
        records,
        policy: resolved.memoryPolicy,
        mode,
        preferredModel: options.model,
      });
      const selected = selection.selected ?? records[0];
      const endurance = estimateBookEndurance({
        targetWords: options.targetWords ? Number(options.targetWords) : 45000,
        chapterCount: options.chapters ? Number(options.chapters) : 8,
        tokensPerSecond: selected.tokensPerSecond,
        reviewReadyBy: resolved.schedule.reviewReadyBy,
      });
      const eligibility = evaluateModelEligibility({
        record: selected,
        policy: resolved.memoryPolicy,
        mode,
      });
      writeCliOutput(
        {
          selected,
          eligibility,
          endurance,
          memoryCapGb: memoryCapForMode(resolved.memoryPolicy, mode),
          rejected: selection.rejected,
        },
        options.json,
      );
    });

  books
    .command("schedule-preview")
    .description("Estimate whether the selected model can finish before the review deadline")
    .option("--json", "Print JSON output")
    .option("--output-dir <dir>", "Override book-writer output directory")
    .option("--target-words <count>", "Target manuscript word count", "12000")
    .option("--mode <mode>", "Memory mode: light, normal, ideal, premium", "normal")
    .option("--model <model>", "Preferred model id")
    .action(async (options: CommonOptions) => {
      const resolved = withOutputDir(config, options.outputDir);
      const records = await readBenchRecords(resolved.outputDir);
      const selection = selectBestModel({
        records,
        policy: resolved.memoryPolicy,
        mode: normalizeMode(options.mode),
        preferredModel: options.model,
      });
      const selected = selection.selected ?? records[0];
      const schedule = estimateSchedule({
        targetWords: options.targetWords ? Number(options.targetWords) : 12000,
        tokensPerSecond: selected.tokensPerSecond,
        reviewReadyBy: resolved.schedule.reviewReadyBy,
      });
      const eligibility = evaluateModelEligibility({
        record: selected,
        policy: resolved.memoryPolicy,
        mode: normalizeMode(options.mode),
      });
      writeCliOutput(
        { selected, eligibility, schedule, rejected: selection.rejected },
        options.json,
      );
    });

  books
    .command("publish-dry-run")
    .description("Prepare a browser-assisted KDP dry-run without final submit")
    .option("--json", "Print JSON output")
    .option("--output-dir <dir>", "Override book-writer output directory")
    .requiredOption("--run-id <id>", "Target an existing review-pack run id")
    .option("--allow-revise", "Permit dry-run planning for a revise review pack")
    .option(
      "--cover-strategy <strategy>",
      "Cover route: auto, upload, or kdp-cover-creator",
      "auto",
    )
    .action(async (options: PublishDryRunOptions) => {
      const resolved = withOutputDir(config, options.outputDir);
      const report = await prepareKdpDryRun({
        outputDir: resolved.outputDir,
        runId: options.runId,
        allowRevise: options.allowRevise,
        coverStrategy: normalizeKdpCoverStrategy(options.coverStrategy),
      });
      writeCliOutput(report, options.json);
    });
}
