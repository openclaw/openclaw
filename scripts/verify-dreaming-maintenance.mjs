import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dreaming-maintenance-"));
const stagedPlanRelativePath = path.posix.join(
  "memory",
  ".dreams",
  "maintenance",
  "staged-plan.json",
);
const stagedSummaryRelativePath = path.posix.join(
  "memory",
  ".dreams",
  "maintenance",
  "staged-summary.md",
);
const currentStateRelativePath = path.posix.join(
  "memory",
  ".dreams",
  "maintenance",
  "current.json",
);
const lastApplyRelativePath = path.posix.join(
  "memory",
  ".dreams",
  "maintenance",
  "last-apply.json",
);
const managedStartMarker = "<!-- openclaw:dreaming:managed:start -->";
const managedEndMarker = "<!-- openclaw:dreaming:managed:end -->";

const { runShortTermDreamingPromotionIfTriggered } = await tsImport(
  pathToFileURL(path.join(repoRoot, "extensions", "memory-core", "src", "dreaming.ts")).href,
  import.meta.url,
);
const { applyDreamingMaintenance, rollbackDreamingMaintenance } = await tsImport(
  pathToFileURL(path.join(repoRoot, "extensions", "memory-core", "src", "dreaming-maintenance.ts"))
    .href,
  import.meta.url,
);

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const agentId = "dreaming_verify_e2e";
const compareStrings = (left, right) => left.localeCompare(right);

const dreamingConfig = {
  enabled: true,
  cron: "0 3 * * *",
  timezone: "UTC",
  limit: 12,
  minScore: 0,
  minRecallCount: 0,
  minUniqueQueries: 0,
  recencyHalfLifeDays: 14,
  verboseLogging: false,
  storage: {
    mode: "separate",
    separateReports: false,
  },
  dailySignalFiles: ["memory/daily-log.md"],
  maintenance: {
    enabled: true,
    autoApply: false,
    maxManagedEntries: 8,
    maxEntryChars: 180,
    maxIndexLines: 8,
    maxEvidencePerEntry: 4,
    maxQueryTermsPerEntry: 6,
    staleAfterDays: 30,
  },
};

const cfg = {
  agents: {
    list: [
      {
        id: agentId,
        default: true,
        workspace: workspaceDir,
      },
    ],
  },
  plugins: {
    entries: {
      "memory-core": {
        config: {
          dreaming: {
            enabled: true,
            timezone: "UTC",
            dailySignalFiles: ["memory/daily-log.md"],
            storage: {
              mode: "separate",
              separateReports: false,
            },
            phases: {
              light: {
                enabled: true,
                lookbackDays: 2,
                limit: 20,
                dedupeSimilarity: 0.82,
              },
              rem: {
                enabled: false,
                lookbackDays: 2,
                limit: 20,
                minPatternStrength: 0.5,
              },
            },
          },
        },
      },
    },
  },
};

await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });

const originalMemory = [
  "# Long-Term Memory",
  "",
  "## Manual Notes",
  "",
  "- Manual note must survive apply and rollback untouched.",
  "",
].join("\n");
await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), originalMemory, "utf-8");

await fs.writeFile(
  path.join(workspaceDir, "memory", "daily-log.md"),
  [
    "# Daily Signals",
    "",
    "- Default cold backup tier is Glacier Deep Archive.",
    "- The restore checklist stays next to the backup log.",
    "- Keep one quarterly restore drill note in the backup runbook.",
    "",
  ].join("\n"),
  "utf-8",
);

const preStageMemory = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
const preSweepSnapshot = await snapshotWorkspace(workspaceDir);

const sweepResult = await runShortTermDreamingPromotionIfTriggered({
  cleanedBody: "__openclaw_memory_core_short_term_promotion_dream__",
  trigger: "heartbeat",
  workspaceDir,
  cfg,
  config: dreamingConfig,
  logger,
});

assert.deepEqual(sweepResult, {
  handled: true,
  reason: "memory-core: short-term dreaming processed",
});

const stagedPlanPath = path.join(workspaceDir, stagedPlanRelativePath);
const stagedSummaryPath = path.join(workspaceDir, stagedSummaryRelativePath);
const stagedPlan = JSON.parse(await fs.readFile(stagedPlanPath, "utf-8"));
const stagedSummary = await fs.readFile(stagedSummaryPath, "utf-8");
const postStageMemory = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
const postStageSnapshot = await snapshotWorkspace(workspaceDir);
const stageChangedPaths = diffSnapshotPaths(preSweepSnapshot, postStageSnapshot);

