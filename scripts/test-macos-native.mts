// CI resource owner; the disposable credentialless runner is the isolation boundary.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runWithFailedTrailer } from "./lib/failed-trailer.mts";
import { runManagedCommand } from "./lib/managed-child-process.mts";

async function hasCompletedNativeReceipt(file: string): Promise<boolean> {
  try {
    const { isRecord } = await import("../packages/normalization-core/src/record-coerce.ts");
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size === 0 || stat.size > 1024 * 1024) {
      return false;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file));
    if (!text.endsWith("\n")) {
      return false;
    }
    const lines = text.slice(0, -1).split("\n");
    if (lines.length > 512) {
      return false;
    }
    const tests = new Map<string, { state: number }>();
    let functionID: string | undefined;
    let runState = 0;
    for (const line of lines) {
      if (Buffer.byteLength(line) > 64 * 1024) {
        return false;
      }
      const record: unknown = JSON.parse(line);
      if (!isRecord(record) || record.version !== 0 || !isRecord(record.payload)) {
        return false;
      }
      const value = record.payload;
      if (record.kind === "test") {
        if (
          runState !== 0 ||
          typeof value.id !== "string" ||
          !value.id ||
          value.id.length > 4096 ||
          tests.has(value.id)
        ) {
          return false;
        }
        if (value.kind === "function") {
          if (
            functionID !== undefined ||
            value.name !==
              "`native submissions retain exact authority through real Gateway effects`()" ||
            !isRecord(value.sourceLocation) ||
            value.sourceLocation.fileID !== "OpenClawIPCTests/NativeActionGatewayWireTests.swift" ||
            value.isParameterized !== false
          ) {
            return false;
          }
          functionID = value.id;
        } else if (value.kind !== "suite") {
          return false;
        }
        tests.set(value.id, { state: 0 });
      } else if (record.kind === "event") {
        if (value.kind === "runStarted") {
          if (runState !== 0 || functionID === undefined || value.testID !== undefined) {
            return false;
          }
          runState = 1;
        } else if (value.kind === "runEnded") {
          if (
            runState !== 1 ||
            value.testID !== undefined ||
            functionID === undefined ||
            tests.get(functionID)?.state !== 2 ||
            [...tests.values()].some((test) => test.state === 1)
          ) {
            return false;
          }
          runState = 2;
        } else {
          const test = typeof value.testID === "string" ? tests.get(value.testID) : undefined;
          if (runState !== 1 || !test) {
            return false;
          }
          if (value.kind === "testStarted" && test.state === 0) {
            test.state = 1;
          } else if (value.kind === "testEnded" && test.state === 1) {
            test.state = 2;
          } else if (value.kind === "valueAttached" && test.state === 1) {
            continue;
          } else {
            // Skips, cancellations and issues cannot certify this one required function.
            // Nonparameterized functions do not emit testCaseStarted/testCaseEnded.
            return false;
          }
        }
      } else {
        return false;
      }
    }
    return runState === 2;
  } catch {
    // Event bytes may contain fixture data; report only the closed receipt outcome.
    return false;
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
  if (profileMode !== "default" && profileMode !== "named") {
    throw new Error("Select default or named profile semantics before the Swift test arguments.");
  }
  let nativeActionFixture: string | undefined;
  const fixtureIndex = args.indexOf("--native-action-fixture");
  if (fixtureIndex !== -1) {
    const raw = args[fixtureIndex + 1];
    if (!raw || raw.length > 32_768) {
      throw new Error("Invalid native action fixture descriptor.");
    }
    // This plain-Node launcher must also work before workspace packages are built.
    const { isRecord } = await import("../packages/normalization-core/src/record-coerce.ts");
    let fixture: unknown;
    try {
      fixture = JSON.parse(raw);
    } catch {
      throw new Error("Invalid native action fixture descriptor.");
    }
    const fields = [
      "version",
      "gatewayURL",
      "controlURL",
      "controlToken",
      "gatewayID",
      "aliceProfileID",
      "bobProfileID",
      "cases",
      "media",
      "approvals",
    ];
    const caseIDs = [
      "allowed",
      "distinct",
      "foreign",
      "acl",
      "aclSuspended",
      "controlACL",
      "accepted",
      "profile",
      "profileSuspended",
      "controlProfile",
    ];
    const boundedText = (value: unknown, maximum: number) =>
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= maximum &&
      !value.includes("\0");
    if (
      !isRecord(fixture) ||
      fixture.version !== 1 ||
      Object.keys(fixture).length !== fields.length ||
      Object.keys(fixture).some((key) => !fields.includes(key)) ||
      !["controlToken", "gatewayID", "aliceProfileID", "bobProfileID"].every((key) =>
        boundedText(fixture[key], 256),
      )
    ) {
      throw new Error("Invalid native action fixture descriptor.");
    }
    const cases = fixture.cases;
    if (
      typeof fixture.controlToken !== "string" ||
      !/^[a-zA-Z0-9-]{16,128}$/.test(fixture.controlToken) ||
      fixture.aliceProfileID === fixture.bobProfileID ||
      !isRecord(cases) ||
      Object.keys(cases).length !== caseIDs.length ||
      !caseIDs.every((id) => {
        const entry = cases[id];
        return (
          isRecord(entry) &&
          Object.keys(entry).length === 3 &&
          boundedText(entry.sessionKey, 256) &&
          boundedText(entry.marker, 256) &&
          boundedText(entry.message, 2048)
        );
      })
    ) {
      throw new Error("Invalid native action fixture descriptor.");
    }
    const media = fixture.media;
    const mediaSessionIDs = ["acl", "controlACL", "profile", "controlProfile"];
    if (
      !isRecord(media) ||
      Object.keys(media).length !== 3 ||
      !boundedText(media.pngBase64, 32_768) ||
      typeof media.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(media.sha256)
    ) {
      throw new Error("Invalid native action fixture descriptor.");
    }
    const mediaSessions = media.sessions;
    if (
      !isRecord(mediaSessions) ||
      Object.keys(mediaSessions).length !== mediaSessionIDs.length ||
      !mediaSessionIDs.every((id) => {
        const entry = mediaSessions[id];
        return (
          isRecord(entry) &&
          Object.keys(entry).length === 2 &&
          boundedText(entry.sessionKey, 256) &&
          boundedText(entry.artifactID, 256)
        );
      })
    ) {
      throw new Error("Invalid native action fixture descriptor.");
    }
    const approvals = fixture.approvals;
    if (!isRecord(approvals) || Object.keys(approvals).length !== 2) {
      throw new Error("Invalid native action fixture descriptor.");
    }
    const requests = approvals.requests;
    const approvalIDs = ["allowed", "visible", "queued", "control"];
    if (
      !isRecord(requests) ||
      Object.keys(requests).length !== approvalIDs.length ||
      !approvalIDs.every((id) => {
        const entry = requests[id];
        return (
          isRecord(entry) &&
          Object.keys(entry).length === 3 &&
          boundedText(entry.id, 256) &&
          boundedText(entry.sessionKey, 256) &&
          boundedText(entry.command, 2048)
        );
      })
    ) {
      throw new Error("Invalid native action fixture descriptor.");
    }
    for (const [value, protocol] of [
      [fixture.gatewayURL, "ws:"],
      [fixture.controlURL, "http:"],
      [approvals.gatewayURL, "ws:"],
    ] as const) {
      const url = typeof value === "string" && value.length <= 256 ? URL.parse(value) : null;
      if (
        !url ||
        url.protocol !== protocol ||
        url.hostname !== "127.0.0.1" ||
        !url.port ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      ) {
        throw new Error("Native action fixture endpoints must use explicit loopback ports.");
      }
    }
    nativeActionFixture = JSON.stringify(fixture);
    args.splice(fixtureIndex, 2);
    if (args.includes("--native-action-fixture")) {
      throw new Error("Provide exactly one native action fixture descriptor.");
    }
  }
  if (!args.includes("--skip-build")) {
    throw new Error(
      "Build tests first with swift build --build-tests; this launcher requires --skip-build.",
    );
  }
  if (nativeActionFixture) {
    const expected = [
      "--package-path",
      "apps/macos",
      "--build-system",
      "native",
      "--skip-build",
      "--filter",
      "NativeActionGatewayWireTests",
    ];
    if (args.length !== expected.length || args.some((value, index) => value !== expected[index])) {
      throw new Error("Unsupported native action invocation.");
    }
  }

  // Keep paths short for tools honoring TMPDIR, independently of RUNNER_TEMP's length.
  // Foundation's Darwin temp directory belongs to the disposable OS worker instead.
  const root = fs.realpathSync(fs.mkdtempSync("/tmp/oc-test-"));
  let canRemove = true;
  try {
    const home = path.join(root, "home");
    const state = path.join(root, "state");
    const tmp = path.join(root, "tmp");
    for (const dir of [home, state, tmp]) {
      fs.mkdirSync(dir, { mode: 0o700 });
    }
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
      try {
        if (nativeActionFixture) {
          const selectedPath = async (option: string) => {
            let output = "";
            canRemove = false;
            process.exitCode = await runManagedCommand({
              bin: "xcrun",
              args: ["--sdk", "macosx", option],
              env: childEnv,
              stdio: ["ignore", "pipe", "inherit"],
              requireProcessTreeExit: true,
              onReady: (child) =>
                child.stdout?.on("data", (chunk) => {
                  output = (output + String(chunk)).slice(0, 4097);
                }),
            });
            canRemove = true;
            if (process.exitCode !== 0) {
              return undefined;
            }
            const selected = output.trim();
            if (output.length > 4096 || !path.isAbsolute(selected) || /[\r\n\0]/.test(selected)) {
              throw new Error("Invalid selected macOS toolchain path.");
            }
            return selected;
          };
          const sdk = await selectedPath("--show-sdk-path");
          if (!sdk) {
            return;
          }
          const platform = await selectedPath("--show-sdk-platform-path");
          if (!platform) {
            return;
          }
          const developer = path.join(platform, "Developer");
          const build = fs.realpathSync("apps/macos/.build/debug");
          const bundle = path.join(
            build,
            "OpenClawPackageTests.xctest/Contents/MacOS/OpenClawPackageTests",
          );
          if (
            !fs.existsSync(bundle) ||
            !fs.existsSync(path.join(developer, "Library/Frameworks/Testing.framework/Testing"))
          ) {
            throw new Error("Native test bundle or selected Testing.framework is missing.");
          }
          const host = path.join(root, "NativeActionTestHost");
          process.exitCode = await run("xcrun", [
            "--sdk",
            "macosx",
            "swiftc",
            "-parse-as-library",
            "-sdk",
            sdk,
            path.resolve(
              import.meta.dirname,
              "../apps/macos/Tests/Fixtures/NativeActionTestHost.swift",
            ),
            "-o",
            host,
          ]);
          if (process.exitCode !== 0) {
            return;
          }
          const events = path.join(root, "events.jsonl");
          fs.writeFileSync(events, "", { mode: 0o600, flag: "wx" });
          childEnv.DYLD_FRAMEWORK_PATH = `${developer}/Library/Frameworks:${developer}/Library/PrivateFrameworks`;
          childEnv.DYLD_LIBRARY_PATH = `${build}:${developer}/usr/lib`;
          childEnv.OPENCLAW_NATIVE_ACTION_FIXTURE = nativeActionFixture;
          process.exitCode = await run(host, [
            "--test-bundle-path",
            bundle,
            "--filter",
            "NativeActionGatewayWireTests",
            "--event-stream-version",
            "0",
            "--event-stream-output-path",
            events,
          ]);
          // A successful ABI return also covers zero tests. Only a complete,
          // joined file receipt certifies that our native function actually ran.
          if (!(await hasCompletedNativeReceipt(events))) {
            console.error("[macos-native] invalid native event receipt");
            process.exitCode ||= 1;
          } else if (process.exitCode === 0) {
            console.log("[macos-native] native receipt: 1 function completed");
          }
        } else {
          process.exitCode = await run("swift", ["test", ...args]);
        }
      } finally {
        delete childEnv.OPENCLAW_NATIVE_ACTION_FIXTURE;
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
