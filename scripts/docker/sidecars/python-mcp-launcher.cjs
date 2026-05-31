#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const CONTAINER_PYTHON = process.env.OPENCLAW_CONTAINER_PYTHON || "/usr/bin/python3";
const VENV_ROOT = process.env.OPENCLAW_AGENT_VENV_ROOT || "/home/node/.openclaw/python-venvs";
const MOUNT_ROOT_PREFIXES = [
  "/app",
  "/home/node/custom-swarm",
  "/home/node/openclaw-extra-agent-root",
  "/home/node/.openclaw/workspace",
];

function fail(message, status = 1) {
  console.error(`[python-mcp] ${message}`);
  process.exit(status);
}

function pathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function nearestMountRoot(scriptPath) {
  const resolved = path.resolve(scriptPath);
  return MOUNT_ROOT_PREFIXES.filter((root) => pathInside(root, resolved)).toSorted(
    (left, right) => right.length - left.length,
  )[0];
}

function findDependencyRoot(scriptPath) {
  let dir = path.dirname(path.resolve(scriptPath));
  const mountRoot = nearestMountRoot(scriptPath);
  while (true) {
    if (
      fs.existsSync(path.join(dir, "requirements.txt")) ||
      fs.existsSync(path.join(dir, "pyproject.toml")) ||
      fs.existsSync(path.join(dir, "setup.py")) ||
      fs.existsSync(path.join(dir, "setup.cfg"))
    ) {
      return dir;
    }
    if (!mountRoot || path.resolve(dir) === path.resolve(mountRoot)) {
      return path.dirname(path.resolve(scriptPath));
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return path.dirname(path.resolve(scriptPath));
    }
    dir = parent;
  }
}

function readIfPresent(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch {
    return Buffer.alloc(0);
  }
}

function dependencyFingerprint(root) {
  const hash = crypto.createHash("sha256");
  hash.update(root);
  for (const name of ["requirements.txt", "pyproject.toml", "setup.py", "setup.cfg"]) {
    const filePath = path.join(root, name);
    hash.update(name);
    hash.update(readIfPresent(filePath));
  }
  return hash.digest("hex");
}

function venvPython(venvDir) {
  return path.join(venvDir, "bin", "python");
}

function runChecked(command, args, options) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "inherit", "inherit"],
    ...options,
  });
  if (result.error) {
    fail(`${command} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} exited with status ${result.status ?? "unknown"}`);
  }
}

function ensureVenv(scriptPath) {
  const root = findDependencyRoot(scriptPath);
  const requirementsPath = path.join(root, "requirements.txt");
  const hasRequirements = fs.existsSync(requirementsPath);
  const hasProject =
    fs.existsSync(path.join(root, "pyproject.toml")) ||
    fs.existsSync(path.join(root, "setup.py")) ||
    fs.existsSync(path.join(root, "setup.cfg"));
  if (!hasRequirements && !hasProject) {
    return { cwd: root, python: CONTAINER_PYTHON, venvDir: null };
  }

  const rootHash = crypto.createHash("sha256").update(root).digest("hex").slice(0, 16);
  const sourceHash = dependencyFingerprint(root);
  const venvDir = path.join(VENV_ROOT, rootHash);
  const stampPath = path.join(venvDir, ".openclaw-python-mcp-stamp.json");
  const python = venvPython(venvDir);
  let current = null;
  try {
    current = JSON.parse(fs.readFileSync(stampPath, "utf8"));
  } catch {}

  if (current?.sourceHash === sourceHash && fs.existsSync(python)) {
    return { cwd: root, python, venvDir };
  }

  fs.mkdirSync(VENV_ROOT, { recursive: true });
  if (!fs.existsSync(python)) {
    runChecked(CONTAINER_PYTHON, ["-m", "venv", venvDir]);
  }

  const pipEnv = {
    ...process.env,
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PYTHONUNBUFFERED: "1",
  };
  if (hasRequirements) {
    runChecked(
      python,
      ["-m", "pip", "install", "--disable-pip-version-check", "-r", requirementsPath],
      {
        cwd: root,
        env: pipEnv,
      },
    );
  }
  if (hasProject) {
    runChecked(python, ["-m", "pip", "install", "--disable-pip-version-check", "-e", root], {
      cwd: root,
      env: pipEnv,
    });
  }

  fs.writeFileSync(
    stampPath,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), root, sourceHash }, null, 2)}\n`,
  );
  return { cwd: root, python, venvDir };
}

const argv = process.argv.slice(2);
const prepareOnly = argv[0] === "--prepare";
if (prepareOnly) {
  argv.shift();
}
const scriptPath = argv.shift();
if (!scriptPath) {
  fail("usage: python-mcp-launcher.cjs [--prepare] <script.py> [args...]", 64);
}
if (!fs.existsSync(scriptPath)) {
  fail(`launch script does not exist: ${scriptPath}`);
}

const prepared = ensureVenv(scriptPath);
if (prepareOnly) {
  process.exit(0);
}

const binDir = path.dirname(prepared.python);
const child = spawn(prepared.python, [scriptPath, ...argv], {
  cwd: prepared.cwd,
  env: {
    ...process.env,
    ...(prepared.venvDir ? { VIRTUAL_ENV: prepared.venvDir } : {}),
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
    PYTHONUNBUFFERED: "1",
  },
  stdio: "inherit",
});

child.on("error", (error) => fail(error.message));
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
