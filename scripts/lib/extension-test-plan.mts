// Resolves extension Vitest configs, costs, and batch shards for plugin test runs.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isAcpxExtensionRoot } from "../../test/vitest/vitest.extension-acpx-paths.mjs";
import { isActiveMemoryExtensionRoot } from "../../test/vitest/vitest.extension-active-memory-paths.mjs";
import { isBrowserExtensionRoot } from "../../test/vitest/vitest.extension-browser-paths.mjs";
import { resolveSplitChannelExtensionShard } from "../../test/vitest/vitest.extension-channel-split-paths.mjs";
import { isCodexExtensionRoot } from "../../test/vitest/vitest.extension-codex-paths.mjs";
import {
  databaseWorkerExtensionTestFiles,
  isDatabaseWorkerExtensionRoot,
} from "../../test/vitest/vitest.extension-database-workers-paths.mjs";
import { isDiffsExtensionRoot } from "../../test/vitest/vitest.extension-diffs-paths.mjs";
import { isFeishuExtensionRoot } from "../../test/vitest/vitest.extension-feishu-paths.mjs";
import { isIrcExtensionRoot } from "../../test/vitest/vitest.extension-irc-paths.mjs";
import { isMatrixExtensionRoot } from "../../test/vitest/vitest.extension-matrix-paths.mjs";
import { isMattermostExtensionRoot } from "../../test/vitest/vitest.extension-mattermost-paths.mjs";
import { isMediaExtensionRoot } from "../../test/vitest/vitest.extension-media-paths.mjs";
import { isMemoryExtensionRoot } from "../../test/vitest/vitest.extension-memory-paths.mjs";
import { isMessagingExtensionRoot } from "../../test/vitest/vitest.extension-messaging-paths.mjs";
import { isMiscExtensionRoot } from "../../test/vitest/vitest.extension-misc-paths.mjs";
import { isMsTeamsExtensionRoot } from "../../test/vitest/vitest.extension-msteams-paths.mjs";
import {
  isProviderExtensionRoot,
  isProviderOpenAiExtensionRoot,
} from "../../test/vitest/vitest.extension-provider-paths.mjs";
import { isQaExtensionRoot } from "../../test/vitest/vitest.extension-qa-paths.mjs";
import { isTelegramExtensionRoot } from "../../test/vitest/vitest.extension-telegram-paths.mjs";
import { isVoiceCallExtensionRoot } from "../../test/vitest/vitest.extension-voice-call-paths.mjs";
import { isWhatsAppExtensionRoot } from "../../test/vitest/vitest.extension-whatsapp-paths.mjs";
import { isZaloExtensionRoot } from "../../test/vitest/vitest.extension-zalo-paths.mjs";
import { isSharedVitestExcludedPath } from "../../test/vitest/vitest.pattern-file.ts";
import { isPluginControlUiPath } from "../../test/vitest/vitest.ui-paths.mjs";
import { BUNDLED_PLUGIN_PATH_PREFIX, BUNDLED_PLUGIN_ROOT_DIR } from "./bundled-plugin-paths.mjs";
import { listAvailableExtensionIds } from "./changed-extensions.mts";
import { parsePositiveInt } from "./numeric-options.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const TRACKED_EXTENSION_TEST_PATHSPECS = [
  `:(glob)${BUNDLED_PLUGIN_ROOT_DIR}/**/*.test.ts`,
  `:(glob)${BUNDLED_PLUGIN_ROOT_DIR}/**/*.test.tsx`,
];
/** Default number of shards for broad bundled extension test batches. */
export const DEFAULT_EXTENSION_TEST_SHARD_COUNT = 8;
export type ExtensionTestPlanGroup = {
  config: string;
  estimatedCost: number;
  extensionIds: string[];
  roots: string[];
  testFileCount: number;
};

export type ExtensionBatchPlan = {
  extensionCount: number;
  extensionIds: string[];
  estimatedCost: number;
  hasTests: boolean;
  noTestExtensionIds?: string[];
  planGroups: ExtensionTestPlanGroup[];
  testFileCount: number;
};

type ExtensionTestShard = ExtensionBatchPlan & { checkName: string };

