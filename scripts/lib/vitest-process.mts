import { spawn, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { waitForever } from "../../src/cli/wait.ts";
import {
  readGitHubTestReports,
  printGitHubTestReport,
} from "../../test/helpers/github-network-report.mjs";
import { createTempDirTracker } from "../../test/helpers/temp-dir.ts";
import {
  resolveTestBrowserCache,
  resolveTestCorepackHome,
  readTestHomeSource,
  writeTestHomeSource,
} from "../../test/test-home-context.mts";
import {
  assertTestHomeSelection,
  LIVE_TEST_TRIGGER_ENV_KEYS,
  resolveTestHomePolicy,
  type TestHomeSelection,
} from "../../test/test-home-policy.mts";
import {
  createVitestProcessCompletion,
  shouldUseDetachedVitestProcessGroup,
} from "../vitest-process-group.mts";
import { runWithFailedTrailer, writeFailedTrailer } from "./failed-trailer.mts";
import { signalExitCode } from "./managed-child-process.mts";
import { resolveRepoRoot } from "./repo-root.mjs";
import {
  createVitestResourceOwner,
  findVitestResourceOwner,
} from "./vitest-resource-ownership.mts";

/** Own temporary files until the Vitest child, its group, and its pipes have joined. */
export function spawnOwnedVitestProcess(spec: {
  command: string;
  args: string[];
  options: SpawnOptions;
  // Preparatory tools share lifetime ownership, but are not Vitest home consumers.
  homeMode?: TestHomeSelection | "tooling";
  githubNetwork?: "live";
}) {
  const env = spec.options.env ?? process.env;
  const mode = spec.homeMode ?? "unknown";
  if (mode !== "tooling") {
    assertTestHomeSelection(env, mode);
  }
  const policy = resolveTestHomePolicy(env, mode === "tooling" ? "live-aware" : mode);
  const tempDirs = createTempDirTracker();
  const detached = spec.options.detached ?? shouldUseDetachedVitestProcessGroup();
  const verifiedGroup = detached && shouldUseDetachedVitestProcessGroup();
  let tempRoot: string | undefined;
  let owner: ReturnType<typeof createVitestResourceOwner> | undefined;
  let parent: { root: string; release: () => void } | undefined;
  const dispose = () => {
    owner?.assertReleased();
    tempDirs.cleanup();
    parent?.release();
  };
  let child;
  try {
    // Native realpath expands Windows short names before children create filesystem watchers.
    const containingRoot = fs.realpathSync.native(env.TMPDIR || env.TMP || env.TEMP || tmpdir());
    // An intermediate runner can die before publishing its own cleanup result.
    // Its containing owner must already hold the obligation before allocation.
    const containingOwner = findVitestResourceOwner(containingRoot);
    if (containingOwner) {
      parent = { root: containingOwner.root, release: containingOwner.claim() };
    }
    tempRoot = tempDirs.make("oc-vt-", containingRoot);
    owner = createVitestResourceOwner(tempRoot);
    const childEnv: NodeJS.ProcessEnv = { ...env, TMPDIR: tempRoot, TMP: tempRoot, TEMP: tempRoot };
    if (mode !== "tooling") {
      // The tooling shim avoids the shared tsx cache. Test children have this owned
      // temp namespace, so source subprocesses can reuse transforms until cleanup.
      delete childEnv.TSX_DISABLE_CACHE;
    }
    if (mode !== "tooling" && !(policy.live && policy.allowRealHome)) {
      const nativeHome = path.join(tempRoot, "home");
      fs.mkdirSync(nativeHome);
      const callerHome = env.HOME ?? env.USERPROFILE ?? homedir();
      childEnv.COREPACK_HOME = resolveTestCorepackHome(env, callerHome);
      childEnv.PLAYWRIGHT_BROWSERS_PATH = resolveTestBrowserCache(env, callerHome);
      // Set the actual process environment before config imports and Worker creation.
      // Worker-local process.env and restored os.homedir mocks cannot retarget libuv.
      if (!policy.hermetic) {
        const sourceHome =
          policy.live || policy.loadProfileEnv ? readTestHomeSource(env) : undefined;
        writeTestHomeSource(tempRoot, sourceHome ?? callerHome);
      }
      childEnv.HOME = nativeHome;
      childEnv.USERPROFILE = nativeHome;
    }
    if (policy.hermetic) {
      for (const key of [...LIVE_TEST_TRIGGER_ENV_KEYS, "OPENCLAW_LIVE_USE_REAL_HOME"]) {
        delete childEnv[key];
      }
    }
    if (mode !== "tooling") {
      childEnv.OPENCLAW_TEST_GITHUB_POLICY = spec.githubNetwork === "live" ? "live" : "offline";
      if (spec.githubNetwork !== "live") {
        const preload = path.join(
          resolveRepoRoot(import.meta.url),
          "test/helpers/github-network-preload.cjs",
        );
        const reportRoot =
          childEnv.OPENCLAW_TEST_GITHUB_REPORT_DIR ?? path.join(tempRoot, "github-attempts");
        fs.mkdirSync(reportRoot, { recursive: true });
        childEnv.OPENCLAW_TEST_GITHUB_REPORT_DIR = fs.mkdtempSync(path.join(reportRoot, "child-"));
        childEnv.OPENCLAW_TEST_GITHUB_NETWORK_GUARD = "1";
        const nodeOptions = childEnv.NODE_OPTIONS ?? "";
        childEnv.NODE_OPTIONS = `--require=${JSON.stringify(preload)} ${nodeOptions}`.trim();
        for (const key of Object.keys(childEnv)) {
          if (
            /^(?:GH_|GITHUB_).*(?:TOKEN|SECRET|PASSWORD|KEY)$/iu.test(key) ||
            ["GH_CONFIG_DIR", "SSH_AUTH_SOCK", "GIT_ASKPASS", "SSH_ASKPASS"].includes(
              key.toUpperCase(),
            )
          ) {
            delete childEnv[key];
          }
        }
      }
    }
    const options = { ...spec.options, detached, env: childEnv };
    child = spawn(spec.command, spec.args, options);
  } catch (error) {
    tempDirs.cleanup();
    parent?.release();
    throw error;
  }
  const completion = (async () => {
    try {
      const result = await createVitestProcessCompletion({ child, detached });
      if (verifiedGroup) {
        dispose();
      } else {
        // Keep the containing claim too: leader exit cannot certify descendants.
        console.error(
          `[vitest] retained temporary namespace ${tempRoot}; descendant completion is unverified on this non-group launch. Stop the remaining writers before removing this exact directory.`,
        );
      }
      return { ...result, groupJoined: verifiedGroup };
    } catch (error) {
      // A failed parent receipt can follow successful child disposal. Report
      // the still-owned ancestor, not a child directory already removed.
      const retainedRoot = tempRoot && tempDirs.dirs.has(tempRoot) ? tempRoot : parent?.root;
      // No PID means spawn failed; otherwise unverified writers still own the files.
      if (!child.pid) {
        dispose();
      } else if (retainedRoot) {
        throw Object.assign(
          new Error(
            `[vitest] retained temporary namespace ${retainedRoot}; child/group or nested resource completion was not verified. Stop the remaining writers before removing this exact directory.`,
            { cause: error },
          ),
          { processTreeState: "indeterminate" },
        );
      }
      throw error;
    }
  })();
  return { child, completion };
}

export async function exitVitestBySignal(signal: NodeJS.Signals): Promise<void> {
  process.kill(process.pid, signal);
  // Dependency signal handlers may finish cleanup and re-raise asynchronously.
  // A numeric return must not win that race.
  await waitForever();
}

/** Only public invocations report; internal children propagate their settled outcome. */
export function runVitestCli(
  tool: string,
  run: (exitBySignal: typeof exitVitestBySignal) => Promise<void>,
): Promise<void> {
  return runWithFailedTrailer(tool, () =>
    runGitHubOfflineTests(() =>
      run(async (signal) => {
        writeFailedTrailer(tool, signalExitCode(signal));
        await exitVitestBySignal(signal);
      }),
    ),
  );
}

/** Ordinary entrypoints own one report across preparation, workers and descendants. */
export async function runGitHubOfflineTests(run: () => Promise<void>): Promise<void> {
  if (
    process.env.OPENCLAW_TEST_GITHUB_NETWORK_GUARD === "1" &&
    process.env.OPENCLAW_TEST_GITHUB_REPORT_DIR
  ) {
    await run();
    return;
  }
  const supplied = process.env.OPENCLAW_TEST_GITHUB_REPORT_DIR;
  const parent =
    supplied ?? path.join(resolveRepoRoot(import.meta.url), ".artifacts/github-test-reports");
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, "run-"));
  process.env.OPENCLAW_TEST_GITHUB_REPORT_DIR = directory;
  const guard: typeof import("../../test/helpers/github-network-guard.mjs") = await import(
    pathToFileURL(
      path.join(resolveRepoRoot(import.meta.url), "test/helpers/github-network-guard.mjs"),
    ).href
  );
  const restore = guard.installGitHubNetworkGuard();
  const previousMarker = process.env.OPENCLAW_TEST_GITHUB_NETWORK_GUARD;
  process.env.OPENCLAW_TEST_GITHUB_NETWORK_GUARD = "1";
  let settled = false;
  try {
    await run();
    settled = true;
  } finally {
    const report = readGitHubTestReports(directory);
    printGitHubTestReport(report);
    if (report.incidental) {
      process.exitCode ||= 1;
    }
    restore();
    if (previousMarker === undefined) {
      delete process.env.OPENCLAW_TEST_GITHUB_NETWORK_GUARD;
    } else {
      process.env.OPENCLAW_TEST_GITHUB_NETWORK_GUARD = previousMarker;
    }
    if (supplied === undefined) {
      delete process.env.OPENCLAW_TEST_GITHUB_REPORT_DIR;
    } else {
      process.env.OPENCLAW_TEST_GITHUB_REPORT_DIR = supplied;
    }
    if (!supplied && settled && !report.incidental && process.platform !== "win32") {
      fs.rmSync(directory, { recursive: true, force: true });
    } else {
      console.error(`[github-test-guard] reports: ${directory}`);
    }
  }
}
