#!/usr/bin/env node

// Packs and proves the CI dist-runtime-build artifact layout.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createWorkspaceBootstrapSmokeEnv,
  WORKSPACE_TEMPLATE_PACK_PATHS,
  runInstalledWorkspaceBootstrapSmoke,
} from "./lib/workspace-bootstrap-smoke.mjs";

export const DIST_RUNTIME_BUILD_ARCHIVE = "dist-runtime-build.tar.zst";
export const DIST_RUNTIME_BUILD_ROOTS = Object.freeze([
  "openclaw.mjs",
  "package.json",
  "docs/reference/templates",
  "src/agents/templates",
  "dist",
  "dist-runtime",
]);

const REQUIRED_DIST_RUNTIME_ARTIFACT_FILES = Object.freeze([
  "openclaw.mjs",
  "package.json",
  "dist/entry.js",
  "dist/task-registry-control.runtime.js",
  ...WORKSPACE_TEMPLATE_PACK_PATHS,
]);
const REQUIRED_DIST_RUNTIME_ARTIFACT_PREFIXES = Object.freeze(["dist-runtime/extensions"]);
const DEFAULT_COMPRESS_PROGRAM = "zstdmt";
const DEFAULT_DECOMPRESS_PROGRAM = `${DEFAULT_COMPRESS_PROGRAM} -d`;
const GATEWAY_SMOKE_TIMEOUT_MS = 60_000;
const GATEWAY_HEALTH_PROBE_INTERVAL_MS = 250;
const MAX_CAPTURED_GATEWAY_OUTPUT_BYTES = 1024 * 1024;
const GATEWAY_RUNTIME_CANARY_PLUGIN_ID = "browser";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return [
    "Usage: node scripts/dist-runtime-build-artifact.mjs <command> [--archive <path>]",
    "",
    "Commands:",
    "  print-roots      Print the runtime artifact root contract as JSON",
    "  pack             Build the archive from the contract roots",
    "  verify           Verify archive manifest and hash",
    "  smoke            Verify, extract, and run packaged runtime smoke checks",
    "  pack-and-smoke   Pack, verify, extract, and run packaged runtime smoke checks",
  ].join("\n");
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { archive: DIST_RUNTIME_BUILD_ARCHIVE };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--archive") {
      const value = rest[index + 1];
      if (!value) {
        throw new Error("--archive requires a value");
      }
      options.archive = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { command, options };
}

function resolveArchivePath(archive) {
  return path.isAbsolute(archive) ? archive : path.resolve(repoRoot, archive);
}