const EXTENSION_TEST_COST_MULTIPLIERS: Record<string, number> = {
  // Median wrapper seconds per counting file from PR runs 35490342736,
  // 35490482496, 35490609684 and 35491344005 (two CPUs, two workers).
  // oxlint-disable-next-line oxc/approx-constant -- measured seconds per file, not Euler's constant.
  "test/vitest/vitest.extension-acpx.config.ts": 2.718,
  "test/vitest/vitest.extension-browser.config.ts": 0.478,
  // Refreshed after #153539: median wrapper seconds/file in successful PR runs
  // 35537834254, 35537743091 and 35537672782 (two CPUs, two-worker budget).
  "test/vitest/vitest.extension-codex.config.ts": 2.49,
  // Same refreshed cohort: 114 envelopes, including the Codex native fixtures.
  "test/vitest/vitest.extension-database-workers.config.ts": 7.599,
  "test/vitest/vitest.extension-diffs.config.ts": 0.734,
  "test/vitest/vitest.extension-discord.config.ts": 0.55,
  "test/vitest/vitest.extension-feishu.config.ts": 0.411,
  "test/vitest/vitest.extension-imessage.config.ts": 0.874,
  "test/vitest/vitest.extension-irc.config.ts": 5.1,
  "test/vitest/vitest.extension-line.config.ts": 0.625,
  "test/vitest/vitest.extension-matrix.config.ts": 0.788,
  "test/vitest/vitest.extension-mattermost.config.ts": 0.997,
  "test/vitest/vitest.extension-media.config.ts": 5.186,
  "test/vitest/vitest.extension-memory.config.ts": 1.232,
  "test/vitest/vitest.extension-messaging.config.ts": 0.379,
  "test/vitest/vitest.extension-misc.config.ts": 0.73,
  "test/vitest/vitest.extension-msteams.config.ts": 1.681,
  "test/vitest/vitest.extension-provider-openai.config.ts": 0.912,
  "test/vitest/vitest.extension-providers.config.ts": 1.675,
  "test/vitest/vitest.extension-qa.config.ts": 1.125,
  "test/vitest/vitest.extension-signal.config.ts": 1.307,
  "test/vitest/vitest.extension-voice-call.config.ts": 0.486,
  "test/vitest/vitest.extension-whatsapp.config.ts": 0.511,
  "test/vitest/vitest.extension-zalo.config.ts": 0.523,
  "test/vitest/vitest.extensions.config.ts": 0.642,
};
// Run 35826932121 measured complete two-CPU/two-worker process spans. Teams,
// media and IRC rates above retain 10% headroom plus two seconds per invocation.
// Split selectors use the same margin without charging their slowest sibling's
// cost to every file. Keys hash JSON.stringify of the complete ordered files;
// changed selectors fall back to the canonical rates until measured again.
const EXTENSION_TEST_NATIVE_SELECTION_FLOORS: Readonly<
  Record<string, Readonly<Record<string, number>>>
