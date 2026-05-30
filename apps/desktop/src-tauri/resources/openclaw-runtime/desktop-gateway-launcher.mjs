#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  process.stderr.write(
    [
      "Usage:",
      "  desktop-gateway-launcher.mjs gateway --port <port>",
      "  desktop-gateway-launcher.mjs plugins install <source>",
      "  desktop-gateway-launcher.mjs cli status",
      "  desktop-gateway-launcher.mjs cli install --manager <auto|npm|pnpm|bun>",
      "",
    ].join("\n"),
  );
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function findRepoRoot(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    const packageJson = existsSync(packageJsonPath) ? readJson(packageJsonPath) : null;
    if (packageJson?.name === "openclaw" && existsSync(path.join(current, "scripts", "run-node.mjs"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function resolvePackagedOpenClawRoot() {
  const packageRoot = path.join(here, "openclaw");
  return existsSync(path.join(packageRoot, "openclaw.mjs")) ? packageRoot : null;
}

function resolveOpenClawCommand() {
  const packagedRoot = resolvePackagedOpenClawRoot();
  if (packagedRoot) {
    return {
      cwd: packagedRoot,
      args: [path.join(packagedRoot, "openclaw.mjs")],
    };
  }

  const explicitRepoRoot = process.env.OPENCLAW_DESKTOP_REPO_ROOT?.trim();
  const repoRoot =
    (explicitRepoRoot && findRepoRoot(explicitRepoRoot)) ||
    findRepoRoot(process.cwd()) ||
    findRepoRoot(path.resolve(here, "../../../.."));
  if (repoRoot) {
    return {
      cwd: repoRoot,
      args: [path.join(repoRoot, "scripts", "run-node.mjs")],
    };
  }

  throw new Error("Could not locate packaged OpenClaw runtime or development checkout");
}

function commandVersion(command, args = ["--version"]) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return null;
  }
  return `${result.stdout || result.stderr}`.trim() || null;
}

function commandExists(command) {
  return commandVersion(command) !== null;
}

function resolvePackageManager(rawManager) {
  const manager = rawManager?.trim() || "auto";
  if (!["auto", "npm", "pnpm", "bun"].includes(manager)) {
    throw new Error(`Unsupported CLI install manager: ${rawManager}`);
  }
  if (manager !== "auto") {
    if (!commandExists(manager)) {
      throw new Error(`${manager} is not available on PATH`);
    }
    return manager;
  }
  for (const candidate of ["npm", "pnpm", "bun"]) {
    if (commandExists(candidate)) {
      return candidate;
    }
  }
  throw new Error("No supported package manager found on PATH (npm, pnpm, or bun)");
}

function readRuntimeManifest() {
  return readJson(path.join(here, "runtime-manifest.json"));
}

function resolveCliInstallSpec() {
  const version = readRuntimeManifest()?.openclaw?.version;
  return typeof version === "string" && version.trim()
    ? `openclaw@${version.trim()}`
    : "openclaw@latest";
}

function cliInstallArgs(manager, spec) {
  if (manager === "npm") {
    return ["install", "-g", spec];
  }
  if (manager === "pnpm") {
    return ["add", "-g", spec];
  }
  return ["add", "-g", spec];
}

function parsePort(argv) {
  const portIndex = argv.indexOf("--port");
  const raw = portIndex === -1 ? process.env.OPENCLAW_DESKTOP_GATEWAY_PORT : argv[portIndex + 1];
  const port = Number(raw ?? 18789);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid gateway port: ${raw}`);
  }
  return String(port);
}

function parseToken() {
  const raw = process.env.OPENCLAW_GATEWAY_TOKEN;
  const token = raw?.trim();
  if (!token) {
    return null;
  }
  return token;
}

function resolveStateDir() {
  const explicitState = process.env.OPENCLAW_STATE_DIR?.trim();
  if (explicitState) {
    return path.resolve(explicitState.replace(/^~(?=$|[/\\])/u, os.homedir()));
  }
  const openclawHome = process.env.OPENCLAW_HOME?.trim();
  const home = openclawHome
    ? path.resolve(openclawHome.replace(/^~(?=$|[/\\])/u, os.homedir()))
    : os.homedir();
  return path.join(home, ".openclaw");
}

function maybeInstallBundledLobster(openclaw, env) {
  const artifact = path.join(here, "plugins", "openclaw-lobster.tgz");
  if (!existsSync(artifact)) {
    return Promise.resolve();
  }
  const artifactSha256 = createHash("sha256").update(readFileSync(artifact)).digest("hex");
  const markerDir = path.join(resolveStateDir(), "desktop");
  const markerPath = path.join(markerDir, "lobster-bootstrap.json");
  const marker = readJson(markerPath);
  if (marker?.artifactSha256 === artifactSha256) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [...openclaw.args, "plugins", "install", `npm-pack:${artifact}`],
      {
        cwd: openclaw.cwd,
        env,
        stdio: "inherit",
      },
    );
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        mkdirSync(markerDir, { recursive: true });
        writeFileSync(
          markerPath,
          `${
            JSON.stringify(
              { installedAt: new Date().toISOString(), artifact, artifactSha256 },
              null,
              2,
            )
          }\n`,
        );
        resolve();
        return;
      }
      reject(new Error(`Bundled Lobster install failed (${code ?? signal ?? "unknown"})`));
    });
  });
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "gateway" && command !== "plugins" && command !== "cli") {
    usage();
    process.exit(2);
  }

  const openclaw = resolveOpenClawCommand();
  const env = {
    ...process.env,
    OPENCLAW_DESKTOP: "1",
    OPENCLAW_CONTROL_UI_BASE_PATH: "/",
  };

  if (command === "plugins") {
    const [subcommand, source, ...extra] = rest;
    if (subcommand !== "install" || !source || extra.length > 0) {
      usage();
      process.exit(2);
    }
    const child = spawn(process.execPath, [...openclaw.args, "plugins", "install", source], {
      cwd: openclaw.cwd,
      env,
      stdio: "inherit",
    });
    child.on("error", (error) => {
      console.error(error);
      process.exit(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code ?? 1);
    });
    return;
  }

  if (command === "cli") {
    const [subcommand, ...extra] = rest;
    if (subcommand === "status" && extra.length === 0) {
      const openclawVersion = commandVersion("openclaw", ["--version"]);
      const managers = Object.fromEntries(
        ["npm", "pnpm", "bun"].map((manager) => [manager, commandVersion(manager)]),
      );
      process.stdout.write(
        `${JSON.stringify({
          installed: openclawVersion !== null,
          version: openclawVersion,
          packageManagers: managers,
          preferredManager: ["npm", "pnpm", "bun"].find((manager) => managers[manager]) ?? null,
          installSpec: resolveCliInstallSpec(),
        })}\n`,
      );
      return;
    }
    if (subcommand === "install") {
      const managerIndex = extra.indexOf("--manager");
      const rawManager = managerIndex === -1 ? "auto" : extra[managerIndex + 1];
      const allowedExtra =
        extra.length === 0 || (managerIndex === 0 && extra.length === 2 && rawManager);
      if (!allowedExtra) {
        usage();
        process.exit(2);
      }
      const manager = resolvePackageManager(rawManager);
      const spec = resolveCliInstallSpec();
      const child = spawn(manager, cliInstallArgs(manager, spec), {
        cwd: process.cwd(),
        env,
        stdio: "inherit",
      });
      child.on("error", (error) => {
        console.error(error);
        process.exit(1);
      });
      child.on("exit", (code, signal) => {
        if (signal) {
          process.kill(process.pid, signal);
          return;
        }
        process.exit(code ?? 1);
      });
      return;
    }
    usage();
    process.exit(2);
  }

  const port = parsePort(rest);
  parseToken();
  await maybeInstallBundledLobster(openclaw, env).catch((error) => {
    console.error(`[desktop] optional Lobster bootstrap failed: ${error?.message ?? error}`);
  });

  const gatewayArgs = [
    ...openclaw.args,
    "gateway",
    "run",
    "--port",
    port,
    "--bind",
    "loopback",
    "--auth",
    "token",
    "--allow-unconfigured",
  ];
  const child = spawn(
    process.execPath,
    gatewayArgs,
    {
      cwd: openclaw.cwd,
      env,
      stdio: "inherit",
    },
  );

  const forwardSignal = (signal) => {
    if (!child.killed) {
      child.kill(signal);
    }
  };
  process.once("SIGINT", () => forwardSignal("SIGINT"));
  process.once("SIGTERM", () => forwardSignal("SIGTERM"));

  child.on("error", (error) => {
    console.error(error);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
