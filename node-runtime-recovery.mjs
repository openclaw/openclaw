// Startup-only recovery; this module cannot depend on dist or installed packages.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectCurrentSqliteCapabilities,
  nodeRuntimeFailure,
  SQLITE_CAPABILITY_PROBE,
} from "./node-sqlite.mjs";

const LAUNCHER_ROOT_BOOLEAN_FLAGS = new Set(["--dev", "--no-color"]);
const LAUNCHER_ROOT_VALUE_FLAGS = new Set(["--profile", "--log-level", "--container"]);
export const isNativeHookRelayInvocation = (argv) => argv[2] === "hooks" && argv[3] === "relay";

const isLauncherRootOptionValueToken = (arg) => {
  if (!arg || arg === "--") {
    return false;
  }
  if (!arg.startsWith("-")) {
    return true;
  }
  return /^-\d+(?:\.\d+)?$/.test(arg);
};

export const consumeLauncherRootOptionToken = (args, index) => {
  const arg = args[index];
  if (!arg) {
    return 0;
  }
  if (LAUNCHER_ROOT_BOOLEAN_FLAGS.has(arg)) {
    return 1;
  }
  if (
    arg.startsWith("--profile=") ||
    arg.startsWith("--log-level=") ||
    arg.startsWith("--container=")
  ) {
    return 1;
  }
  if (LAUNCHER_ROOT_VALUE_FLAGS.has(arg)) {
    return isLauncherRootOptionValueToken(args[index + 1]) ? 2 : 1;
  }
  return 0;
};

// Mirror the entry's foreground Gmail policy before any built modules can load.
// A compile-cache wrapper would kill its owner before descendant cleanup finishes.
export const isForegroundGmailRunInvocation = (argv) => {
  const args = argv.slice(2);
  const commandPath = [];
  for (let index = 0; index < args.length && commandPath.length < 3; index += 1) {
    const consumed = consumeLauncherRootOptionToken(args, index);
    if (consumed > 0) {
      index += consumed - 1;
    } else if (!args[index] || args[index].startsWith("-")) {
      break;
    } else {
      commandPath.push(args[index]);
    }
  }
  return commandPath.join(" ") === "webhooks gmail run";
};

const respawnSignals =
  process.platform === "win32"
    ? ["SIGTERM", "SIGINT", "SIGBREAK"]
    : ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"];
const respawnSignalExitGraceMs = 1_000;
const respawnSignalForceKillGraceMs = 1_000;
const respawnSignalHardExitGraceMs = 1_000;

export const runRespawnedChild = (command, args, env) => {
  const child = spawn(command, args, {
    stdio: "inherit",
    env,
  });
  const listeners = new Map();
  // This intentionally overlaps with src/entry.compile-cache.ts; keep the
  // respawn supervision behavior in sync until the launcher can share TS code.
  // Give the child a moment to honor forwarded signals, then exit the wrapper so
  // a child that ignores SIGTERM cannot keep the launcher alive indefinitely.
  let signalExitTimer = null;
  let signalForceKillTimer = null;
  let signalHardExitTimer = null;
  let firstForwardedSignal = null;
  let hardKillBackstopStarted = false;
  const detach = () => {
    for (const [signal, listener] of listeners) {
      process.off(signal, listener);
    }
    listeners.clear();
    if (signalExitTimer) {
      clearTimeout(signalExitTimer);
      signalExitTimer = null;
    }
    if (signalForceKillTimer) {
      clearTimeout(signalForceKillTimer);
      signalForceKillTimer = null;
    }
    if (signalHardExitTimer) {
      clearTimeout(signalHardExitTimer);
      signalHardExitTimer = null;
    }
  };
  const forceKillChild = () => {
    try {
      child.kill(process.platform === "win32" ? "SIGTERM" : "SIGKILL");
    } catch {
      // Best-effort shutdown fallback.
    }
  };
  const requestChildTermination = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      // Best-effort shutdown fallback.
    }
    signalForceKillTimer = setTimeout(() => {
      hardKillBackstopStarted = true;
      forceKillChild();
      signalHardExitTimer = setTimeout(() => {
        process.exit(1);
      }, respawnSignalHardExitGraceMs);
      signalHardExitTimer.unref?.();
    }, respawnSignalForceKillGraceMs);
    signalForceKillTimer.unref?.();
  };
  const scheduleParentExit = (signal) => {
    firstForwardedSignal ??= signal;
    if (signalExitTimer) {
      return;
    }
    signalExitTimer = setTimeout(() => {
      requestChildTermination();
    }, respawnSignalExitGraceMs);
    signalExitTimer.unref?.();
  };
  for (const signal of respawnSignals) {
    const listener = () => {
      try {
        child.kill(signal);
      } catch {
        // Best-effort signal forwarding.
      }
      scheduleParentExit(signal);
    };
    try {
      process.on(signal, listener);
      listeners.set(signal, listener);
    } catch {
      // Unsupported signal on this platform.
    }
  }
  child.once("exit", (code, signal) => {
    detach();
    if (signal) {
      const forwardedSignalExitCode =
        !hardKillBackstopStarted && signal === firstForwardedSignal
          ? signal === "SIGINT"
            ? 130
            : signal === "SIGTERM"
              ? 143
              : undefined
          : undefined;
      process.exit(forwardedSignalExitCode ?? 1);
    }
    process.exit(code ?? 1);
  });
  child.once("error", (error) => {
    detach();
    process.stderr.write(
      `[openclaw] Failed to respawn launcher: ${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }\n`,
    );
    process.exit(1);
  });
  return true;
};