assert.equal(postStageMemory, preStageMemory, "stage-only sweep must not modify MEMORY.md");
assert.ok(stagedSummary.includes("Dreaming Maintenance"), "staged summary missing heading");
assert.ok(
  stageChangedPaths.includes(stagedPlanRelativePath) &&
    stageChangedPaths.includes(stagedSummaryRelativePath),
  "stage sweep must materialize staged-plan.json and staged-summary.md",
);

assert.ok(Array.isArray(stagedPlan.report.touchedFiles), "report.touchedFiles missing");
assert.ok(stagedPlan.report.touchedFiles.length > 0, "report.touchedFiles must be non-empty");
assert.ok(Array.isArray(stagedPlan.report.fileChanges), "report.fileChanges missing");
assert.equal(
  stagedPlan.report.touchedFiles.length,
  stagedPlan.report.fileChanges.length,
  "touchedFiles and fileChanges should stay aligned",
);
assert.ok(
  Object.values(stagedPlan.report.operationCounts).some((count) => Number(count) > 0),
  "operationCounts must report at least one planned operation",
);
assert.ok(
  Array.isArray(stagedPlan.report.evidenceSources) && stagedPlan.report.evidenceSources.length > 0,
  "evidenceSources must be non-empty",
);
assert.ok(
  stagedPlan.report.evidenceSources.some((entry) => entry.path === "memory/daily-log.md"),
  "evidenceSources must include memory/daily-log.md",
);
assert.ok(
  stagedPlan.report.evidenceSources.every((entry) => entry.path === "memory/daily-log.md"),
  "temporary workspace verification should not pull transcript evidence from unrelated agents",
);
assert.ok(
  Array.isArray(stagedPlan.report.queryTerms) &&
    stagedPlan.report.queryTerms.includes("__dreaming_daily__:daily-log"),
  "queryTerms must include the daily-log tracking token",
);
assert.ok(
  Array.isArray(stagedPlan.report.changes) && stagedPlan.report.changes.length > 0,
  "staged plan must contain at least one change entry",
);

const plannedDurablePaths = stagedPlan.report.fileChanges
  .map((change) => change.path)
  .toSorted(compareStrings);
assert.deepEqual(
  plannedDurablePaths,
  stagedPlan.report.touchedFiles.map((entry) => entry.path).toSorted(compareStrings),
  "touchedFiles must match fileChanges paths",
);

const applied = await applyDreamingMaintenance({ workspaceDir });
assert.equal(applied.status, "applied", `apply should succeed, got ${JSON.stringify(applied)}`);
assert.deepEqual(
  [...applied.touchedFiles].toSorted(compareStrings),
  plannedDurablePaths,
  "apply touchedFiles must match durable staged fileChanges",
);

const postApplySnapshot = await snapshotWorkspace(workspaceDir);
const applyChangedPaths = diffSnapshotPaths(postStageSnapshot, postApplySnapshot);
const expectedApplyChangedPaths = [
  ...plannedDurablePaths,
  lastApplyRelativePath,
  stagedPlanRelativePath,
  stagedSummaryRelativePath,
].toSorted(compareStrings);
assert.deepEqual(
  applyChangedPaths,
  expectedApplyChangedPaths,
  `apply changed files mismatch: expected ${expectedApplyChangedPaths.join(", ")} got ${applyChangedPaths.join(", ")}`,
);

const memoryBeforeApply = preStageMemory;
const memoryAfterApply = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
const beforeManagedBlock = extractManagedBlock(memoryBeforeApply);
const afterManagedBlock = extractManagedBlock(memoryAfterApply);

assert.equal(beforeManagedBlock, "", "managed block should be absent before apply");
assert.ok(
  memoryAfterApply.includes("## Dreaming Maintained Memory"),
  "MEMORY.md missing managed heading",
);
assert.ok(
  afterManagedBlock.includes(managedStartMarker) && afterManagedBlock.includes(managedEndMarker),
  "managed block markers missing after apply",
);
assert.ok(
  afterManagedBlock.includes("Glacier Deep Archive"),
  "managed block missing promoted daily-log content",
);
assert.ok(
  memoryAfterApply.includes("- Manual note must survive apply and rollback untouched."),
  "manual memory text must survive apply",
);
assert.equal(
  stripManagedBlocks(memoryAfterApply).trimEnd(),
  stripManagedBlocks(memoryBeforeApply).trimEnd(),
  "apply must only touch the Dreaming-managed blocks",
);

