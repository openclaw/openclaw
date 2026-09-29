import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// These drivers use only the standard library. Running the script directly
// makes UV build an inline-script venv; its launcher resolves shared temporary
// ancestors even when the caller confines all writes to its own root.
export function telegramPythonArgs(env, script, ...args) {
  return [
    "run",
    "--no-project",
    "--no-config",
    "--python",
    env.UV_PYTHON ?? ">=3.12",
    "python",
    "-B",
    script,
    ...args,
  ];
}

export function createTelegramRuntimeEnvironment(stateRoot, hostEnv = process.env) {
  const root = path.join(stateRoot, "runtime");
  const directories = {
    HOME: "home",
    OPENCLAW_HOME: "home",
    TMPDIR: "tmp",
    TMP: "tmp",
    TEMP: "tmp",
    XDG_CACHE_HOME: "cache",
    XDG_CONFIG_HOME: "config",
    XDG_DATA_HOME: "data",
    XDG_STATE_HOME: "state",
    XDG_RUNTIME_DIR: "run",
    UV_CACHE_DIR: "uv-cache",
    UV_PYTHON_INSTALL_DIR: "python",
    UV_TOOL_DIR: "uv-tools",
    UV_TOOL_BIN_DIR: "bin",
    PYTHONPYCACHEPREFIX: "pycache",
    NODE_COMPILE_CACHE: "node-cache",
    TELEGRAM_USER_DRIVER_TDLIB_CACHE_DIR: "tdlib",
  };
  const env = {};
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const [key, name] of Object.entries(directories)) {
    env[key] = path.join(root, name);
    fs.mkdirSync(env[key], { recursive: true, mode: 0o700 });
  }
  Object.assign(env, { PYTHONDONTWRITEBYTECODE: "1", UV_PYTHON_DOWNLOADS: "never" });
  // Discovery retains the host's approved installations, but even its cache and
  // temporary writes belong to this run. No project/config or download is admitted.
  const discoveryEnv = {
    UV_CACHE_DIR: env.UV_CACHE_DIR,
    TMPDIR: env.TMPDIR,
    TMP: env.TMP,
    TEMP: env.TEMP,
    PYTHONDONTWRITEBYTECODE: "1",
    ...Object.fromEntries(
      ["HOME", "PATH", "XDG_DATA_HOME", "UV_PYTHON_INSTALL_DIR"].flatMap((key) =>
        hostEnv[key] === undefined ? [] : [[key, hostEnv[key]]],
      ),
    ),
  };
  const found = spawnSync(
    "uv",
    [
      "python",
      "find",
      "--no-project",
      "--no-config",
      "--offline",
      "--no-python-downloads",
      ">=3.12",
    ],
    { env: discoveryEnv, encoding: "utf8", timeout: 15000 },
  );
  if (found.status !== 0) {
    // Credential restoration can run without uv; readiness owns its diagnostic.
    return env;
  }
  const python = fs.realpathSync(found.stdout.trim());
  env.UV_PYTHON = python;
  // Use the driver's pin/cache layout, never a second copy of its package facts.
  const cached = spawnSync(
    python,
    [
      "-I",
      "-S",
      "-B",
      "-c",
      `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("driver", sys.argv[1])
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)
library = driver.ensure_prebuilt_tdjson(download=False)
print(json.dumps(str(library) if library else None))`,
      path.join(import.meta.dirname, "user-driver.py"),
    ],
    {
      env: {
        ...discoveryEnv,
        TELEGRAM_USER_DRIVER_TDLIB_CACHE_DIR: hostEnv.TELEGRAM_USER_DRIVER_TDLIB_CACHE_DIR,
      },
      encoding: "utf8",
      timeout: 15000,
    },
  );
  if (cached.status !== 0) {
    throw new Error("Telegram cached TDLib discovery failed");
  }
  const library = hostEnv.TELEGRAM_USER_DRIVER_TDLIB_PATH || JSON.parse(cached.stdout);
  if (library) {
    env.TELEGRAM_USER_DRIVER_TDLIB_PATH = library;
  }
  return env;
}
