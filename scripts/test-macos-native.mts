// CI resource owner; the disposable credentialless runner is the isolation boundary.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { root as openCaptureRoot } from "@openclaw/fs-safe/root";
import { readProcessIdentity } from "@openclaw/proc-safe/identity";
import { runWithFailedTrailer } from "./lib/failed-trailer.mts";
import { runManagedCommand, waitForManagedProcessGroupExit } from "./lib/managed-child-process.mts";

function validateSwiftTestingCompletion(eventStreamPath: string, expectedFilter?: string): void {
  const functions = new Set<string>();
  const started = new Set<string>();
  const completed = new Set<string>();
  let phase: "pending" | "running" | "ended" = "pending";
  const lines = fs.readFileSync(eventStreamPath, "utf8").split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  for (const line of lines) {
    const record: unknown = JSON.parse(line);
    if (typeof record !== "object" || record === null || !("kind" in record)) {
      throw new Error("Invalid Swift Testing event record");
    }
    // Swift Testing permits new record and event kinds without a schema change.
    if (record.kind !== "event" && record.kind !== "test") {
      continue;
    }
    if (!("version" in record) || record.version !== "6.3.0") {
      throw new Error("Expected Swift Testing event schema 6.3.0");
    }
    if (record.kind === "test") {
      if (
        "payload" in record &&
        typeof record.payload === "object" &&
        record.payload !== null &&
        "kind" in record.payload &&
        record.payload.kind === "function" &&
        "id" in record.payload &&
        typeof record.payload.id === "string" &&
        expectedFilter !== undefined &&
        record.payload.id.includes(expectedFilter)
      ) {
        functions.add(record.payload.id);
      }
      continue;
    }
    if (
      !("payload" in record) ||
      typeof record.payload !== "object" ||
      record.payload === null ||
      !("kind" in record.payload) ||
      typeof record.payload.kind !== "string"
    ) {
      throw new Error("Invalid Swift Testing event payload");
    }
    if (
      "testID" in record.payload &&
      typeof record.payload.testID === "string" &&
      functions.has(record.payload.testID)
    ) {
      if (record.payload.kind === "testStarted") {
        started.add(record.payload.testID);
      }
      if (record.payload.kind === "testEnded" && started.has(record.payload.testID)) {
        completed.add(record.payload.testID);
      }
      if (record.payload.kind === "testSkipped" || record.payload.kind === "testCancelled") {
        started.delete(record.payload.testID);
      }
    }
    if (record.payload.kind === "runStarted") {
      if (phase !== "pending") {
        throw new Error("Unexpected Swift Testing runStarted");
      }
      phase = "running";
    } else if (record.payload.kind === "runEnded") {
      if (phase !== "running") {
        throw new Error("Unexpected Swift Testing runEnded");
      }
      phase = "ended";
    }
  }
  if (phase !== "ended" || (expectedFilter !== undefined && completed.size === 0)) {
    throw new Error("Swift Testing did not finish its run");
  }
}