> = {
  "test/vitest/vitest.extension-codex.config.ts": {
    "14c03ae807edb902708d724eaf906df539b4ae0244809c3c0418f5d1d8822a6f": 88,
    "1845b3cc325deeaafeafb26bdbb93579dcb8bbcd7be6809c53affef4c2b4f962": 72,
    "40cf6380e0167699706e7bcf342866e2e0116565095f53e6f612bd000d898f80": 59,
    "42551ae19be53e2048f90b3dec668ec2b3887b961a019b3e09d3aa16399e9b50": 104,
    "56c4e154bcd04abb2f0e820b99d7de83b711cad96948ba49a6f7f1c33df4989b": 90,
    "6c50f739e80418a7f988ed72c1e9aee014d7914cac13d3f8130cffedffa9fe34": 80,
    "7316b6fa02ff0564bab1c967771211b002215da7a22447d35e41918907e85eb2": 129,
    "9bb61f3d87af787c45c6d4bd701b21055f896a469a04b4fe221ffd660e8ba811": 78,
    a0d47bbfaf47878551aed4664ed09a8f8cb689aaec6b3a5b58b29a8cc8d8e9e8: 69,
    d4100ea709c2dc5de8c932cc28643d14402612b95853ef8e32baed9ad55c595e: 73,
    d8ea3c78f2fc9b70580b0c84d5729f82e33a51c35a525bf2ec24e1340da5fadf: 72,
    db3d1abb06a4b785c30e99d377075368d9511a6765201f134f4ee08db654d66f: 68,
    e0a33e1e19da65c38ab3422cabbf6e73835cd436d1074913d7d4dab2336e0544: 84,
    ed0f6a6f89540d4ec1d80ef856005509ab01bcf4a9efa7d0a6ebd56dce02e2b3: 71,
  },
  "test/vitest/vitest.extension-database-workers.config.ts": {
    "01a3710e517f364ddd3dcbae6199fe9cc0db1151fb9eadc9e3899c567a8e95ff": 194,
    "0c32e7b11ffd01e31e0fdccd42d18ddc6b97609fdfd9dcf039decb0e0ad15f31": 134,
    "2186c0d6eb4cdccf585d5bb2c3db6cf3ae7958f86434b461fd04b09a46f52331": 89,
    "2a4e6c96190095f82be1b8d8e5fd983fc89a56c61cb97bd189dfc9d6df01584f": 172,
    "2df7fb7db67e7d33a74838bb0e770ec00e211885a6e42ee936e25f9680cc9c1c": 167,
    "30b23f0b60a790f06dcf5025971ad44c7844878e7ece6a1f94afc4fb1fc2841d": 19,
    "487d259d9fbc8c863e4bc4bc0d3791f1f02af56e104bab1e45f07296599ae64f": 136,
    "6414e966a74f2f02ddce317189972c1e47c2b0114e16c24c5055783eae3a36ec": 192,
    "69d6ade041cb620a16fe9e41165062d8a33926347ac0bf0a2915fbc49bf84588": 133,
    "73ea0c2acd44f3b644bf173cacd44298dd6850792444a394e1cd53ae0b9832cb": 21,
    "845c434e645829ba711532a6252d8d7f1857cd95b68f5d6d375346a837854d00": 129,
    "86ccf029d1e889bdd6460ccc7df6ff1f2079fbf51916fa66a37efed45649aaa2": 483,
    "994f94f330a3631f6523a1de5cbef3f296ae9287097f8b426a9b5c721bfae767": 201,
    "995ec7390a60d305e8cdc882cf8ee630d7ffa9f28bf09a91b5fe153101b1e1d0": 134,
    "9ac801838ea9978b4666de8ad080a5576afea0cd9fc321cf46c1c4f41f5db951": 246,
    "9ff600f599e69be908e19b128ccc354e0bd67037bd926937f5be7f8ef88d30b8": 43,
    b0cd33c25a5413c9d48b91b59122716e4e7542cb27f7e3148c9fc228c0d1acd7: 166,
    ba3d15a18fadbb5af2c90caf54579491a82cf7b4adb7af90b72c121fa8d7ec6e: 225,
    bf30e100e63336b7be06c9d7eb038280b5a47a564fcf27eccba2d78cdd13c661: 18,
    c90a29b957a9bae511e66ef00ed02dab09f53e3b1ebc7d19b327893799f9adb2: 20,
    cdc76adc8407b1c7581af40bbba8f296c814b66ecc51d6b02a03ee6c1e286e85: 26,
    d15784b699f8599333e43058ae8c2b0c36a15761e7cbc270ad859f418a7706ad: 93,
    e3c9aeae2c4d44778ec0ab5003829f3650801f736868ce228368f0f07e62825c: 47,
    f5222b23ad1c610af45d696505065801c17712b4291e0ce20825859c3ffcba07: 66,
  },
  "test/vitest/vitest.extension-matrix.config.ts": {
    "4aa7f6da2413b1b60470ae08a4cdb0325aaf55e205f2a1ac5a917ffa081696fe": 34,
    "52ff6f9e7ecc72e31b914aa381df0d523a67b8babaed5a1fdc7aaea2dd265a03": 44,
    "5d2450cbe897b380bd08f23ae9e3265cb283efc288be173f6672d650b8081ae5": 134,
    be42e1414be2882060836362fcef8d40e7a385a3f7906cd80f2566bb0de33fb0: 34,
  },
  "test/vitest/vitest.extension-telegram.config.ts": {
    "768566d1fc202ea84b4248f6685514ee64dbb4be86547d6491efdb29870b6976": 124,
    "812d3a61704557d770fbe41cb474d5f3dd6bece602b66d87b11bf9a855334ad8": 46,
    a28e6308bfca16a24468e3d9b592fd481e3e360c0ffbdc306a076ad1008d593e: 52,
    cb08e46aec945ab4d64c81a309aa9263715f04202afea5d0063f2bfef0acaf87: 56,
    dd6475e03014b9b33601ed2a7f223d7037e2d24b6d3ca64999ca20e7f5a4cf53: 47,
    e396f0b1c6d75ecc6d87fa86cb5f2d5674b22a3a623f228f5b7c5297119e9b96: 69,
  },
};

