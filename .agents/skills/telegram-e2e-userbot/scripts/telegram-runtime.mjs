import fs from "node:fs";
import path from "node:path";

// These drivers use only the standard library. Running the script directly
// makes UV build an inline-script venv; its launcher resolves shared temporary
// ancestors even when the caller confines all writes to its own root.
export function telegramPythonArgs(script, ...args) {
  return [
    "run",
    "--no-project",
    "--no-config",
    "--python",
    ">=3.12",
    "python",
    "-B",
    script,
    ...args,
  ];
}

export function createTelegramRuntimeEnvironment(stateRoot) {
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
  return { ...env, PYTHONDONTWRITEBYTECODE: "1", UV_PYTHON_DOWNLOADS: "never" };
}
