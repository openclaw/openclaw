/** Explicit-maintenance acquisition of immutable, official macOS desktop generations. */
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import {
  commandProcessCleanup,
  runExec,
  withCommandProcessScope,
} from "openclaw/plugin-sdk/process-runtime";
import { assertNoSymlinkParents } from "openclaw/plugin-sdk/security-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  assertDirectoryIdentityStable,
  directoryIdentityIsStable,
  readRealDirectoryIdentity,
} from "./computer-use-service-path.js";
import {
  observeCodexManagedDesktopSelection,
  publishCodexManagedDesktopSelection,
  readCodexManagedDesktopSelection,
  resolveCodexManagedDesktopAppPath,
  resolveCodexManagedDesktopRoot,
  type CodexManagedDesktopSelection,
  type CodexManagedDesktopStateOptions,
} from "./managed-desktop-installation.js";

const TEAM_ID = "2DC432GLL2";
const BUNDLE_ID = "com.openai.codex";
const INSPECT_TIMEOUT_MS = 30_000;
const COPY_TIMEOUT_MS = 120_000;
const DOWNLOAD_TIMEOUT_MS = 600_000;
const CLI_PATH = path.join("Contents", "Resources", "codex");

type AppIdentity = { build: string; signature: string; filesystem: string };
type Execute = typeof runExec;
type Candidate = { appBundlePath: string; appServerCommandPath: string };
type DirectoryIdentity = Awaited<ReturnType<typeof readRealDirectoryIdentity>>;

export type CodexDesktopAppUpdateResult = {
  status: "updated" | "current";
  oldVersion: string;
  newVersion: string;
  appBundlePath: string;
  /** Previous selection is retained at its original path, not moved or copied. */
  backupPath?: string;
  warnings?: string[];
};