function hashFile(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function runTar(args, options = {}) {
  return execFileSync("tar", args, {
    cwd: repoRoot,
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: options.capture ? "utf8" : undefined,
  });
}

function normalizeArchiveEntry(entry) {
  return entry.replace(/^\.\//u, "").replace(/\/+$/u, "");
}

function listArchiveEntries(archivePath) {
  const output = runTar(
    ["--use-compress-program", DEFAULT_DECOMPRESS_PROGRAM, "-tf", archivePath],
    {
      capture: true,
    },
  );
  return output
    .split(/\r?\n/u)
    .map((entry) => normalizeArchiveEntry(entry.trim()))
    .filter(Boolean);
}

function entryMatchesPrefix(entry, prefix) {
  return entry === prefix || entry.startsWith(`${prefix}/`);
}

function collectMissingArchiveEntries(entries) {
  const available = new Set(entries);
  return [
    ...REQUIRED_DIST_RUNTIME_ARTIFACT_FILES.filter((entry) => !available.has(entry)),
    ...REQUIRED_DIST_RUNTIME_ARTIFACT_PREFIXES.filter(
      (prefix) => !entries.some((entry) => entryMatchesPrefix(entry, prefix)),
    ),
  ];
}

function isAllowedTemplateSourceEntry(entry) {
  return (
    entry === "src" ||
    entry === "src/agents" ||
    entry === "src/agents/templates" ||
    entry.startsWith("src/agents/templates/")
  );
}

function isAllowedReferenceTemplateEntry(entry) {
  return (
    entry === "docs" ||
    entry === "docs/reference" ||
    entry === "docs/reference/templates" ||
    entry.startsWith("docs/reference/templates/")
  );
}

function collectForbiddenArchiveEntries(entries) {
  return entries.filter((entry) => {
    if (entry === "src" || entry.startsWith("src/")) {
      return !isAllowedTemplateSourceEntry(entry);
    }
    if (entry === "docs" || entry.startsWith("docs/")) {
      return !isAllowedReferenceTemplateEntry(entry);
    }
    return ["extensions", "packages", "apps", "ui", "test", "qa", "node_modules"].some((prefix) =>
      entryMatchesPrefix(entry, prefix),
    );
  });
}

function assertArchiveManifest(entries) {
  const missing = collectMissingArchiveEntries(entries);
  if (missing.length > 0) {
    throw new Error(`dist runtime artifact is missing required entries: ${missing.join(", ")}`);
  }
  const forbidden = collectForbiddenArchiveEntries(entries);
  if (forbidden.length > 0) {
    throw new Error(
      `dist runtime artifact includes source/package roots outside the runtime contract: ${forbidden.join(", ")}`,
    );
  }
}

function assertArtifactRootsExist() {
  const missingRoots = DIST_RUNTIME_BUILD_ROOTS.filter(
    (root) => !existsSync(path.join(repoRoot, root)),
  );
  if (missingRoots.length > 0) {
    throw new Error(
      `cannot pack dist runtime artifact before required roots exist: ${missingRoots.join(", ")}`,
    );
  }
}

export function packRuntimeArtifact({ archivePath }) {
  assertArtifactRootsExist();
  rmSync(archivePath, { force: true });
  runTar([
    "--posix",
    "--use-compress-program",
    DEFAULT_COMPRESS_PROGRAM,
    "-cf",
    archivePath,
    ...DIST_RUNTIME_BUILD_ROOTS,
  ]);
  const entries = listArchiveEntries(archivePath);
  assertArchiveManifest(entries);
  const sha256 = hashFile(archivePath);
  console.log(
    `packed ${path.relative(repoRoot, archivePath)} sha256=${sha256} entries=${entries.length}`,
  );
  return { entries, sha256 };
}

function extractArchive({ archivePath, packageRoot }) {
  mkdirSync(packageRoot, { recursive: true });
  runTar([
    "--use-compress-program",
    DEFAULT_DECOMPRESS_PROGRAM,
    "-xf",
    archivePath,
    "-C",
    packageRoot,
  ]);
}

function assertFile(packageRoot, relativePath) {
  const filePath = path.join(packageRoot, ...relativePath.split("/"));
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    throw new Error(`extracted dist runtime artifact is missing file: ${relativePath}`);
  }
}

function assertDirectory(packageRoot, relativePath) {
  const dirPath = path.join(packageRoot, ...relativePath.split("/"));
  if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
    throw new Error(`extracted dist runtime artifact is missing directory: ${relativePath}`);
  }
  if (readdirSync(dirPath).length === 0) {
    throw new Error(`extracted dist runtime artifact directory is empty: ${relativePath}`);
  }
}

function assertNoForbiddenExtractedRoot(packageRoot, relativePath) {
  const entryPath = path.join(packageRoot, ...relativePath.split("/"));
  if (existsSync(entryPath)) {
    throw new Error(`extracted dist runtime artifact unexpectedly contains ${relativePath}`);
  }
}

function assertExtractedPackageRoot(packageRoot) {
  for (const file of REQUIRED_DIST_RUNTIME_ARTIFACT_FILES) {
    assertFile(packageRoot, file);
  }
  for (const prefix of REQUIRED_DIST_RUNTIME_ARTIFACT_PREFIXES) {
    assertDirectory(packageRoot, prefix);
  }

  const packageJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  if (packageJson.name !== "openclaw") {
    throw new Error(
      `extracted package.json name must be "openclaw"; got ${String(packageJson.name)}`,
    );
  }

  for (const root of ["extensions", "packages", "apps", "ui", "test", "qa", "node_modules"]) {
    assertNoForbiddenExtractedRoot(packageRoot, root);
  }

  const repairedRuntimeSymlink = path.join(packageRoot, "dist", "dist", "plugins", "runtime");
  if (existsSync(repairedRuntimeSymlink)) {
    throw new Error(
      `extracted dist runtime artifact must not rely on local repair symlink: ${path.relative(packageRoot, repairedRuntimeSymlink)}`,
    );
  }
}