// Retain the pre-parallel PR rates as serial references. Future parallel samples
// belong in EXTENSION_TEST_COST_MULTIPLIERS and must not be discounted again.
const EXTENSION_TEST_SERIAL_REFERENCE_COST_MULTIPLIERS: Record<string, number> = {
  "test/vitest/vitest.extension-slack.config.ts": 1.375,
  "test/vitest/vitest.extension-telegram.config.ts": 5.061,
};
// Two-worker Slack measured 171.941 -> 134.990s; matched two-CPU Telegram measured
// 41.447 -> 31.686s. Use a conservative 1.2x estimate only for multi-file work.
const CONSERVATIVE_EXTENSION_PARALLEL_SPEEDUP = 1.2;
// Isolated Codex workers retire each mocked graph instead of accumulating it (#125839).
// Bound cold imports per envelope while sharing startup across parallel files.
const CODEX_EXTENSION_TEST_PROCESS_FILE_LIMIT = 24;
// Native app-server files already run in isolated forks. Preserve their measured
// 12-file envelope boundary independently of the ordinary Codex lane.
const CODEX_DATABASE_WORKER_TEST_PROCESS_FILE_LIMIT = 12;
const MATRIX_EXTENSION_TEST_PROCESS_FILE_LIMIT = 40;
const TELEGRAM_EXTENSION_TEST_PROCESS_FILE_LIMIT = 10;
const TELEGRAM_EXTENSION_TEST_JOB_FILE_LIMIT = 10;
const EXTENSION_TEST_PROCESS_FILE_LIMITS = new Map<string, number>([
  ["test/vitest/vitest.extension-codex.config.ts", CODEX_EXTENSION_TEST_PROCESS_FILE_LIMIT],
  // The non-isolated Matrix suite intentionally shares module state within a process.
  // Bound its lifetime so Vite's transformed module graph cannot grow across the whole suite.
  ["test/vitest/vitest.extension-matrix.config.ts", MATRIX_EXTENSION_TEST_PROCESS_FILE_LIMIT],
  [
    "test/vitest/vitest.extension-telegram.config.ts",
    // Isolated thread workers retire each mocked graph. Keep one existing job
    // envelope per process so its files can share the configured worker pool.
    TELEGRAM_EXTENSION_TEST_PROCESS_FILE_LIMIT,
  ],
]);
const EXTENSION_TEST_JOB_FILE_LIMITS = new Map<string, number>([
  // The 468-file catch-all took 528–829s on two detected CPUs. Six jobs leave
  // room for checkout/setup without changing its non-isolated worker lifecycle.
  ["test/vitest/vitest.extensions.config.ts", 90],
  // Run 33449014227: QA took 203s and isolated providers 271s on two detected
  // CPUs. Reuse the job-only bound; Vitest keeps each config's file lifecycle.
  ["test/vitest/vitest.extension-qa.config.ts", 90],
  ["test/vitest/vitest.extension-providers.config.ts", 90],
  // Retain the existing Telegram job inventory while its isolated thread files
  // share one process. Native database-worker files keep their separate lifecycle.
  ["test/vitest/vitest.extension-telegram.config.ts", TELEGRAM_EXTENSION_TEST_JOB_FILE_LIMIT],
]);
const EXTENSION_TEST_CONFIG_ROUTES: Array<[(root: string) => boolean, string]> = [
  [isActiveMemoryExtensionRoot, "test/vitest/vitest.extension-active-memory.config.ts"],
  [isAcpxExtensionRoot, "test/vitest/vitest.extension-acpx.config.ts"],
  [isBrowserExtensionRoot, "test/vitest/vitest.extension-browser.config.ts"],
  [isCodexExtensionRoot, "test/vitest/vitest.extension-codex.config.ts"],
  [isDiffsExtensionRoot, "test/vitest/vitest.extension-diffs.config.ts"],
  [isFeishuExtensionRoot, "test/vitest/vitest.extension-feishu.config.ts"],
  [isIrcExtensionRoot, "test/vitest/vitest.extension-irc.config.ts"],
  [isMattermostExtensionRoot, "test/vitest/vitest.extension-mattermost.config.ts"],
  [isMatrixExtensionRoot, "test/vitest/vitest.extension-matrix.config.ts"],
  [isMediaExtensionRoot, "test/vitest/vitest.extension-media.config.ts"],
  [isMemoryExtensionRoot, "test/vitest/vitest.extension-memory.config.ts"],
  [isMessagingExtensionRoot, "test/vitest/vitest.extension-messaging.config.ts"],
  [isMiscExtensionRoot, "test/vitest/vitest.extension-misc.config.ts"],
  [isMsTeamsExtensionRoot, "test/vitest/vitest.extension-msteams.config.ts"],
  [isQaExtensionRoot, "test/vitest/vitest.extension-qa.config.ts"],
  [isDatabaseWorkerExtensionRoot, "test/vitest/vitest.extension-database-workers.config.ts"],
  [isTelegramExtensionRoot, "test/vitest/vitest.extension-telegram.config.ts"],
  [isVoiceCallExtensionRoot, "test/vitest/vitest.extension-voice-call.config.ts"],
  [isWhatsAppExtensionRoot, "test/vitest/vitest.extension-whatsapp.config.ts"],
  [isZaloExtensionRoot, "test/vitest/vitest.extension-zalo.config.ts"],
  [isProviderOpenAiExtensionRoot, "test/vitest/vitest.extension-provider-openai.config.ts"],
  [isProviderExtensionRoot, "test/vitest/vitest.extension-providers.config.ts"],
];

function normalizeRelative(inputPath: string) {
  return inputPath.split(path.sep).join("/");
}

function isPathInsideRepo(relativePath: string) {
  return relativePath !== ".." && !relativePath.startsWith("../") && !path.isAbsolute(relativePath);
}

function isSkippedTrackedTestFile(relativePath: string) {
  return (
    isPluginControlUiPath(relativePath) ||
    relativePath.split("/").some((segment) => segment === "dist" || segment === "node_modules")
  );
}