function readSmallFile(filename) {
  try {
    const info = statSync(filename);
    return info.isFile() && info.size <= 65_536 ? readFileSync(filename, "utf8") : null;
  } catch {
    return null;
  }
}

function realNodePath(filename) {
  try {
    return realpathSync(filename);
  } catch {
    return null;
  }
}

// Do not pass preload hooks, native-library overrides, or application secrets to probes.
export function isUsableNode(nodePath) {
  if (!realNodePath(nodePath)) {
    return false;
  }
  const env = { NODE_NO_WARNINGS: "1" };
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(SystemRoot|WINDIR|TEMP|TMP|TMPDIR)$/i.test(key)) {
      env[key] = value;
    }
  }
  const result = spawnSync(
    nodePath,
    [
      "-e",
      `const probe = ${SQLITE_CAPABILITY_PROBE}; process.stdout.write(JSON.stringify({ version: process.versions.node, probe }));`,
    ],
    {
      encoding: "utf8",
      env,
      timeout: 5_000,
      killSignal: "SIGKILL",
      maxBuffer: 65_536,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  try {
    const details = JSON.parse(result.stdout);
    return result.status === 0 && !nodeRuntimeFailure(details.version, details.probe);
  } catch {
    return false;
  }
}

function managedServiceNode(homeDir) {
  const env = process.env;
  let profile = env.OPENCLAW_PROFILE?.trim();
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length;) {
    const consumed = consumeLauncherRootOptionToken(args, index);
    if (!consumed) {
      break;
    }
    if (args[index] === "--dev") {
      profile = "dev";
    } else if (args[index] === "--profile") {
      profile = args[index + 1];
    } else if (args[index].startsWith("--profile=")) {
      profile = args[index].slice("--profile=".length);
    }
    index += consumed;
  }
  const suffix = profile && profile.toLowerCase() !== "default" ? profile : "";
  const serviceHome = env.HOME?.trim() || env.USERPROFILE?.trim() || homeDir;
  let command;
  if (process.platform === "darwin") {
    const label = env.OPENCLAW_LAUNCHD_LABEL?.trim() || `ai.openclaw.${suffix || "gateway"}`;
    if (!/^[A-Za-z0-9._-]+$/.test(label)) {
      return null;
    }
    const text = readSmallFile(path.join(serviceHome, "Library", "LaunchAgents", `${label}.plist`));
    const array = text?.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1];
    const recordedArgs = [...(array || "").matchAll(/<string>([^<]*)<\/string>/g)].map(
      ([, value]) =>
        value.replace(
          /&(amp|lt|gt|quot|apos);/g,
          (_, name) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" })[name],
        ),
    );
    const wrapperIndex = recordedArgs[0] === "/bin/sh" ? 1 : 0;
    const generatedWrapper =
      recordedArgs[wrapperIndex]?.endsWith(`${label}-env-wrapper.sh`) &&
      recordedArgs[wrapperIndex + 1]?.endsWith(`${label}.env`);
    command = recordedArgs[generatedWrapper ? wrapperIndex + 2 : 0];
  } else if (process.platform === "linux") {
    const name =
      env.OPENCLAW_SYSTEMD_UNIT?.trim() || `openclaw-gateway${suffix ? `-${suffix}` : ""}`;
    if (!/^[A-Za-z0-9._@-]+$/.test(name)) {
      return null;
    }
    const filename = name.endsWith(".service") ? name : `${name}.service`;
    const text = readSmallFile(path.join(serviceHome, ".config", "systemd", "user", filename));
    const service = text?.split(/^\s*\[Service\]\s*$/m)[1]?.split(/^\s*\[/m)[0];
    const executable = service?.match(/^\s*ExecStart=\s*(?:"((?:[^"\\]|\\.)*)"|(\S+))/m);
    command = (executable?.[1] ?? executable?.[2])?.replace(/\\(.)/g, "$1");
  } else if (process.platform === "win32") {
    const scriptName = env.OPENCLAW_TASK_SCRIPT_NAME?.trim() || "gateway.cmd";
    if (/[/\\]|\.\./.test(scriptName)) {
      return null;
    }
    const stateDir =
      env.OPENCLAW_STATE_DIR?.trim() ||
      path.join(serviceHome, `.openclaw${suffix ? `-${suffix}` : ""}`);
    const filename = env.OPENCLAW_TASK_SCRIPT?.trim() || path.join(stateDir, scriptName);
    const text = readSmallFile(filename);
    command = text?.match(/^\s*@?"([^"]*\\node\.exe)"(?:\s|$)/im)?.[1];
  }
  // Service definitions are data. Never execute a shell, service wrapper, or manager shim.
  return command && path.isAbsolute(command) && /^node(?:\.exe)?$/i.test(path.basename(command))
    ? command
    : null;
}