function linkInstalledDependenciesForSmoke(packageRoot) {
  const installedNodeModules = path.join(repoRoot, "node_modules");
  if (!existsSync(installedNodeModules) || !statSync(installedNodeModules).isDirectory()) {
    throw new Error("dist runtime artifact smoke requires hydrated checkout dependencies");
  }
  // The CI artifact is a built-output handoff, not an npm package tarball. The
  // smoke borrows the already-installed checkout dependencies while proving the
  // extracted package root contributes every runtime-owned file and layout.
  symlinkSync(
    installedNodeModules,
    path.join(packageRoot, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
}

function createGatewaySmokeConfig({ configPath, port }) {
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5" },
          },
        },
        gateway: {
          mode: "local",
          port,
          bind: "loopback",
          auth: { mode: "none" },
          controlUi: { enabled: false },
        },
        models: {
          providers: {
            openai: {
              apiKey: "sk-openclaw-runtime-artifact-smoke",
              baseUrl: "https://api.openai.com/v1",
              models: [],
            },
          },
        },
        plugins: {
          enabled: true,
          entries: {
            [GATEWAY_RUNTIME_CANARY_PLUGIN_ID]: {
              enabled: true,
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("unable to reserve a loopback port for gateway smoke");
  }
  const port = address.port;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      resolve();
    });
  });
  return port;
}

function parseReadinessPayload(body) {
  try {
    const payload = JSON.parse(body);
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

function probeGatewayReadyz(port) {
  return new Promise((resolve) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/readyz",
        method: "GET",
        timeout: 1000,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          const payload = parseReadinessPayload(body);
          resolve({
            statusCode: res.statusCode,
            payload,
            ready:
              res.statusCode === 200 &&
              payload?.ready === true &&
              Array.isArray(payload.failing) &&
              payload.failing.length === 0,
          });
        });
      },
    );
    req.once("timeout", () => {
      req.destroy();
      resolve({ ready: false, statusCode: null, payload: null });
    });
    req.once("error", () => resolve({ ready: false, statusCode: null, payload: null }));
    req.end();
  });
}

function appendCapturedOutput(existing, chunk) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  const combined = `${existing}${text}`;
  if (combined.length <= MAX_CAPTURED_GATEWAY_OUTPUT_BYTES) {
    return combined;
  }
  return combined.slice(combined.length - MAX_CAPTURED_GATEWAY_OUTPUT_BYTES);
}

async function waitForGatewayReady({ child, getOutput, port }) {
  const started = Date.now();
  let exitResult = null;
  let lastReadiness = null;
  child.once("exit", (code, signal) => {
    exitResult = { code, signal };
  });

  while (Date.now() - started < GATEWAY_SMOKE_TIMEOUT_MS) {
    lastReadiness = await probeGatewayReadyz(port);
    if (lastReadiness.ready) {
      return;
    }
    if (exitResult) {
      throw new Error(
        `packaged gateway exited before /readyz became ready: code=${String(exitResult.code)} signal=${String(exitResult.signal)} readiness=${JSON.stringify(lastReadiness)}\n${getOutput()}`,
      );
    }
    await wait(GATEWAY_HEALTH_PROBE_INTERVAL_MS);
  }

  throw new Error(
    `timed out waiting for packaged gateway /readyz on port ${port}; last readiness=${JSON.stringify(lastReadiness)}\n${getOutput()}`,
  );
}

function assertGatewayCanaryPluginLoaded(output) {
  const readyBanner = output.match(/http server listening \((?<details>[^)]*)\)/u);
  const readyDetails = readyBanner?.groups?.details ?? "";
  const canaryPattern = new RegExp(`\\b${GATEWAY_RUNTIME_CANARY_PLUGIN_ID}\\b`, "u");
  if (canaryPattern.test(readyDetails)) {
    return;
  }
  const postBindTrace = output.match(
    /startup trace: plugins\.runtime-post-bind (?<metrics>[^\n]*)/u,
  );
  throw new Error(
    [
      `packaged gateway became ready before the ${GATEWAY_RUNTIME_CANARY_PLUGIN_ID} runtime canary was observed as loaded`,
      `ready banner: ${readyDetails || "(missing)"}`,
      `post-bind trace: ${postBindTrace?.groups?.metrics ?? "(missing)"}`,
      output,
    ].join("\n"),
  );
}