const managedBlockDiff = buildManagedBlockDiff(beforeManagedBlock, afterManagedBlock);

const rolledBack = await rollbackDreamingMaintenance({ workspaceDir });
assert.equal(
  rolledBack.status,
  "rolled_back",
  `rollback should succeed, got ${JSON.stringify(rolledBack)}`,
);
assert.deepEqual(
  [...rolledBack.touchedFiles].toSorted(compareStrings),
  plannedDurablePaths,
  "rollback touchedFiles must match durable staged fileChanges",
);

const memoryAfterRollback = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf-8");
assert.equal(
  memoryAfterRollback,
  memoryBeforeApply,
  "rollback must restore MEMORY.md byte-for-byte",
);
await assertPathMissing(path.join(workspaceDir, currentStateRelativePath));
await assertPathMissing(path.join(workspaceDir, lastApplyRelativePath));

const acceptance = {
  workspaceDir,
  stagedPlanPath,
  stagedSummaryPath,
  plannedDurablePaths,
  applyChangedPaths,
  rollbackOk: true,
};

process.stdout.write(
  [
    "[verify-dreaming-maintenance] acceptance",
    `workspace=${acceptance.workspaceDir}`,
    `stagedPlan=${acceptance.stagedPlanPath}`,
    `stagedSummary=${acceptance.stagedSummaryPath}`,
    `plannedDurablePaths=${acceptance.plannedDurablePaths.join(",")}`,
    `applyChangedPaths=${acceptance.applyChangedPaths.join(",")}`,
    `managedBlockDiff=${managedBlockDiff.join(" || ")}`,
    "rollback=OK",
  ].join("\n") + "\n",
);

async function snapshotWorkspace(rootDir) {
  const snapshot = new Map();
  await walk(rootDir, async (absolutePath) => {
    const relativePath = path.relative(rootDir, absolutePath).replaceAll(path.sep, "/");
    const content = await fs.readFile(absolutePath, "utf-8");
    snapshot.set(relativePath, {
      sha1: sha1(content),
      content,
    });
  });
  return snapshot;
}

async function walk(dir, visit) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(absolutePath, visit);
      continue;
    }
    if (entry.isFile()) {
      await visit(absolutePath);
    }
  }
}

function diffSnapshotPaths(before, after) {
  const changed = new Set();
  for (const pathKey of new Set([...before.keys(), ...after.keys()])) {
    const beforeEntry = before.get(pathKey);
    const afterEntry = after.get(pathKey);
    if (!beforeEntry || !afterEntry) {
      changed.add(pathKey);
      continue;
    }
    if (beforeEntry.sha1 !== afterEntry.sha1) {
      changed.add(pathKey);
    }
  }
  return [...changed].toSorted(compareStrings);
}

function sha1(value) {
  return createHash("sha1").update(value).digest("hex");
}

function extractManagedBlock(markdown) {
  const start = markdown.indexOf(managedStartMarker);
  const end = markdown.indexOf(managedEndMarker);
  if (start === -1 || end === -1 || end < start) {
    return "";
  }
  return markdown.slice(start, end + managedEndMarker.length).trim();
}

function stripManagedBlocks(markdown) {
  return markdown
    .replace(
      new RegExp(
        `${escapeRegExp("## Dreaming Maintained Memory")}[\\s\\S]*?${escapeRegExp(managedEndMarker)}\\n?`,
        "g",
      ),
      "",
    )
    .replace(
      new RegExp(
        `${escapeRegExp("## Dreaming Memory Index")}[\\s\\S]*?${escapeRegExp("<!-- openclaw:dreaming:index:end -->")}\\n?`,
        "g",
      ),
      "",
    );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildManagedBlockDiff(beforeBlock, afterBlock) {
  const beforeLines = beforeBlock ? beforeBlock.split("\n") : [];
  const afterLines = afterBlock ? afterBlock.split("\n") : [];
  const removed = beforeLines
    .filter((line) => !afterLines.includes(line))
    .map((line) => `-${line}`);
  const added = afterLines.filter((line) => !beforeLines.includes(line)).map((line) => `+${line}`);
  return [...removed, ...added].slice(0, 16);
}

async function assertPathMissing(targetPath) {
  await fs
    .stat(targetPath)
    .then(() => {
      throw new Error(`expected path to be absent: ${targetPath}`);
    })
    .catch((error) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    });
}
