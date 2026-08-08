// Verifies installed packages can bootstrap the default OpenClaw workspace files.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { TSDOWN_PACKAGE_OUTPUT_ROOTS } from "./tsdown-output-roots.mjs";

/**
 * Template pack files that must be present in installed packages.
 */
export const WORKSPACE_TEMPLATE_PACK_PATHS = [
  "docs/reference/templates/AGENTS.md",
  "docs/reference/templates/SOUL.md",
  "docs/reference/templates/IDENTITY.md",
  "docs/reference/templates/USER.md",
  "src/agents/templates/HEARTBEAT.md",
  "docs/reference/templates/BOOTSTRAP.md",
];

const DIST_RUNTIME_ARTIFACT_BASE_PATHS = [
  "openclaw.mjs",
  "package.json",
  "docs/reference/templates",
  "src/agents/templates",
  "dist",
  "dist-runtime",
  "node_modules",
];

const DIST_RUNTIME_ARTIFACT_PACKAGE_DIST_PATHS = [
  ...TSDOWN_PACKAGE_OUTPUT_ROOTS,
  "packages/plugin-sdk/dist",
].toSorted((left, right) => left.localeCompare(right));

const DIST_RUNTIME_ARTIFACT_PACKAGE_SOURCE_PATHS = DIST_RUNTIME_ARTIFACT_PACKAGE_DIST_PATHS.flatMap(
  (distPath) => {
    const packageRoot = dirname(distPath);
    return [`${packageRoot}/package.json`, distPath];
  },
);

function packageArtifactPath(sourcePath) {
  return sourcePath.replace(/^packages\//u, "node_modules/@openclaw/");
}

function copyDistRuntimeArtifactPath(
  rootDir,
  artifactRoot,
  sourcePath,
  destinationPath = sourcePath,
) {
  const destination = join(artifactRoot, destinationPath);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(join(rootDir, sourcePath), destination, { dereference: true, recursive: true });
}

function stageDistRuntimeArtifact(rootDir, artifactRoot) {
  const deploymentRoot = join(artifactRoot, "deployment");
  execFileSync(
    "pnpm",
    [
      "--frozen-lockfile",
      "--config.inject-workspace-packages=true",
      "--ignore-scripts",
      "--filter",
      "openclaw",
      "deploy",
      "--prod",
      deploymentRoot,
    ],
    { cwd: rootDir, stdio: "inherit" },
  );
  copyDistRuntimeArtifactPath(deploymentRoot, artifactRoot, "node_modules");
  rmSync(deploymentRoot, { force: true, recursive: true });

  for (const sourcePath of DIST_RUNTIME_ARTIFACT_BASE_PATHS) {
    if (sourcePath !== "node_modules") {
      copyDistRuntimeArtifactPath(rootDir, artifactRoot, sourcePath);
    }
  }
  for (const sourcePath of DIST_RUNTIME_ARTIFACT_PACKAGE_SOURCE_PATHS) {
    copyDistRuntimeArtifactPath(rootDir, artifactRoot, sourcePath, packageArtifactPath(sourcePath));
  }
}

// HEARTBEAT.md ships in the template pack for docs/doctor context but is no
// longer seeded into new workspaces; heartbeat context lives in cron scratch.
const REQUIRED_BOOTSTRAP_WORKSPACE_FILES = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "BOOTSTRAP.md",
];

const WORKSPACE_BOOTSTRAP_SMOKE_TIMEOUT_MS = 15_000;
const DIST_RUNTIME_ARTIFACT_SMOKE_TIMEOUT_MS = 20_000;
const DIST_RUNTIME_ARTIFACT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const SAFE_UNIX_SMOKE_PATH = "/usr/bin:/bin";
const BUNDLED_PLUGIN_SMOKE_ID = "acpx";

/**
 * Creates a minimal isolated environment for workspace bootstrap smoke runs.
 */