let trackedRepoTestFiles: string[] | null | undefined;
// Large checkouts exceed Node's 1 MiB spawnSync default. Preserve the Git inventory path;
// ENOBUFS would otherwise trigger expensive extension-directory walks.
export const GIT_LS_FILES_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export function listTrackedTestPlanFiles(cwd: string, pathspecs: readonly string[]) {
  // Query only the planner-owned tree: a full-repo inventory can overflow
  // spawnSync's buffer and either truncate the plan or force directory walks.
  const result = spawnSync("git", ["ls-files", "-z", "--", ...pathspecs], {
    cwd,
    encoding: "utf8",
    maxBuffer: GIT_LS_FILES_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || result.error) {
    return null;
  }
  return result.stdout.split("\0").filter(Boolean);
}

function loadTrackedRepoTestFiles() {
  // Tracked repository metadata is immutable during one planner invocation.
  // Reuse one inventory so broad extension plans do not fork Git per plugin.
  if (trackedRepoTestFiles === undefined) {
    trackedRepoTestFiles =
      listTrackedTestPlanFiles(repoRoot, TRACKED_EXTENSION_TEST_PATHSPECS)?.filter(
        (line) =>
          !isSkippedTrackedTestFile(line) &&
          (line.endsWith(".test.ts") || line.endsWith(".test.tsx")),
      ) ?? null;
  }
  return trackedRepoTestFiles;
}

function listTrackedTestFiles(rootPath: string) {
  const relativeRoot = normalizeRelative(path.relative(repoRoot, rootPath));
  if (!isPathInsideRepo(relativeRoot)) {
    return null;
  }

  const trackedFiles = loadTrackedRepoTestFiles();
  if (trackedFiles === null) {
    return null;
  }

  if (!relativeRoot) {
    return trackedFiles;
  }
  const rootPrefix = `${relativeRoot}/`;
  return trackedFiles.filter((file) => file.startsWith(rootPrefix));
}

function listFilesystemTestFiles(rootPath: string) {
  const files = [];
  const stack = [rootPath];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !fs.existsSync(current)) {
      continue;
    }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (isPluginControlUiPath(normalizeRelative(path.relative(repoRoot, fullPath)))) {
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") {
          continue;
        }
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && (fullPath.endsWith(".test.ts") || fullPath.endsWith(".test.tsx"))) {
        files.push(normalizeRelative(path.relative(repoRoot, fullPath)));
      }
    }
  }

  return files.toSorted((left, right) => left.localeCompare(right));
}

/** List working-tree test files for extension roots, including new untracked tests. */
export function listExtensionTestFilesForRoots(roots: string[]) {
  const files = roots.flatMap((root) => {
    const rootPath = path.join(repoRoot, root);
    return fs.existsSync(rootPath) && fs.statSync(rootPath).isFile()
      ? [root]
      : listFilesystemTestFiles(rootPath);
  });
  return [...new Set(files)].toSorted((left, right) => left.localeCompare(right));
}

function uniqueSortedTargets(targets: string[]) {
  return [...new Set(targets)].toSorted((left, right) => left.localeCompare(right));
}

function splitTargetsByFileLimit(targets: string[], maxFilesPerChunk: number) {
  const orderedTargets = uniqueSortedTargets(targets);
  if (orderedTargets.length === 0) {
    return [];
  }
  if (orderedTargets.length <= maxFilesPerChunk) {
    return [orderedTargets];
  }

  const chunkCount = Math.ceil(orderedTargets.length / maxFilesPerChunk);
  const baseSize = Math.floor(orderedTargets.length / chunkCount);
  const remainder = orderedTargets.length % chunkCount;
  const chunks = [];
  let offset = 0;
  for (let index = 0; index < chunkCount; index += 1) {
    const chunkSize = baseSize + (index < remainder ? 1 : 0);
    chunks.push(orderedTargets.slice(offset, offset + chunkSize));
    offset += chunkSize;
  }
  return chunks;
}

export const DATABASE_WORKER_CONFIG = "test/vitest/vitest.extension-database-workers.config.ts";
// The 185-file native worker envelope was still running after 58 minutes in
// run 35176277297. Include migrated files too: run 35477485803 packed 149
// database-worker files into one serial job that took 27 minutes.
export const DATABASE_WORKER_TEST_JOB_FILE_LIMIT = 20;

function splitWorkerTargetsByOriginalConfig(
  targets: string[],
  split: (config: string, files: string[]) => string[][],
) {
  const groups = new Map<string, string[]>();
  for (const target of uniqueSortedTargets(targets)) {
    const config = resolveExtensionTestConfig(target.split("/").slice(0, 2).join("/"));
    const group = groups.get(config) ?? [];
    group.push(target);
    groups.set(config, group);
  }
  return [...groups].flatMap(([config, files]) => {
    if (config === "test/vitest/vitest.extension-codex.config.ts") {
      return splitTargetsByFileLimit(files, CODEX_DATABASE_WORKER_TEST_PROCESS_FILE_LIMIT);
    }
    return config === DATABASE_WORKER_CONFIG ? [files] : split(config, files);
  });
}