async function stopGateway(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => {
      child.once("exit", () => resolve(true));
    }),
    wait(5000).then(() => false),
  ]);
  if (!exited) {
    child.kill("SIGKILL");
  }
}

async function runExtractedGatewaySmoke({ packageRoot, tempRoot }) {
  const port = await reserveLoopbackPort();
  const homeDir = path.join(tempRoot, "gateway-home");
  const stateDir = path.join(homeDir, ".openclaw");
  const configPath = path.join(stateDir, "openclaw.json");
  const cwd = path.join(tempRoot, "gateway-cwd");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  createGatewaySmokeConfig({ configPath, port });

  const env = createWorkspaceBootstrapSmokeEnv(process.env, homeDir, {
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
    OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
  });

  let output = "";
  const child = spawn(
    process.execPath,
    [
      path.join(packageRoot, "openclaw.mjs"),
      "gateway",
      "run",
      "--port",
      String(port),
      "--bind",
      "loopback",
      "--auth",
      "none",
      "--allow-unconfigured",
      "--ws-log",
      "compact",
    ],
    {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => {
    output = appendCapturedOutput(output, chunk);
  });
  child.stderr.on("data", (chunk) => {
    output = appendCapturedOutput(output, chunk);
  });

  try {
    await waitForGatewayReady({
      child,
      getOutput: () => output,
      port,
    });
    assertGatewayCanaryPluginLoaded(output);
    console.log(
      `packaged gateway /readyz passed with ${GATEWAY_RUNTIME_CANARY_PLUGIN_ID} plugin loaded on port ${port}`,
    );
  } finally {
    await stopGateway(child);
  }
}

async function runExtractedAcpRuntimeSmoke(packageRoot) {
  const runtimePath = path.join(packageRoot, "dist", "task-registry-control.runtime.js");
  const runtime = await import(pathToFileURL(runtimePath).href);
  if (typeof runtime.getAcpSessionManager !== "function") {
    throw new Error("packaged ACP runtime is missing getAcpSessionManager export");
  }
  if (typeof runtime.killSubagentRunAdmin !== "function") {
    throw new Error("packaged ACP runtime is missing killSubagentRunAdmin export");
  }
  console.log("packaged ACP runtime import passed");
}

export async function verifyRuntimeArtifact({ archivePath, smoke = false }) {
  const entries = listArchiveEntries(archivePath);
  assertArchiveManifest(entries);
  const sha256 = hashFile(archivePath);
  console.log(
    `verified ${path.relative(repoRoot, archivePath)} sha256=${sha256} entries=${entries.length}`,
  );

  if (!smoke) {
    return { entries, sha256 };
  }

  const tempRoot = mkdtempSync(path.join(tmpdir(), "openclaw-dist-runtime-artifact-"));
  const packageRoot = path.join(tempRoot, "package");
  try {
    extractArchive({ archivePath, packageRoot });
    assertExtractedPackageRoot(packageRoot);
    linkInstalledDependenciesForSmoke(packageRoot);
    runInstalledWorkspaceBootstrapSmoke({ packageRoot });
    await runExtractedAcpRuntimeSmoke(packageRoot);
    await runExtractedGatewaySmoke({ packageRoot, tempRoot });
    console.log("extracted dist runtime artifact smoke passed");
  } finally {
    if (process.env.OPENCLAW_KEEP_RUNTIME_ARTIFACT_SMOKE !== "1") {
      rmSync(tempRoot, { recursive: true, force: true });
    } else {
      console.log(`kept smoke extraction at ${tempRoot}`);
    }
  }
  return { entries, sha256 };
}

async function main(argv) {
  const { command, options } = parseArgs(argv);
  const archivePath = resolveArchivePath(options.archive);

  switch (command) {
    case "print-roots":
      console.log(JSON.stringify(DIST_RUNTIME_BUILD_ROOTS, null, 2));
      return;
    case "pack":
      packRuntimeArtifact({ archivePath });
      return;
    case "verify":
      await verifyRuntimeArtifact({ archivePath, smoke: false });
      return;
    case "smoke":
      await verifyRuntimeArtifact({ archivePath, smoke: true });
      return;
    case "pack-and-smoke":
      packRuntimeArtifact({ archivePath });
      await verifyRuntimeArtifact({ archivePath, smoke: true });
      return;
    default:
      throw new Error(command ? `Unknown command: ${command}\n${usage()}` : usage());
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