export function createWorkspaceBootstrapSmokeEnv(env, homeDir, overrides = {}) {
  const allowlistedEnvEntries = [
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
    "WINDIR",
  ];
  const windowsRoot = env.SystemRoot ?? env.WINDIR ?? "C:\\Windows";
  const nodeBinDir = dirname(process.execPath);
  const safePath =
    process.platform === "win32"
      ? `${nodeBinDir};${windowsRoot}\\System32;${windowsRoot}`
      : `${nodeBinDir}:${SAFE_UNIX_SMOKE_PATH}`;

  return {
    ...Object.fromEntries(
      allowlistedEnvEntries.flatMap((key) => {
        const value = env[key];
        return typeof value === "string" && value.length > 0 ? [[key, value]] : [];
      }),
    ),
    PATH: safePath,
    HOME: homeDir,
    USERPROFILE: homeDir,
    OPENCLAW_HOME: homeDir,
    OPENCLAW_NO_ONBOARD: "1",
    OPENCLAW_SUPPRESS_NOTES: "1",
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK: "1",
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_SHARED_CREDENTIALS_FILE: join(homeDir, ".aws", "credentials"),
    AWS_CONFIG_FILE: join(homeDir, ".aws", "config"),
    ...overrides,
  };
}

function collectMissingBootstrapWorkspaceFiles(workspaceDir) {
  return REQUIRED_BOOTSTRAP_WORKSPACE_FILES.filter(
    (filename) => !existsSync(join(workspaceDir, filename)),
  );
}

function describeExecFailure(error) {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const stdout =
    typeof error.stdout === "string"
      ? error.stdout.trim()
      : error.stdout instanceof Uint8Array
        ? Buffer.from(error.stdout).toString("utf8").trim()
        : "";
  const stderr =
    typeof error.stderr === "string"
      ? error.stderr.trim()
      : error.stderr instanceof Uint8Array
        ? Buffer.from(error.stderr).toString("utf8").trim()
        : "";
  return [error.message, stdout, stderr].filter(Boolean).join(" | ");
}

/**
 * Runs the installed CLI workspace bootstrap smoke and validates created files.
 */
export function runInstalledWorkspaceBootstrapSmoke(params) {
  const tempRoot = mkdtempSync(join(tmpdir(), "openclaw-workspace-bootstrap-smoke-"));
  const homeDir = join(tempRoot, "home");
  const cwd = join(tempRoot, "cwd");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  let combinedOutput = "";
  try {
    try {
      execFileSync(
        process.execPath,
        [
          ...(params.nodeArgs ?? []),
          join(params.packageRoot, "openclaw.mjs"),
          "agent",
          "--message",
          "workspace bootstrap smoke",
          "--session-id",
          "workspace-bootstrap-smoke",
          "--local",
          "--timeout",
          "1",
          "--json",
        ],
        {
          cwd,
          encoding: "utf8",
          maxBuffer: 1024 * 1024 * 16,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: WORKSPACE_BOOTSTRAP_SMOKE_TIMEOUT_MS,
          env: createWorkspaceBootstrapSmokeEnv(process.env, homeDir, params.envOverrides),
        },
      );
    } catch (error) {
      combinedOutput = describeExecFailure(error);
    }

    if (combinedOutput.includes("Missing workspace template:")) {
      throw new Error(
        `installed workspace bootstrap failed before agent execution: ${combinedOutput}`,
      );
    }

    const workspaceDir = join(homeDir, ".openclaw", "workspace");
    const missingFiles = collectMissingBootstrapWorkspaceFiles(workspaceDir);
    if (missingFiles.length > 0) {
      const outputDetails = combinedOutput.length > 0 ? `\nCommand output:\n${combinedOutput}` : "";
      throw new Error(
        `installed workspace bootstrap did not create required files in ${workspaceDir}: ${missingFiles.join(", ")}${outputDetails}`,
      );
    }
  } finally {
    try {
      rmSync(tempRoot, { force: true, recursive: true });
    } catch {
      // best effort cleanup only
    }
  }
}

function collectDistRuntimeArtifactPaths(rootDir) {
  const missingPaths = DIST_RUNTIME_ARTIFACT_PACKAGE_SOURCE_PATHS.filter(
    (artifactPath) => !existsSync(join(rootDir, artifactPath)),
  );
  if (missingPaths.length > 0) {
    throw new Error(
      `dist runtime artifact inputs are missing required workspace package paths: ${missingPaths.join(", ")}`,
    );
  }
  return [
    ...DIST_RUNTIME_ARTIFACT_BASE_PATHS,
    ...DIST_RUNTIME_ARTIFACT_PACKAGE_SOURCE_PATHS.map(packageArtifactPath),
  ].toSorted((left, right) => left.localeCompare(right));
}