function resolveExtensionTestJobFileLimit(config: string) {
  return (
    EXTENSION_TEST_JOB_FILE_LIMITS.get(config) ?? EXTENSION_TEST_PROCESS_FILE_LIMITS.get(config)
  );
}

/** Split an extension config's test files across bounded process lifetimes when required. */
export function splitExtensionTestProcessTargets(config: string, targets: string[]): string[][] {
  if (config === DATABASE_WORKER_CONFIG) {
    return splitWorkerTargetsByOriginalConfig(
      targets.filter((file) => !isSharedVitestExcludedPath(file, BUNDLED_PLUGIN_ROOT_DIR)),
      (originalConfig, files) =>
        // The Telegram thread proof does not cover its native fork-owned files.
        // Retain their one-file process lifetime from #123576.
        originalConfig === "test/vitest/vitest.extension-telegram.config.ts"
          ? files.map((file) => [file])
          : splitExtensionTestProcessTargets(originalConfig, files),
    );
  }
  const maxFilesPerProcess = EXTENSION_TEST_PROCESS_FILE_LIMITS.get(config);
  return maxFilesPerProcess
    ? splitTargetsByFileLimit(
        targets.filter((file) => !isSharedVitestExcludedPath(file, BUNDLED_PLUGIN_ROOT_DIR)),
        maxFilesPerProcess,
      )
    : [uniqueSortedTargets(targets)];
}

/** Split an extension config's test files into CI envelopes without changing process lifetime. */
export function splitExtensionTestJobTargets(config: string, targets: string[]) {
  if (config === DATABASE_WORKER_CONFIG) {
    return splitWorkerTargetsByOriginalConfig(
      targets.filter((file) => !isSharedVitestExcludedPath(file, BUNDLED_PLUGIN_ROOT_DIR)),
      splitExtensionTestJobTargets,
    ).flatMap((files) => splitTargetsByFileLimit(files, DATABASE_WORKER_TEST_JOB_FILE_LIMIT));
  }
  const maxFilesPerJob = resolveExtensionTestJobFileLimit(config);
  return maxFilesPerJob
    ? splitTargetsByFileLimit(
        targets.filter((file) => !isSharedVitestExcludedPath(file, BUNDLED_PLUGIN_ROOT_DIR)),
        maxFilesPerJob,
      )
    : [uniqueSortedTargets(targets)];
}

/** Whether a Vitest invocation can safely be split into independent one-shot processes. */
export function shouldSplitExtensionTestProcesses(config: string, vitestArgs: string[] = []) {
  if (config !== DATABASE_WORKER_CONFIG && !EXTENSION_TEST_PROCESS_FILE_LIMITS.has(config)) {
    return false;
  }
  // Per-test retries and exact file exclusions preserve independent process scopes.
  // Other options may own suite-wide bail, watch, sharding, or report state.
  for (let index = 0; index < vitestArgs.length; index++) {
    const option = /^(--retry|--exclude)(?:=(.+))?$/u.exec(vitestArgs[index]!);
    if (!option) {
      return false;
    }
    const value = option[2] ?? vitestArgs[++index];
    if (!value || value.startsWith("-")) {
      return false;
    }
    if (option[1] === "--retry" ? !/^\d+$/u.test(value) : /[*!?[\]{}()]/u.test(value)) {
      return false;
    }
  }
  return true;
}

/** Resolve process targets for an extension config, expanding roots only when it is bounded. */
export function createExtensionTestProcessTargetChunks(
  config: string,
  roots: string[],
  vitestArgs: string[] = [],
) {
  if (!shouldSplitExtensionTestProcesses(config, vitestArgs)) {
    return [roots];
  }
  // Explicit file targets replace Vitest's root discovery, so inventory the working tree.
  // Otherwise a newly authored untracked test would silently disappear from a broad run.
  const discoveredFiles = listExtensionTestFilesForRoots(roots);
  if (discoveredFiles.length === 0) {
    return [roots];
  }
  const testFiles = discoveredFiles.filter(
    (file) => config === DATABASE_WORKER_CONFIG || !databaseWorkerExtensionTestFiles.includes(file),
  );
  return splitExtensionTestProcessTargets(config, testFiles);
}

function countTestFiles(rootPath: string) {
  const trackedFiles = listTrackedTestFiles(rootPath);
  if (trackedFiles) {
    return trackedFiles.length;
  }

  return listFilesystemTestFiles(rootPath).length;
}