/** The maintenance caller owns selection and compatibility; publication owns its SQLite selection. */
export async function updateCodexDesktopApp(
  params: CodexManagedDesktopStateOptions & {
    appBundlePath: string;
    signal: AbortSignal;
    assertCurrent: () => void;
    /** Must settle candidate processes, or reject with a canonical cleanup-uncertain error. */
    validateCandidate: (candidate: Candidate) => Promise<void>;
    deps?: {
      runExec?: Execute;
      platform?: NodeJS.Platform;
      /** Process architecture; x64 still requires a host probe to detect Rosetta. */
      arch?: string;
      managedRoot?: string;
    };
  },
): Promise<CodexDesktopAppUpdateResult> {
  if ((params.deps?.platform ?? process.platform) !== "darwin") {
    throw new Error("Official Codex desktop updates require macOS.");
  }
  const target = path.resolve(params.appBundlePath);
  const appName = path.basename(target);
  if (appName !== "ChatGPT.app" && appName !== "Codex.app") {
    throw new Error("Codex desktop maintenance only updates the selected official app bundle.");
  }
  const managedRoot = path.resolve(params.deps?.managedRoot ?? resolveCodexManagedDesktopRoot());
  const observation = await observeCodexManagedDesktopSelection({ ...params, root: managedRoot });
  const previous = observation.installation;
  if (previous && previous.appBundlePath !== target) {
    throw new Error("Codex managed desktop selection changed; retry the update.");
  }

  const execute = params.deps?.runExec ?? runExec;
  const assertCurrent = () => {
    params.signal.throwIfAborted();
    params.assertCurrent();
  };
  const exec = async (command: string, args: string[], timeoutMs = INSPECT_TIMEOUT_MS) => {
    assertCurrent();
    // Join canceled download/copy processes before cleaning their owned paths.
    return await withCommandProcessScope(
      () => execute(command, args, { signal: params.signal, timeoutMs, logOutput: false }),
      params.signal,
    );
  };
  const hostArch = await resolveMacOSHostArchitecture(params.deps?.arch ?? process.arch, exec);
  const url = resolveOfficialDownload(appName, hostArch);
  const initial = await inspectApp(target, exec);
  const versions = path.join(managedRoot, "versions");
  await assertNoSymlinkParents({
    rootDir: path.parse(managedRoot).root,
    targetPath: versions,
    allowMissing: true,
    requireDirectories: true,
    messagePrefix: "Codex managed desktop",
  });
  assertCurrent();
  await fs.mkdir(versions, { recursive: true, mode: 0o700 });
  const managedIdentity = await readRealDirectoryIdentity(
    managedRoot,
    "Codex managed desktop root",
  );
  const versionsIdentity = await readRealDirectoryIdentity(versions, "Codex desktop versions");
  for (const directory of [managedRoot, versions]) {
    const stat = await fs.lstat(directory);
    if ((process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o022) !== 0) {
      throw new Error(
        "Codex managed desktop directories must be owned by this user and not shared-writable.",
      );
    }
  }
  await assertNoSymlinkParents({
    rootDir: path.parse(managedRoot).root,
    targetPath: versions,
    allowMissing: false,
    requireDirectories: true,
    messagePrefix: "Codex managed desktop",
  });
  assertCurrent();
  const root = await fs.mkdtemp(path.join(managedRoot, ".download-"));
  const rootIdentity = await readRealDirectoryIdentity(root, "Codex desktop download directory");
  const mount = path.join(root, "mount");
  const image = path.join(root, "desktop.dmg");
  let mountAttempted = false;
  let generationIdentity: DirectoryIdentity | undefined;
  let selection: CodexManagedDesktopSelection | undefined;
  let candidatePath: string | undefined;
  let candidateBuild: string | undefined;
  let publicationAttempted = false;
  let retainGeneration = false;
  let retainWork = false;
  let outcome: CodexDesktopAppUpdateResult | undefined;
  let failure: unknown;
  const cleanupErrors: Error[] = [];
  let versionWarnings: string[] = [];
  const updatedResult = (): CodexDesktopAppUpdateResult => ({
    status: "updated",
    oldVersion: initial.build,
    newVersion: candidateBuild!,
    appBundlePath: candidatePath!,
    backupPath: target,
    ...(versionWarnings.length > 0 ? { warnings: versionWarnings } : {}),
  });
  try {
    await exec(
      "/usr/bin/curl",
      [
        "--disable",
        "--fail",
        "--location",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--max-redirs",
        "5",
        "--retry",
        "2",
        "--connect-timeout",
        "30",
        "--output",
        image,
        url,
      ],
      DOWNLOAD_TIMEOUT_MS,
    );
    await assertDirectoryIdentityStable(rootIdentity, "Codex desktop download directory");
    assertCurrent();
    await fs.mkdir(mount, { mode: 0o700 });
    mountAttempted = true;
    await exec(
      "/usr/bin/hdiutil",
      ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, image],
      COPY_TIMEOUT_MS,
    );
    const downloaded = await findMountedDesktopApp(mount);
    const candidate = await inspectApp(downloaded.path, exec);
    const buildComparison = compareBuilds(candidate.build, initial.build);
    versionWarnings =
      buildComparison < 0
        ? [
            `Latest official desktop build ${candidate.build} is older than installed build ${initial.build}; retained the installed build.`,
          ]
        : [];
    if (previous && buildComparison <= 0) {
      assertCurrent();
      await params.validateCandidate(candidatePaths(target));
      await assertAppUnchanged(target, initial, exec);
      const current = await observeCodexManagedDesktopSelection({ ...params, root: managedRoot });
      if (current.comparison !== observation.comparison) {
        throw new Error("Codex managed desktop selection changed; retry the update.");
      }
      assertCurrent();
      outcome = {
        status: "current",
        oldVersion: initial.build,
        newVersion: initial.build,
        appBundlePath: target,
        ...(versionWarnings.length > 0 ? { warnings: versionWarnings } : {}),
      };
    } else {
      // First acquisition seals even an already-current installation. Future desktop
      // app updates must not mutate the executable used by active managed sessions.
      const source = buildComparison > 0 ? downloaded.path : target;
      const sourceIdentity = buildComparison > 0 ? candidate : initial;
      const sourceName = buildComparison > 0 ? downloaded.appName : appName;
      await assertDirectoryIdentityStable(managedIdentity, "Codex managed desktop root");
      await assertDirectoryIdentityStable(versionsIdentity, "Codex desktop versions");
      assertCurrent();
      const generation = await fs.mkdtemp(
        path.join(
          versions,
          `${sourceIdentity.build.slice(0, 32)}-${sourceIdentity.signature.slice(0, 32)}-`,
        ),
      );
      generationIdentity = await readRealDirectoryIdentity(generation, "Codex desktop generation");
      selection = { version: 1, appName: sourceName, generation: path.basename(generation) };
      candidatePath = resolveCodexManagedDesktopAppPath(selection, managedRoot);
      candidateBuild = sourceIdentity.build;
      await exec("/usr/bin/ditto", ["--noqtn", source, candidatePath], COPY_TIMEOUT_MS);
      const copied = await inspectApp(candidatePath, exec);
      if (sourceIdentity.signature !== copied.signature || sourceIdentity.build !== copied.build) {
        throw new Error("Copied Codex desktop does not match its verified signed source.");
      }
      // This is the final path: TCC/service discovery and future readers see the same bytes.
      assertCurrent();
      await params.validateCandidate(candidatePaths(candidatePath));
      await assertAppUnchanged(candidatePath, copied, exec);
      await assertAppUnchanged(target, initial, exec);
      await assertDirectoryIdentityStable(managedIdentity, "Codex managed desktop root");
      await assertDirectoryIdentityStable(versionsIdentity, "Codex desktop versions");
      await assertDirectoryIdentityStable(generationIdentity, "Codex desktop generation");
      assertCurrent();
      publicationAttempted = true;
      await publishCodexManagedDesktopSelection({
        root: managedRoot,
        selection,
        env: params.env,
        store: params.store,
        expectedComparison: observation.comparison,
        signal: params.signal,
        assertCurrent,
      });
      retainGeneration = true;
      outcome = updatedResult();
    }
  } catch (error) {
    failure = error;
    if (commandProcessCleanup.isUncertain(error)) {
      // An unconfirmed probe/copy can still read or write these paths. Preserve its
      // artifacts and canonical error marker rather than treating rejection as exit.
      retainWork = true;
      retainGeneration = true;
    }
    // A SQLite write can commit before acknowledgement or cleanup reports failure.
    // Reconcile that exact generation, never delete an already selected bundle.
    if (publicationAttempted && selection) {
      // Even a superseded selection may already have admitted readers of this path.
      retainGeneration = true;
      try {
        const current = await readCodexManagedDesktopSelection(managedRoot, params);
        if (
          current?.selection.generation === selection.generation &&
          current.selection.appName === selection.appName
        ) {
          outcome = updatedResult();
          outcome.warnings = [
            ...(outcome.warnings ?? []),
            `Codex desktop selection was activated, but publication cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          ];
          if (!retainWork) {
            failure = undefined;
          }
        }
      } catch {
        // Ambiguous selection state retains the candidate for manual recovery.
      }
    }
  } finally {
    // Detach outlives caller cancellation, and a failed detach forbids recursive cleanup.
    let detached = !mountAttempted;
    if (mountAttempted && !retainWork) {
      try {
        await assertDirectoryIdentityStable(managedIdentity, "Codex managed desktop root");
        await assertDirectoryIdentityStable(rootIdentity, "Codex desktop download directory");
        await commandProcessCleanup.runOutsideScope(() =>
          withCommandProcessScope(() =>
            execute("/usr/bin/hdiutil", ["detach", mount], {
              timeoutMs: COPY_TIMEOUT_MS,
              logOutput: false,
            }),
          ),
        );
        detached = true;
      } catch (error) {
        if (commandProcessCleanup.isUncertain(error)) {
          retainWork = true;
          retainGeneration = true;
          failure ??= error;
        }
        cleanupErrors.push(
          new Error(`Codex desktop installer cleanup failed; retained ${root}.`, { cause: error }),
        );
      }
    }
    if (
      !retainWork &&
      detached &&
      (await directoryIdentityIsStable(managedIdentity)) &&
      (await directoryIdentityIsStable(rootIdentity))
    ) {
      await fs.rm(root, { recursive: true, force: true }).catch((error: unknown) => {
        cleanupErrors.push(
          new Error(`Could not remove Codex desktop download directory ${root}.`, { cause: error }),
        );
      });
    }
    if (
      !retainGeneration &&
      generationIdentity &&
      (await directoryIdentityIsStable(managedIdentity)) &&
      (await directoryIdentityIsStable(versionsIdentity)) &&
      (await directoryIdentityIsStable(generationIdentity))
    ) {
      await fs
        .rm(generationIdentity.logicalPath, { recursive: true, force: true })
        .catch((error: unknown) => {
          cleanupErrors.push(
            new Error(
              `Could not remove unselected Codex desktop generation ${generationIdentity?.logicalPath}.`,
              { cause: error },
            ),
          );
        });
    }
  }
  if (failure) {
    const recovery = [
      retainGeneration && candidatePath
        ? outcome
          ? ` Selection was activated; candidate retained at ${candidatePath}.`
          : publicationAttempted
            ? ` Selection state is unconfirmed; candidate retained at ${candidatePath}.`
            : ` Unselected candidate retained at ${candidatePath}.`
        : "",
      retainWork ? ` Process cleanup is unconfirmed; installer artifacts retained at ${root}.` : "",
    ].join("");
    if (cleanupErrors.length > 0 || recovery) {
      throw new AggregateError(
        [failure, ...cleanupErrors],
        [
          `${failure instanceof Error ? failure.message : "Codex desktop update failed"}${recovery}`,
          ...cleanupErrors.map((error) => error.message),
        ].join(" "),
      );
    }
    throw toErrorObject(failure, "Codex desktop update failed");
  }
  if (!outcome) {
    throw new Error("Codex desktop update did not produce a verified result.");
  }
  if (cleanupErrors.length > 0) {
    outcome.warnings = [
      ...(outcome.warnings ?? []),
      ...cleanupErrors.map((error) => error.message),
    ];
  }
  return outcome;
}

async function findMountedDesktopApp(mount: string): Promise<{
  path: string;
  appName: "ChatGPT.app" | "Codex.app";
}> {
  const recognized = (await fs.readdir(mount)).filter(
    (name) => name === "ChatGPT.app" || name === "Codex.app",
  );
  const appName = recognized[0];
  if (recognized.length !== 1 || !appName) {
    throw new Error("Official Codex installer must contain exactly one recognized desktop app.");
  }
  return { path: path.join(mount, appName), appName };
}

async function resolveMacOSHostArchitecture(
  processArch: string,
  exec: InspectExec,
): Promise<"arm64" | "x64"> {
  if (processArch === "arm64") {
    return "arm64";
  }
  if (processArch !== "x64") {
    throw new Error(`No official Codex desktop download is configured for ${processArch}.`);
  }
  // Like Codex's desktop_app/mac.rs, inspect hardware support rather than selecting
  // an Intel installer from a Node process that may be running through Rosetta.
  let hardware: string;
  try {
    hardware = (await exec("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"])).stdout.trim();
  } catch (error) {
    throw new Error("Could not establish Mac host architecture; desktop update was not started.", {
      cause: error,
    });
  }
  if (hardware === "1") {
    return "arm64";
  }
  if (hardware === "0") {
    return "x64";
  }
  throw new Error("Could not establish Mac host architecture; desktop update was not started.");
}

function resolveOfficialDownload(appName: string, arch: string): string {
  if (arch !== "arm64" && arch !== "x64") {
    throw new Error(`No official Codex desktop download is configured for ${arch}.`);
  }
  const base = "https://persistent.oaistatic.com/codex-app-prod/";
  if (appName === "ChatGPT.app") {
    return `${base}ChatGPT.dmg`;
  }
  if (appName === "Codex.app") {
    return `${base}${arch === "arm64" ? "Codex.dmg" : "Codex-latest-x64.dmg"}`;
  }
  throw new Error("Codex desktop maintenance only updates the selected official app bundle.");
}

type InspectExec = (
  command: string,
  args: string[],
  timeoutMs?: number,
) => Promise<{ stdout: string; stderr: string }>;

async function inspectApp(app: string, exec: InspectExec): Promise<AppIdentity> {
  await readRealDirectoryIdentity(app, "Codex desktop app");
  await assertNoSymlinkParents({
    rootDir: app,
    targetPath: path.join(app, "Contents", "Resources"),
    allowMissing: false,
    requireDirectories: true,
    messagePrefix: "Codex desktop app",
  });
  const before = await filesystemIdentity(app);
  const cli = path.join(app, CLI_PATH);
  await fs.access(cli, fsConstants.X_OK);
  const teamRequirement = `anchor apple generic and certificate leaf[subject.OU] = "${TEAM_ID}"`;
  await exec("/usr/bin/codesign", [
    "--verify",
    "--strict",
    "--deep",
    `-R=${teamRequirement} and identifier "${BUNDLE_ID}"`,
    app,
  ]);
  await exec("/usr/bin/codesign", ["--verify", "--strict", `-R=${teamRequirement}`, cli]);
  const infoResult = await exec("/usr/bin/plutil", [
    "-convert",
    "json",
    "-o",
    "-",
    "--",
    path.join(app, "Contents", "Info.plist"),
  ]);
  const info: unknown = JSON.parse(infoResult.stdout);
  if (
    !isRecord(info) ||
    info.CFBundleIdentifier !== BUNDLE_ID ||
    typeof info.CFBundleVersion !== "string" ||
    !/^\d+(?:\.\d+)*$/u.test(info.CFBundleVersion)
  ) {
    throw new Error(
      "Official Codex desktop has an unsupported signed bundle identity or build number.",
    );
  }
  const signature = await exec("/usr/bin/codesign", ["-d", "--verbose=4", app]);
  const cdHash = `${signature.stdout}\n${signature.stderr}`
    .match(/^CDHash=([a-f\d]+)$/imu)?.[1]
    ?.toLowerCase();
  if (!cdHash || before !== (await filesystemIdentity(app))) {
    throw new Error("Codex desktop changed while its signed identity was being verified.");
  }
  return { build: info.CFBundleVersion, signature: cdHash, filesystem: before };
}

async function filesystemIdentity(app: string): Promise<string> {
  const entries = await Promise.all(
    [app, path.join(app, "Contents", "Info.plist"), path.join(app, CLI_PATH)].map(
      async (entry, index) => {
        const stat = await fs.lstat(entry);
        if (stat.isSymbolicLink() || (index === 0 ? !stat.isDirectory() : !stat.isFile())) {
          throw new Error(`Codex desktop identity path must not be a symbolic link: ${entry}`);
        }
        return `${stat.dev}:${stat.ino}:${index === 0 ? "" : `${stat.size}:${stat.mtimeMs}`}`;
      },
    ),
  );
  return entries.join("|");
}

async function assertAppUnchanged(
  app: string,
  expected: AppIdentity,
  exec: InspectExec,
): Promise<void> {
  const actual = await inspectApp(app, exec);
  if (
    actual.build !== expected.build ||
    actual.signature !== expected.signature ||
    actual.filesystem !== expected.filesystem
  ) {
    throw new Error(
      "Selected Codex desktop changed during maintenance; refusing to change the runtime selection.",
    );
  }
}

function compareBuilds(left: string, right: string): number {
  const a = left.split(".").map(BigInt);
  const b = right.split(".").map(BigInt);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0n) !== (b[i] ?? 0n)) {
      return (a[i] ?? 0n) > (b[i] ?? 0n) ? 1 : -1;
    }
  }
  return 0;
}

function candidatePaths(appBundlePath: string): Candidate {
  return { appBundlePath, appServerCommandPath: path.join(appBundlePath, CLI_PATH) };
}