function listDistRuntimeArtifactEntries(archivePath, compressor) {
  return execFileSync("tar", ["--use-compress-program", compressor, "-tf", archivePath], {
    encoding: "utf8",
    maxBuffer: DIST_RUNTIME_ARTIFACT_MAX_OUTPUT_BYTES,
  })
    .split(/\r?\n/u)
    .map((entry) => entry.replace(/^\.\//u, "").replace(/\/$/u, ""))
    .filter(Boolean);
}

function validateDistRuntimeArtifactEntries(entries, expectedPaths) {
  const entrySet = new Set(entries);
  const missingPaths = expectedPaths.filter(
    (expectedPath) =>
      !entrySet.has(expectedPath) && !entries.some((entry) => entry.startsWith(`${expectedPath}/`)),
  );
  if (missingPaths.length > 0) {
    throw new Error(`dist runtime artifact is missing required paths: ${missingPaths.join(", ")}`);
  }

  const hasPluginRuntime = entries.some(
    (entry) =>
      entry.startsWith("dist-runtime/extensions/") && entry.endsWith("/openclaw.plugin.json"),
  );
  if (!hasPluginRuntime) {
    throw new Error("dist runtime artifact is missing the built plugin runtime layout");
  }

  const unexpectedEntries = entries.filter((entry) => {
    if (entry === "openclaw.mjs" || entry === "package.json") {
      return false;
    }
    if (
      entry === "dist" ||
      entry.startsWith("dist/") ||
      entry === "dist-runtime" ||
      entry.startsWith("dist-runtime/") ||
      entry === "src" ||
      entry === "src/agents" ||
      entry === "src/agents/templates" ||
      entry.startsWith("src/agents/templates/") ||
      entry === "docs" ||
      entry === "docs/reference" ||
      entry === "docs/reference/templates" ||
      entry.startsWith("docs/reference/templates/") ||
      entry === "node_modules" ||
      entry.startsWith("node_modules/")
    ) {
      return false;
    }
    return true;
  });
  if (unexpectedEntries.length > 0) {
    throw new Error(
      `dist runtime artifact contains paths outside the runtime allowlist: ${unexpectedEntries.slice(0, 10).join(", ")}`,
    );
  }
}

function reserveLoopbackPort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to reserve a loopback port for the gateway smoke"));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(new Error("failed to release the reserved gateway smoke port", { cause: error }));
          return;
        }
        resolvePromise(address.port);
      });
    });
  });
}

async function waitForGatewayReadiness(params) {
  const deadline = Date.now() + DIST_RUNTIME_ARTIFACT_SMOKE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (params.child.exitCode !== null) {
      throw new Error(`extracted gateway exited before readiness:\n${params.readOutput()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${params.port}/readyz`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const body = await response.json();
        if (body?.ready === true) {
          return;
        }
      }
    } catch {
      // Gateway startup is asynchronous; retry until the bounded deadline.
    }
    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 250);
    });
  }
  throw new Error(`extracted gateway did not become ready:\n${params.readOutput()}`);
}

async function waitForGatewayPluginLoaded(params) {
  const expectedOutput = `plugin: ${BUNDLED_PLUGIN_SMOKE_ID}`;
  const deadline = Date.now() + DIST_RUNTIME_ARTIFACT_SMOKE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (params.child.exitCode !== null) {
      throw new Error(
        `extracted gateway exited before loading ${BUNDLED_PLUGIN_SMOKE_ID}:\n${params.readOutput()}`,
      );
    }
    if (params.readOutput().includes(expectedOutput)) {
      return;
    }
    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 100);
    });
  }
  throw new Error(
    `extracted gateway did not load ${BUNDLED_PLUGIN_SMOKE_ID}:\n${params.readOutput()}`,
  );
}

async function waitForGatewayProcessGroupExit(processGroupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(processGroupId, 0);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ESRCH") {
        return true;
      }
      throw error;
    }
    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, 50);
    });
  }
  return false;
}

async function stopGatewaySmoke(child) {
  if (process.platform === "win32" || !child.pid) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolvePromise) => {
          child.once("exit", resolvePromise);
        }),
        new Promise((resolvePromise) => {
          setTimeout(resolvePromise, 5_000);
        }),
      ]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await new Promise((resolvePromise) => {
          child.once("exit", resolvePromise);
        });
      }
    }
    return;
  }

  const processGroupId = -child.pid;
  process.kill(processGroupId, "SIGTERM");
  if (await waitForGatewayProcessGroupExit(processGroupId, 5_000)) {
    return;
  }
  process.kill(processGroupId, "SIGKILL");
  if (!(await waitForGatewayProcessGroupExit(processGroupId, 5_000))) {
    throw new Error("failed to stop the extracted gateway process group");
  }
}