export function estimateExtensionTestCost(
  config: string,
  testFileCount: number,
  files: readonly string[] = [],
) {
  const serialReference = EXTENSION_TEST_SERIAL_REFERENCE_COST_MULTIPLIERS[config];
  const multiplier =
    serialReference !== undefined && testFileCount <= 1
      ? serialReference
      : (EXTENSION_TEST_COST_MULTIPLIERS[config] ??
        (serialReference === undefined
          ? 1
          : serialReference / CONSERVATIVE_EXTENSION_PARALLEL_SPEEDUP));
  // After #153539, the slowest pure app-server envelope in PR runs 35537834254,
  // 35537743091 and 35537672782 took 190.394s / 11 files on two workers.
  // Preserve its rounded-up wrapper wall/file floor over the mixed config median.
  const appServerFiles =
    config === DATABASE_WORKER_CONFIG
      ? files.filter((file) => file.startsWith("extensions/codex/src/app-server/")).length
      : 0;
  const measuredSelections = EXTENSION_TEST_NATIVE_SELECTION_FLOORS[config];
  const measuredSeconds =
    measuredSelections && files.length === testFileCount
      ? measuredSelections[createHash("sha256").update(JSON.stringify(files)).digest("hex")]
      : undefined;
  return Math.max(
    1,
    Math.ceil(testFileCount * multiplier + appServerFiles * (17.31 - multiplier)),
    measuredSeconds ?? 0,
  );
}

/** Resolve the dedicated Vitest config for an extension root or test file. */
export function resolveExtensionTestConfig(target: string) {
  if (databaseWorkerExtensionTestFiles.includes(target)) {
    return "test/vitest/vitest.extension-database-workers.config.ts";
  }
  const root = target.split("/").slice(0, 2).join("/");
  const splitChannelShard = resolveSplitChannelExtensionShard(root);
  if (splitChannelShard) {
    return splitChannelShard.config;
  }
  return (
    EXTENSION_TEST_CONFIG_ROUTES.find(([matches]) => matches(root))?.[1] ??
    "test/vitest/vitest.extensions.config.ts"
  );
}

