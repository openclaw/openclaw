// CI resource owner; the disposable credentialless runner is the isolation boundary.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { root as openCaptureRoot } from "@openclaw/fs-safe/root";
import { runWithFailedTrailer } from "./lib/failed-trailer.mts";
import { runManagedCommand } from "./lib/managed-child-process.mts";

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
  if (profileMode !== "default" && profileMode !== "named") {
    throw new Error("Select default or named profile semantics before the Swift test arguments.");
  }
  if (!args.includes("--skip-build")) {
    throw new Error(
      "Build tests first with swift build --build-tests; this launcher requires --skip-build.",
    );
  }

  // Keep paths short for tools honoring TMPDIR, independently of RUNNER_TEMP's length.
  // Foundation's Darwin temp directory belongs to the disposable OS worker instead.
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/oc-test-"));
  let canRemove = true;
  try {
    const home = path.join(root, "home");
    const state = path.join(root, "state");
    const tmp = path.join(root, "tmp");
    const menuCaptures = path.join(root, "menu-captures");
    for (const dir of [home, state, tmp, menuCaptures]) {
      fs.mkdirSync(dir, { mode: 0o700 });
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
      // The full suite protects default-profile lifecycle behavior. Named-profile
      // construction is exercised separately; both use the disposable runner's account.
      OPENCLAW_PROFILE: profileMode === "named" ? `test-${randomUUID()}` : "default",
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
      OPENCLAW_TEST_MENU_CAPTURE_DIR: menuCaptures,
    });

    // Keep SwiftPM's build cache available without inheriting the runner's app state.
    const cache = path.join(home, "Library/Caches");
    fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
    fs.symlinkSync(
      path.join(env.HOME, "Library/Caches/org.swift.swiftpm"),
      path.join(cache, "org.swift.swiftpm"),
    );
    const keychain = path.join(home, "Library/Keychains/native-tests.keychain-db");
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
      process.exitCode = await run("swift", [
        "test",
        ...args,
        "--event-stream-output-path",
        eventStreamPath,
        "--event-stream-version",
        "6.3",
      ]);
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
            if (record.kind !== "event") {
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
          if (phase !== "ended") {
            throw new Error("Swift Testing did not finish its run");
          }
        } catch (error) {
          process.exitCode = 1;
          console.error("[macos-native] Swift exited 0 without valid test completion", error);
        }
      }
    } finally {
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
      fs.rmSync(root, { recursive: true, force: true });
    } else {
      console.error(`[macos-native] retained resources after incomplete launch/cleanup: ${root}`);
    }
  }
});