await runWithFailedTrailer("macos-native", async () => {
  const env = process.env;
  // Invocation checks prevent accidental local use; these markers are not a sandbox.
  if (
    env.CI !== "true" ||
    env.GITHUB_ACTIONS !== "true" ||
    env.RUNNER_OS !== "macOS" ||
    !env.RUNNER_TEMP ||
    !env.HOME ||
    process.platform === "win32"
  ) {
    throw new Error(
      "Run native app tests in the disposable macos-swift GitHub CI job, never on an operator desktop.",
    );
  }
  const [profileMode, ...args] = process.argv.slice(2);
  const appHost = profileMode === "app-host";
  let appHostConfiguration:
    | {
        executable: string;
        testBundle: string;
        filters: [string, string];
      }
    | undefined;
  if (appHost) {
    const [appPath, testBundle, retryFilter, relaunchFilter] = args;
    if (args.length !== 4 || !appPath || !testBundle || !retryFilter || !relaunchFilter) {
      throw new Error(
        "App-host mode requires a staged app, built test bundle, Retry filter, and relaunch filter.",
      );
    }
    const app = fs.realpathSync(appPath);
    if (path.extname(app) !== ".app" || !fs.statSync(testBundle).isFile()) {
      throw new Error("App-host mode requires an actual .app and compiled test executable.");
    }
    appHostConfiguration = {
      executable: path.join(app, "Contents/MacOS/OpenClawRecoveryTestHost"),
      testBundle,
      filters: [retryFilter, relaunchFilter],
    };
  }
  if (profileMode !== "default" && profileMode !== "named" && !appHost) {
    throw new Error("Select default or named profile semantics before the Swift test arguments.");
  }
  if (!appHost && !args.includes("--skip-build")) {
    throw new Error(
      "Build tests first with swift build --build-tests; this launcher requires --skip-build.",
    );
  }

  // Keep paths short for tools honoring TMPDIR, independently of RUNNER_TEMP's length.
  // Foundation's Darwin temp directory belongs to the disposable OS worker instead.
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/oc-test-"));
  let canRemove = true;
  let ownedProfileState: string | undefined;
  try {
    const resourceHome = path.join(root, "home");
    const home = appHost ? fs.realpathSync(env.HOME) : resourceHome;
    const profile = profileMode === "named" || appHost ? `test-${randomUUID()}` : "default";
    const state = appHost ? path.join(home, `.openclaw-${profile}`) : path.join(root, "state");
    const tmp = path.join(root, "tmp");
    const menuCaptures = path.join(root, "menu-captures");
    for (const dir of [resourceHome, state, tmp, menuCaptures]) {
      fs.mkdirSync(dir, { mode: 0o700 });
      if (appHost && dir === state) {
        ownedProfileState = state;
      }
    }
    const captureRoot = await openCaptureRoot(menuCaptures);
    const childEnv: NodeJS.ProcessEnv = {};
    for (const key of [
      "PATH",
      "DEVELOPER_DIR",
      "SDKROOT",
      "TOOLCHAINS",
      "LANG",
      "LC_ALL",
      "TERM",
      "DYLD_FRAMEWORK_PATH",
      "DYLD_LIBRARY_PATH",
      "LLVM_PROFILE_FILE",
      "SWIFTPM_MODULECACHE_OVERRIDE",
      "CLANG_MODULE_CACHE_PATH",
      // Preserve Actions' orphan-cleanup correlation through the isolated child env.
      "RUNNER_TRACKING_ID",
    ]) {
      if (env[key] !== undefined) {
        childEnv[key] = env[key];
      }
    }
    Object.assign(childEnv, {
      CI: "true",
      HOME: home,
      CFFIXED_USER_HOME: home,
      TMPDIR: `${tmp}/`,
      TMP: tmp,
      TEMP: tmp,
      // macOS defaults to terminal-only backtraces; CI must never wait for crash interaction.
      SWIFT_BACKTRACE:
        "enable=yes,interactive=no,color=no,sanitize=yes,threads=crashed,registers=none,images=mentioned",
      // SwiftPM forwards test output through buffered print calls, including stalled diagnostics.
      NSUnbufferedIO: "YES",
      // The full suite protects default-profile lifecycle behavior. Named-profile
      // construction is exercised separately; both use the disposable runner's account.
      OPENCLAW_PROFILE: profile,
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
      OPENCLAW_TEST_MENU_CAPTURE_DIR: menuCaptures,
    });
    if (appHost) {
      // Preserve primary CLI failure reasons from disposable recovery commands in native diagnostics.
      childEnv.OPENCLAW_DEBUG = "1";
    }

    // Keep SwiftPM's build cache available without inheriting the runner's app state.
    const cache = path.join(resourceHome, "Library/Caches");
    fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
    fs.symlinkSync(
      path.join(env.HOME, "Library/Caches/org.swift.swiftpm"),
      path.join(cache, "org.swift.swiftpm"),
    );
    const keychain = path.join(resourceHome, "Library/Keychains/native-tests.keychain-db");
    // Security writes its user preferences beneath HOME but does not create the parent.
    for (const dir of [path.dirname(keychain), path.join(home, "Library/Preferences")]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const run = async (bin: string, commandArgs: string[], timeoutMs?: number) => {
      canRemove = false;
      const code = await runManagedCommand({
        bin,
        args: commandArgs,
        env: childEnv,
        stdio: "inherit",
        requireProcessTreeExit: true,
        timeoutMs,
      });
      canRemove = true;
      return code;
    };
    const serviceTarget = `gui/${process.getuid?.()}/ai.openclaw.${profile}`;
    const gatewayPids = new Set<number>();
    const inspectService = async () => {
      const output = path.join(root, "service-inspection.txt");
      const fd = fs.openSync(output, "w", 0o600);
      try {
        canRemove = false;
        const code = await runManagedCommand({
          bin: "launchctl",
          args: ["print", serviceTarget],
          env: childEnv,
          stdio: ["ignore", fd, fd],
          requireProcessTreeExit: true,
          timeoutMs: 30_000,
        });
        canRemove = true;
        const text = fs.readFileSync(output, "utf8");
        const pid = /^\tpid = ([0-9]+)$/mu.exec(text)?.[1];
        if (code === 0 && pid) {
          gatewayPids.add(Number(pid));
        }
        return { code, text };
      } finally {
        fs.closeSync(fd);
      }
    };
    // Empty test-only password prevents prompts; no automatic locking while the suite runs.
    // Only the user domain changes. Common/dynamic Keychains still require a disposable host.
    try {
      for (const command of [
        ["create-keychain", "-p", "", keychain],
        ["unlock-keychain", "-p", "", keychain],
        ["set-keychain-settings", keychain],
        ["list-keychains", "-d", "user", "-s", keychain],
        ["default-keychain", "-d", "user", "-s", keychain],
      ]) {
        process.exitCode = await run("security", command, 30_000);
        if (process.exitCode !== 0) {
          console.error(`[macos-native] security ${command[0]} failed (exit ${process.exitCode})`);
          return;
        }
      }
      const eventStreamPath = path.join(root, "swift-testing-events.jsonl");
      if (appHostConfiguration) {
        const diagnostics = fs.mkdtempSync(path.join(env.RUNNER_TEMP, "openclaw-recovery-events-"));
        console.error(`[macos-native] App-host event artifacts: ${diagnostics}`);
        if (env.GITHUB_OUTPUT) {
          fs.appendFileSync(env.GITHUB_OUTPUT, `recovery-artifact-path=${diagnostics}\n`);
        }
        let phase = 0;
        // Relaunch changes process-wide singletons while retaining this owned profile and state.
        for (const filter of appHostConfiguration.filters) {
          process.exitCode = await run(appHostConfiguration.executable, [
            "--test-bundle-path",
            appHostConfiguration.testBundle,
            "--testing-library",
            "swift-testing",
            "--filter",
            filter,
            "--event-stream-output-path",
            eventStreamPath,
            "--event-stream-version",
            "6.3",
          ]);
          // Preserve the real event stream even when a host fails or the next launch overwrites it.
          if (fs.existsSync(eventStreamPath)) {
            fs.copyFileSync(eventStreamPath, path.join(diagnostics, `phase-${phase}-events.jsonl`));
          }
          phase += 1;
          if (process.exitCode !== 0) {
            break;
          }
          validateSwiftTestingCompletion(eventStreamPath, filter);
          await inspectService();
        }
      } else {
        process.exitCode = await run("swift", [
          "test",
          ...args,
          "--event-stream-output-path",
          eventStreamPath,
          "--event-stream-version",
          "6.3",
        ]);
      }
      // Export synthetic images after every child/output closes and before resource cleanup.
      try {
        const exported = fs.mkdtempSync(
          path.join(env.RUNNER_TEMP, `openclaw-menu-${profileMode}-`),
        );
        const names =
          profileMode === "default"
            ? [
                "catalog",
                "selected",
                "effort",
                "fast",
                "inherited",
                "browser-sign-in-before",
                "browser-sign-in-after",
                "guest-model-permitted",
                "guest-model-null",
                "guest-model-open",
                "guest-model-invalidated",
                "guest-model-recovered",
                "history-message-recovery",
              ]
            : ["thread-reasoning", "thread-tool-activity", "model-initial", "thread-restored"];
        const allowed = new RegExp(
          `^(?:${names.join("|")})(?:-window\\.png|-menu-[0-9]+\\.png|-capture-status\\.json)$`,
        );
        const files: string[] = [];
        for (const entry of fs.readdirSync(menuCaptures, { withFileTypes: true })) {
          if (!entry.isFile() || !allowed.test(entry.name)) {
            continue;
          }
          const source = await captureRoot.open(entry.name, {
            hardlinks: "reject",
            symlinks: "reject",
          });
          try {
            const before = await source.handle.stat({ bigint: true });
            const bytes = await source.handle.readFile();
            const after = await source.handle.stat({ bigint: true });
            const current = await fs.promises.lstat(path.join(menuCaptures, entry.name), {
              bigint: true,
            });
            if (
              BigInt(bytes.byteLength) !== before.size ||
              [before, after, current].some(
                (stat) =>
                  !stat.isFile() ||
                  stat.nlink !== 1n ||
                  stat.dev !== before.dev ||
                  stat.ino !== before.ino ||
                  stat.size !== before.size ||
                  stat.mtimeNs !== before.mtimeNs ||
                  stat.ctimeNs !== before.ctimeNs,
              )
            ) {
              throw new Error(`Menu capture changed before export: ${entry.name}`);
            }
            fs.writeFileSync(path.join(exported, entry.name), bytes, { flag: "wx", mode: 0o600 });
            files.push(entry.name);
          } finally {
            await source.handle.close();
          }
        }
        fs.writeFileSync(
          path.join(exported, "capture-export.json"),
          JSON.stringify(
            {
              profileMode,
              source: "ordinary-swift-run",
              swiftExitCode: process.exitCode,
              files,
              missingCaptureStatus: names.filter(
                (name) => !files.includes(`${name}-capture-status.json`),
              ),
              requiresVisualInspection: true,
            },
            null,
            2,
          ) + "\n",
        );
        if (env.GITHUB_OUTPUT) {
          fs.appendFileSync(env.GITHUB_OUTPUT, `menu-${profileMode}-artifact-path=${exported}\n`);
        }
        console.error(`[macos-native] Synthetic menu capture artifacts: ${exported}`);
      } catch (captureError) {
        console.error(
          "[macos-native] Menu capture export unavailable; preserving test outcome",
          captureError,
        );
      }
      if (process.exitCode === 0) {
        try {
          validateSwiftTestingCompletion(eventStreamPath);
        } catch (error) {
          process.exitCode = 1;
          console.error("[macos-native] Swift exited 0 without valid test completion", error);
        }
      }
    } finally {
      if (appHost && canRemove) {
        await inspectService();
        await run("launchctl", ["bootout", serviceTarget], 30_000);
        const inspection = await inspectService();
        let retired = inspection.code !== 0 && /could not find service/iu.test(inspection.text);
        canRemove = false;
        for (const pid of gatewayPids) {
          const groupGone = await waitForManagedProcessGroupExit({ pid }, 30_000, {
            errorPolicy: "indeterminate",
          });
          retired &&= groupGone && readProcessIdentity(pid) === null;
        }
        canRemove = retired;
        if (!canRemove) {
          process.exitCode ||= 1;
          console.error(`[macos-native] test Gateway retirement is unverified: ${serviceTarget}`);
        }
      }
      // A completed failed create may leave a database. Never delete it until every child closed.
      if (canRemove && fs.existsSync(keychain)) {
        const cleanupCode = await run("security", ["delete-keychain", keychain], 30_000);
        if (cleanupCode !== 0) {
          canRemove = false;
          process.exitCode ||= cleanupCode;
          console.error(`[macos-native] security delete-keychain failed (exit ${cleanupCode})`);
        }
      }
    }
  } finally {
    // Retain evidence/resources if process-tree completion could not be established.
    if (canRemove) {
      if (ownedProfileState) {
        fs.rmSync(ownedProfileState, { recursive: true, force: true });
      }
      fs.rmSync(root, { recursive: true, force: true });
    } else {
      console.error(`[macos-native] retained resources after incomplete launch/cleanup: ${root}`);
      if (ownedProfileState) {
        console.error(`[macos-native] retained profile state: ${ownedProfileState}`);
      }
    }
  }
});
