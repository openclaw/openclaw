#!/usr/bin/env node
// Verify the packaged entry point after relocation and signing, in isolated state.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { stripVTControlCharacters } from "node:util";
import { auditMacRuntimePortability } from "./lib/mac-runtime-portability.mjs";
import { verifyMacStandaloneRuntime } from "./lib/mac-standalone-runtime.mjs";
import { runManagedCommand, terminateManagedChild } from "./lib/managed-child-process.mts";

const [
  runtimeArg,
  expectedInfoPath,
  appArg,
  arch = process.arch === "x64" ? "x86_64" : process.arch,
] = process.argv.slice(2);
if (!runtimeArg || !expectedInfoPath) {
  throw new Error(
    "Usage: verify-mac-runtime.mjs <runtime> <expected-build-info.json> [app] [architecture]",
  );
}
const sourceRuntime = fs.realpathSync(runtimeArg);
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oc-v-")));
try {
  assert(
    Buffer.byteLength(path.join(home, "oc-br-XXXXXX", "resource.sock")) <= 103,
    "Runtime verifier TMPDIR is too long for a 103-byte broker socket; use a shorter temporary directory",
  );
  const runtime = path.join(home, "runtime");
  // Exercise the same relocation used by profile seeding, outside the denied account home.
  execFileSync("/bin/cp", ["-cR", sourceRuntime, runtime]);
  const executable = path.join(runtime, "openclaw");
  const packageRoot = path.join(runtime, "runtime");
  const expected = JSON.parse(fs.readFileSync(expectedInfoPath, "utf8"));
  const selected = JSON.parse(fs.readFileSync(path.join(runtime, "manifest.json"), "utf8"));
  const manifest = await verifyMacStandaloneRuntime(runtime, expected, selected.mode, arch);
  assert.match(manifest.buildId, /^[a-f\d]{64}$/u, "Missing packaged runtime build identity");
  for (const legacy of ["bin", "lib/node_modules", "lib/libsqlite3.dylib"]) {
    assert(!fs.existsSync(path.join(runtime, legacy)), `Legacy runtime layout remains: ${legacy}`);
  }
  assert(
    fs.existsSync(path.join(packageRoot, "dist/control-ui/index.html")),
    "Bundled Control UI is missing",
  );
  const sqliteLibrary = path.join(packageRoot, "lib/libsqlite3.dylib");
  assert(fs.existsSync(sqliteLibrary), "Bundled SQLite library is missing");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(packageRoot, "openclaw-install-owner.json"), "utf8"))
      .owner,
    "macos-app",
  );
  const nativeFiles = auditMacRuntimePortability(runtime, executable);
  assert.equal(
    execFileSync(
      "/usr/bin/find",
      [appArg ? fs.realpathSync(appArg) : runtime, "-type", "f", "-name", "node", "-print"],
      { encoding: "utf8" },
    ),
    "",
    "App bundle contains a Node executable",
  );
  const sandbox = path.join(home, "runtime-proof.sb");
  fs.writeFileSync(
    sandbox,
    `(version 1)
(allow default)
(deny network*)
(allow network-bind (local unix-socket (subpath (param "ISOLATED_ROOT"))))
(allow network-outbound (remote unix-socket (subpath (param "ISOLATED_ROOT"))))
(deny file-write*)
(deny file-read* (subpath (param "ORIGINAL_HOME")))
(allow file-read* file-write* (subpath (param "ISOLATED_ROOT")))
(allow file-write* (literal "/dev/null"))
(deny process-exec (literal "/bin/launchctl"))
(deny mach-lookup
  (global-name "com.apple.cfprefsd.daemon")
  (global-name "com.apple.cfprefsd.agent")
  (local-name "com.apple.cfprefsd.agent")
  (global-name "com.apple.SecurityServer")
  (global-name "com.apple.securityd")
  (global-name "com.apple.securityd.xpc"))
(deny ipc-posix-shm-read* (ipc-posix-name-prefix "apple.cfprefs."))
(deny file-read* file-write* (subpath "/Library/Keychains"))
(deny file-read*
  (subpath "/opt/homebrew/opt/sqlite")
  (subpath "/usr/local/opt/sqlite")
  (literal "/opt/local/lib/libsqlite3.dylib"))
`,
  );
  const sandboxArgs = [
    "-D",
    `ORIGINAL_HOME=${os.userInfo().homedir}`,
    "-D",
    `ISOLATED_ROOT=${home}`,
    "-f",
    sandbox,
    "/usr/bin/arch",
    `-${arch}`,
    executable,
  ];
  const environment = {
    HOME: home,
    CFFIXED_USER_HOME: home,
    TMPDIR: home,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    OPENCLAW_STATE_DIR: path.join(home, "state"),
    OPENCLAW_CONFIG_PATH: path.join(home, "openclaw.json"),
  };
  const launch = (args) =>
    execFileSync("/usr/bin/sandbox-exec", [...sandboxArgs, ...args], {
      cwd: home,
      env: environment,
      encoding: "utf8",
      timeout: 60_000,
    });
  const workspace = path.join(home, "workspace");
  fs.mkdirSync(workspace);
  fs.writeFileSync(
    environment.OPENCLAW_CONFIG_PATH,
    JSON.stringify({
      agents: { defaults: { workspace }, entries: { main: {} } },
      memory: {
        search: {
          enabled: true,
          provider: "openai",
          // Deep status initializes embeddings even for this empty index. Synthetic auth
          // avoids user credentials; the sandbox still denies the loopback endpoint.
          remote: {
            baseUrl: "http://127.0.0.1:9/v1",
            apiKey: "packaging-verifier-synthetic-not-a-secret",
          },
          sources: ["memory"],
          store: { vector: { enabled: true } },
        },
      },
    }),
  );
  const version = launch(["--version"]).trim();
  assert.equal(
    /^OpenClaw (\S+)(?: \([^)]+\))?$/u.exec(version)?.[1],
    expected.version,
    `Bundled CLI version mismatch: ${version}`,
  );
  launch(["gateway", "--help"]);
  // Normalize panel wrapping before checking Doctor's own extension-capable SQLite.
  const doctor = stripVTControlCharacters(launch(["doctor", "--non-interactive"])).replaceAll(
    /[│┃\s]/gu,
    "",
  );
  const doctorSelection = /SQLite\(doctorprocess\):(.+?)\(([^)]+),extensionloadingenabled\)/u.exec(
    doctor,
  );
  assert.equal(
    doctorSelection?.[1],
    sqliteLibrary.replaceAll(/\s/gu, ""),
    "Doctor SQLite did not select the bundled library",
  );
  // --index selects the writable CLI owner so an empty profile gets an index.
  // Keep the native-vector probe; unavailable remote embeddings do not block an empty index.
  const memory = JSON.parse(launch(["memory", "status", "--index", "--json"]));
  const mainMemory = memory.find((entry) => entry.agentId === "main")?.status;
  assert.equal(
    mainMemory?.backend,
    "builtin",
    "Bundled vector probe requires the builtin memory store",
  );
  assert.equal(mainMemory?.vector?.storeAvailable, true, "Bundled vector store is unavailable");
  const extension = mainMemory.vector.extensionPath;
  assert.equal(typeof extension, "string", "Bundled vector extension path is missing");
  assert(
    fs.realpathSync(extension).startsWith(packageRoot + path.sep),
    "Bundled vector extension escaped the sidecar",
  );
  // The builder owns embedded worker dispatch. Exercise its public child entry
  // through the same executable and argv shape used by the app.
  let ready = false;
  let failure;
  let diagnostic = "";
  const exitCode = await runManagedCommand({
    bin: "/usr/bin/sandbox-exec",
    args: [...sandboxArgs, path.join(packageRoot, "dist/mac-node-worker.js"), "node", "worker"],
    cwd: home,
    env: { ...environment, OPENCLAW_NODE_EXEC_HOST: "app", OPENCLAW_NODE_EXEC_FALLBACK: "0" },
    stdio: ["pipe", "pipe", "pipe"],
    timeoutMs: 300_000,
    requireProcessTreeExit: true,
    onReady(child) {
      const lines = createInterface({ input: child.stdout });
      child.stderr.on("data", (data) => {
        diagnostic = (diagnostic + data.toString()).slice(-4000);
      });
      lines.on("line", (line) => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (message.type !== "ready") {
          return;
        }
        if (
          message.version !== expected.version ||
          !["system.run", "system.which", "browser.proxy", "mcp.tools.call.v1"].every((command) =>
            message.manifest?.commands?.includes(command),
          )
        ) {
          failure = new Error(
            `Bundled worker capability mismatch: ${JSON.stringify(message.manifest)}`,
          );
        } else {
          ready = true;
        }
        child.stdin.end('{"type":"stop"}\n');
      });
      child.on("close", () => lines.close());
      child.stdin.on("error", (error) => {
        failure = error;
        terminateManagedChild(child, "SIGKILL");
      });
    },
  });
  if (failure || !ready || exitCode !== 0 || /failed during register/u.test(diagnostic)) {
    throw new Error(
      `Bundled worker proof failed (${exitCode}): ${failure?.message ?? "missing readiness or registration failure"}; ${diagnostic}`,
      { cause: failure },
    );
  }
  console.log(
    JSON.stringify({
      architecture: arch,
      buildId: manifest.buildId,
      mode: manifest.mode,
      nativeFiles,
      sqliteLibrary,
      vectorExtension: extension,
      version,
    }),
  );
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