function directoryNames(directory) {
  try {
    return readdirSync(directory).toSorted().slice(0, 256);
  } catch {
    return [];
  }
}

function resolveNvmDefault(root) {
  let alias = readSmallFile(path.join(root, "alias", "default"))?.trim();
  for (let depth = 0; alias && depth < 8; depth += 1) {
    if (/^v?\d+(?:\.\d+){0,2}$/.test(alias) || ["node", "stable"].includes(alias)) {
      const prefix = alias.replace(/^v/, "");
      const version = directoryNames(path.join(root, "versions", "node"))
        .filter((name) => /^v\d+\.\d+\.\d+$/.test(name))
        .filter(
          (name) =>
            ["node", "stable"].includes(alias) ||
            name === `v${prefix}` ||
            name.startsWith(`v${prefix}.`),
        )
        .toSorted((a, b) => b.localeCompare(a, "en", { numeric: true }))[0];
      return version ? path.join(root, "versions", "node", version, "bin", "node") : null;
    }
    if (alias === "lts/*") {
      const versions = directoryNames(path.join(root, "alias", "lts"))
        .map((name) => readSmallFile(path.join(root, "alias", "lts", name))?.trim())
        .filter((value) => value && /^v?\d+\.\d+\.\d+$/.test(value))
        .toSorted((a, b) => b.localeCompare(a, "en", { numeric: true }));
      alias = versions[0];
    } else if (/^(?:lts\/)?[A-Za-z0-9_-]+$/.test(alias)) {
      alias = readSmallFile(path.join(root, "alias", alias))?.trim();
    } else {
      return null;
    }
  }
  return null;
}