export async function buildAndSmokeDistRuntimeArtifact(params) {
  const rootDir = resolve(params.rootDir);
  const archivePath = resolve(params.archivePath);
  const compressor = params.compressor ?? "zstdmt";
  const artifactPaths = collectDistRuntimeArtifactPaths(rootDir);
  const artifactRoot = mkdtempSync(join(tmpdir(), "openclaw-dist-runtime-artifact-"));
  mkdirSync(dirname(archivePath), { recursive: true });
  try {
    stageDistRuntimeArtifact(rootDir, artifactRoot);
    execFileSync(
      "tar",
      ["--posix", "-cf", archivePath, "--use-compress-program", compressor, ...artifactPaths],
      { cwd: artifactRoot, stdio: "inherit" },
    );

    const entries = listDistRuntimeArtifactEntries(archivePath, compressor);
    validateDistRuntimeArtifactEntries(entries, artifactPaths);

    const smokeRoot = mkdtempSync(join(tmpdir(), "openclaw-dist-runtime-artifact-smoke-"));
    const packageRoot = join(smokeRoot, "package");
    const homeDir = join(smokeRoot, "home");
    const cwd = join(smokeRoot, "cwd");
    mkdirSync(packageRoot, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });

    const artifactEnvOverrides = {
      OPENCLAW_CONFIG_PATH: join(homeDir, "openclaw.json"),
      OPENCLAW_STATE_DIR: join(homeDir, "state"),
    };
    writeFileSync(
      artifactEnvOverrides.OPENCLAW_CONFIG_PATH,
      `${JSON.stringify(
        {
          plugins: {
            allow: [BUNDLED_PLUGIN_SMOKE_ID],
            entries: { [BUNDLED_PLUGIN_SMOKE_ID]: { enabled: true } },
          },
        },
        null,
        2,
      )}\n`,
    );
    const smokeEnv = createWorkspaceBootstrapSmokeEnv(process.env, homeDir, artifactEnvOverrides);
    const gatewayEnv = { ...smokeEnv };
    delete gatewayEnv.OPENCLAW_DISABLE_BUNDLED_PLUGINS;

    let gateway;
    let gatewayOutput = "";
    try {
      execFileSync(
        "tar",
        ["--use-compress-program", compressor, "-xf", archivePath, "-C", packageRoot],
        { stdio: "inherit" },
      );
      runInstalledWorkspaceBootstrapSmoke({
        packageRoot,
        envOverrides: artifactEnvOverrides,
      });

      const acpHelp = execFileSync(
        process.execPath,
        [join(packageRoot, "openclaw.mjs"), "acp", "--help"],
        {
          cwd,
          encoding: "utf8",
          env: smokeEnv,
          maxBuffer: DIST_RUNTIME_ARTIFACT_MAX_OUTPUT_BYTES,
          timeout: DIST_RUNTIME_ARTIFACT_SMOKE_TIMEOUT_MS,
        },
      );
      if (!acpHelp.includes("Usage: openclaw acp")) {
        throw new Error("extracted ACP startup did not return the expected help output");
      }

      const port = await reserveLoopbackPort();
      gateway = spawn(
        process.execPath,
        [
          join(packageRoot, "openclaw.mjs"),
          "gateway",
          "run",
          "--allow-unconfigured",
          "--auth",
          "none",
          "--bind",
          "loopback",
          "--port",
          String(port),
        ],
        {
          cwd,
          detached: process.platform !== "win32",
          env: gatewayEnv,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const appendGatewayOutput = (chunk) => {
        gatewayOutput += chunk.toString();
        if (Buffer.byteLength(gatewayOutput) > DIST_RUNTIME_ARTIFACT_MAX_OUTPUT_BYTES) {
          gatewayOutput = gatewayOutput.slice(-DIST_RUNTIME_ARTIFACT_MAX_OUTPUT_BYTES);
        }
      };
      gateway.stdout.on("data", appendGatewayOutput);
      gateway.stderr.on("data", appendGatewayOutput);
      await waitForGatewayReadiness({ child: gateway, port, readOutput: () => gatewayOutput });
      await waitForGatewayPluginLoaded({ child: gateway, readOutput: () => gatewayOutput });
    } finally {
      if (gateway) {
        await stopGatewaySmoke(gateway);
      }
      rmSync(smokeRoot, { force: true, recursive: true });
    }
  } finally {
    rmSync(artifactRoot, { force: true, recursive: true });
  }

  return { archivePath, artifactPaths };
}