function resolveExtensionDirectory(targetArg: string | undefined, cwd = process.cwd()) {
  if (targetArg) {
    const asGiven = path.resolve(cwd, targetArg);
    if (fs.existsSync(path.join(asGiven, "package.json"))) {
      return asGiven;
    }

    const byName = path.join(repoRoot, BUNDLED_PLUGIN_ROOT_DIR, targetArg);
    if (fs.existsSync(path.join(byName, "package.json"))) {
      return byName;
    }

    throw new Error(
      `Unknown extension target "${targetArg}". Use a plugin name like "slack" or a path inside the bundled plugin workspace tree.`,
    );
  }

  let current = cwd;
  while (true) {
    if (
      normalizeRelative(path.relative(repoRoot, current)).startsWith(BUNDLED_PLUGIN_PATH_PREFIX) &&
      fs.existsSync(path.join(current, "package.json"))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  throw new Error(
    "No extension target provided, and current working directory is not inside the bundled plugin workspace tree.",
  );
}

/** Resolve the Vitest configs, files, and estimated cost for one extension target. */
export function resolveExtensionTestPlan(params: { cwd?: string; targetArg?: string } = {}) {
  const cwd = params.cwd ?? process.cwd();
  const targetArg = params.targetArg;
  const extensionDir = resolveExtensionDirectory(targetArg, cwd);
  const extensionId = path.basename(extensionDir);
  const relativeExtensionDir = normalizeRelative(path.relative(repoRoot, extensionDir));

  const roots = [relativeExtensionDir];

  const config = resolveExtensionTestConfig(relativeExtensionDir);
  const testFileCount = roots.reduce(
    (sum, root) => sum + countTestFiles(path.join(repoRoot, root)),
    0,
  );
  const workerFiles = databaseWorkerExtensionTestFiles.filter(
    (file) =>
      file.startsWith(`${relativeExtensionDir}/`) && fs.existsSync(path.join(repoRoot, file)),
  );
  const groups = [{ config, roots, testFileCount: testFileCount - workerFiles.length }];
  if (workerFiles.length > 0) {
    groups.push({
      config: resolveExtensionTestConfig(workerFiles[0]!),
      roots: workerFiles,
      testFileCount: workerFiles.length,
    });
  }
  const planGroups = groups
    .filter((group) => group.testFileCount > 0)
    .map((group) =>
      Object.assign({}, group, {
        extensionIds: [extensionId],
        estimatedCost: estimateExtensionTestCost(group.config, group.testFileCount, group.roots),
      }),
    );
  const estimatedCost = planGroups.reduce((sum, group) => sum + group.estimatedCost, 0);

  return {
    config,
    estimatedCost,
    extensionDir: relativeExtensionDir,
    extensionId,
    hasTests: testFileCount > 0,
    planGroups,
    roots,
    testFileCount,
  };
}

type ResolvedExtensionTestPlan = ReturnType<typeof resolveExtensionTestPlan>;

export function mergeExtensionTestPlans(plans: ResolvedExtensionTestPlan[]): ExtensionBatchPlan {
  const groupsByConfig = new Map<string, ExtensionTestPlanGroup>();

  const testPlans = plans.filter((plan) => plan.hasTests);
  const noTestExtensionIds = plans
    .filter((plan) => !plan.hasTests)
    .map((plan) => plan.extensionId)
    .toSorted((left, right) => left.localeCompare(right));

  for (const plan of testPlans.flatMap((entry) => entry.planGroups)) {
    const current = groupsByConfig.get(plan.config) ?? {
      config: plan.config,
      extensionIds: [],
      roots: [],
      estimatedCost: 0,
      testFileCount: 0,
    };

    current.extensionIds.push(...plan.extensionIds);
    current.roots.push(...plan.roots);
    current.estimatedCost += plan.estimatedCost;
    current.testFileCount += plan.testFileCount;
    groupsByConfig.set(plan.config, current);
  }

  const planGroups = [...groupsByConfig.values()]
    .map((group) =>
      Object.assign({}, group, {
        extensionIds: group.extensionIds.toSorted((left, right) => left.localeCompare(right)),
        roots: [...new Set(group.roots)],
      }),
    )
    .toSorted((left, right) => left.config.localeCompare(right.config));

  return {
    extensionCount: plans.length,
    extensionIds: plans
      .map((plan) => plan.extensionId)
      .toSorted((left, right) => left.localeCompare(right)),
    estimatedCost: testPlans.reduce((sum, plan) => sum + plan.estimatedCost, 0),
    hasTests: testPlans.length > 0,
    noTestExtensionIds,
    planGroups,
    testFileCount: testPlans.reduce((sum, plan) => sum + plan.testFileCount, 0),
  };
}

/** Resolve a combined extension test plan for explicit or all available extension ids. */
export function resolveExtensionBatchPlan(params: { cwd?: string; extensionIds?: string[] } = {}) {
  const cwd = params.cwd ?? process.cwd();
  const hasExplicitExtensionIds = params.extensionIds !== undefined;
  const extensionIds = params.extensionIds ?? listAvailableExtensionIds();
  const plans = extensionIds.map((extensionId) =>
    resolveExtensionTestPlan({ cwd, targetArg: extensionId }),
  );

  return mergeExtensionTestPlans(
    hasExplicitExtensionIds ? plans : plans.filter((plan) => plan.hasTests),
  );
}

type PendingExtensionTestShard = {
  estimatedCost: number;
  plans: ResolvedExtensionTestPlan[];
  testFileCount: number;
};

function pickLeastLoadedShard(shards: PendingExtensionTestShard[]) {
  return shards.reduce((best, shard) => {
    if (shard.estimatedCost !== best.estimatedCost) {
      return shard.estimatedCost < best.estimatedCost ? shard : best;
    }
    if (shard.testFileCount !== best.testFileCount) {
      return shard.testFileCount < best.testFileCount ? shard : best;
    }
    return shard.plans.length < best.plans.length ? shard : best;
  });
}

/** Create balanced extension test shards from per-extension plans. */
export function createExtensionTestShards(
  params: { cwd?: string; extensionIds?: string[]; shardCount?: number | string } = {},
): ExtensionTestShard[] {
  const cwd = params.cwd ?? process.cwd();
  const extensionIds = params.extensionIds ?? listAvailableExtensionIds();
  const shardCount =
    params.shardCount === undefined ? 1 : parsePositiveInt(String(params.shardCount), "shardCount");
  const plans = extensionIds
    .map((extensionId) => resolveExtensionTestPlan({ cwd, targetArg: extensionId }))
    .filter((plan) => plan.hasTests)
    .toSorted((left, right) => {
      if (left.estimatedCost !== right.estimatedCost) {
        return right.estimatedCost - left.estimatedCost;
      }
      if (left.testFileCount !== right.testFileCount) {
        return right.testFileCount - left.testFileCount;
      }
      return left.extensionId.localeCompare(right.extensionId);
    });

  const effectiveShardCount = Math.min(shardCount, Math.max(1, plans.length));
  const shards: PendingExtensionTestShard[] = Array.from({ length: effectiveShardCount }, () => ({
    estimatedCost: 0,
    plans: [],
    testFileCount: 0,
  }));

  for (const plan of plans) {
    const target = pickLeastLoadedShard(shards);
    target.plans.push(plan);
    target.estimatedCost += plan.estimatedCost;
    target.testFileCount += plan.testFileCount;
  }

  return shards
    .map((shard, index) =>
      Object.assign(
        {},
        { index, checkName: `checks-node-extensions-shard-${index + 1}` },
        mergeExtensionTestPlans(shard.plans),
      ),
    )
    .filter((shard) => shard.hasTests);
}