function* availableNodeCandidates(homeDir) {
  yield [managedServiceNode(homeDir), "managed Gateway service"];
  const pathKey =
    process.platform === "win32"
      ? Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") || "PATH"
      : "PATH";
  const binary = process.platform === "win32" ? "node.exe" : "node";
  for (const directory of (process.env[pathKey] || "").split(path.delimiter)) {
    if (directory) {
      yield [path.resolve(directory, binary), "PATH"];
    }
  }
  const managerHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homeDir;
  for (const root of new Set([process.env.NVM_DIR, path.join(managerHome, ".nvm")])) {
    if (root) {
      yield [resolveNvmDefault(root), "nvm default"];
    }
  }
  for (const root of new Set([
    process.env.FNM_DIR,
    path.join(managerHome, ".fnm"),
    path.join(managerHome, ".local", "share", "fnm"),
    ...(process.platform === "darwin"
      ? [path.join(managerHome, "Library", "Application Support", "fnm")]
      : []),
  ])) {
    if (root) {
      yield [
        path.join(
          root,
          "aliases",
          "default",
          ...(process.platform === "win32" ? [] : ["bin"]),
          binary,
        ),
        "fnm default",
      ];
    }
  }
  for (const root of new Set([process.env.VOLTA_HOME, path.join(managerHome, ".volta")])) {
    if (!root) {
      continue;
    }
    try {
      const version = JSON.parse(readSmallFile(path.join(root, "tools", "user", "platform.json")))
        ?.node?.runtime;
      if (typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version)) {
        yield [
          path.join(
            root,
            "tools",
            "image",
            "node",
            version,
            ...(process.platform === "win32" ? [] : ["bin"]),
            binary,
          ),
          "Volta default",
        ];
      }
    } catch {
      // Missing or incomplete manager metadata does not select a runtime.
    }
  }
  for (const major of [26, 24]) {
    for (const prefix of ["/opt/homebrew", "/usr/local"]) {
      if (process.platform === "darwin" || process.platform === "linux") {
        yield [path.join(prefix, "opt", `node@${major}`, "bin", "node"), `Homebrew node@${major}`];
      }
    }
  }
}

/** Recover only at CLI startup, before reading config or state. */
export async function recoverNodeRuntime({ homeDir, allowInstall = false } = {}) {
  if (
    process.versions.bun ||
    process.env.OPENCLAW_NODE_UPDATE_RESPAWNED === "1" ||
    !process.argv[1] ||
    isForegroundGmailRunInvocation(process.argv) ||
    (process.platform !== "win32" && isNativeHookRelayInvocation(process.argv)) ||
    !nodeRuntimeFailure(process.versions.node, detectCurrentSqliteCapabilities())
  ) {
    return false;
  }
  const osHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || os.homedir();
  const configuredHome = process.env.OPENCLAW_HOME?.trim() || osHome;
  const recoveryHome =
    homeDir ?? path.resolve(configuredHome.replace(/^~(?=$|[\\/])/, () => osHome));
  const { resolveUpdatedNodeRuntime } = await import("./node-runtime-update.mjs");
  let nodePath = await resolveUpdatedNodeRuntime(recoveryHome, { allowInstall: false });
  let reason = "cached OpenClaw runtime";
  const currentNode = realNodePath(process.execPath);
  if (!nodePath) {
    const seen = new Set([currentNode]);
    for (const [candidate, source] of availableNodeCandidates(recoveryHome)) {
      const realPath = candidate && realNodePath(candidate);
      if (!realPath || seen.has(realPath)) {
        continue;
      }
      seen.add(realPath);
      if (isUsableNode(realPath)) {
        nodePath = realPath;
        reason = source;
        break;
      }
    }
  }
  if (!nodePath && allowInstall) {
    nodePath = await resolveUpdatedNodeRuntime(recoveryHome);
    reason = "private OpenClaw runtime";
  }
  if (!nodePath) {
    return false;
  }
  const env = { ...process.env, OPENCLAW_NODE_UPDATE_RESPAWNED: "1" };
  process.stderr.write(
    `openclaw: Retrying with ${JSON.stringify(nodePath)} (${reason}; current Node failed runtime admission).\n`,
  );
  runRespawnedChild(
    nodePath,
    [...process.execArgv, process.argv[1], ...process.argv.slice(2)],
    env,
  );
  // The original CLI must not continue while the replacement owns the invocation.
  return await new Promise(() => {});
}
