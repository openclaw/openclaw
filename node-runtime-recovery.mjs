// Startup-only recovery; this module cannot depend on dist or installed packages.
import { spawn, spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
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

// Mirror the entry's foreground Gmail policy: a wrapper would kill that run before descendant cleanup finishes.
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
  // Keep signal forwarding and bounded shutdown in sync with src/entry.compile-cache.ts.
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
      if (process.platform !== "win32") {
        process.kill(process.pid, signal);
        return;
      }
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

function readSmallFile(filename, encoding = "utf8") {
  const resolved = resolveRecoveryPath(filename);
  if (!resolved) {
    return null;
  }
  try {
    const info = statSync(resolved);
    return info.isFile() && info.size <= 65_536 ? readFileSync(resolved, encoding) : null;
  } catch {
    return null;
  }
}

// Match windows-encoding.ts labels; skip CP850 (no decoder) and CP949 (corrupts UHC).
const WINDOWS_SERVICE_CODEPAGE_LABELS = {
  437: "cp437",
  720: "cp720",
  737: "cp737",
  775: "cp775",
  850: "cp850",
  852: "cp852",
  855: "cp855",
  857: "cp857",
  858: "cp858",
  860: "cp860",
  861: "cp861",
  862: "cp862",
  863: "cp863",
  865: "cp865",
  866: "ibm866",
  869: "cp869",
  874: "windows-874",
  932: "shift_jis",
  936: "gbk",
  949: "euc-kr",
  950: "big5",
  1200: "utf-16le",
  1201: "utf-16be",
  1250: "windows-1250",
  1251: "windows-1251",
  1252: "windows-1252",
  1253: "windows-1253",
  1254: "windows-1254",
  1255: "windows-1255",
  1256: "windows-1256",
  1257: "windows-1257",
  1258: "windows-1258",
  28591: "iso-8859-1",
  28592: "iso-8859-2",
  28593: "iso-8859-3",
  28594: "iso-8859-4",
  28595: "iso-8859-5",
  28596: "iso-8859-6",
  28597: "iso-8859-7",
  28598: "iso-8859-8",
  28599: "iso-8859-9",
  28600: "iso-8859-10",
  28603: "iso-8859-13",
  28604: "iso-8859-14",
  28605: "iso-8859-15",
  28606: "iso-8859-16",
  38598: "iso-8859-8-i",
  54936: "gb18030",
  65001: "utf-8",
};

function readWindowsServiceScript(filename) {
  let buffer = readSmallFile(filename, null);
  if (!buffer) {
    return null;
  }
  let codePage = 65001;
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    codePage = 1200;
  } else if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    codePage = 1201;
  } else {
    if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      buffer = buffer.subarray(3);
    }
    let end = buffer.indexOf(0x0a);
    const preamble = /^@chcp (\d+) >nul\s*$/.exec(
      buffer.subarray(0, end < 0 ? buffer.length : end).toString("latin1"),
    );
    if (preamble) {
      codePage = Number(preamble[1]);
      buffer = buffer.subarray(end < 0 ? buffer.length : end + 1);
      end = buffer.indexOf(0x0a);
    }
    const marker = /^@rem openclaw-launcher-encoding=(\S+)\s*$/.exec(
      buffer.subarray(0, end < 0 ? buffer.length : end).toString("latin1"),
    );
    if (marker) {
      if (!preamble) {
        const label = marker[1].toLowerCase();
        const numeric = /^cp(\d+)$/.exec(label);
        codePage = numeric
          ? Number(numeric[1])
          : Number(
              Object.entries(WINDOWS_SERVICE_CODEPAGE_LABELS).find(
                ([, value]) => value === label,
              )?.[0],
            );
      }
      buffer = buffer.subarray(end < 0 ? buffer.length : end + 1);
    }
  }
  const label = WINDOWS_SERVICE_CODEPAGE_LABELS[codePage];
  try {
    if (label && codePage !== 850 && codePage !== 949) {
      const decoder = new TextDecoder(label, { fatal: true });
      return decoder.decode(buffer);
    }
  } catch {
    // A missing decoder or invalid byte sequence must not select a guessed path.
  }
  process.stderr.write(
    `openclaw: service script uses code page ${Number.isFinite(codePage) ? codePage : "unknown"}; not decodable here\n`,
  );
  return null;
}

function realNodePath(filename) {
  try {
    return realpathSync(filename);
  } catch {
    return null;
  }
}

function isPathWithin(filename, directory) {
  const relative = path.relative(directory, filename);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// Match daemon/paths.ts home expansion without resolving relative inputs against cwd.
export function resolveRecoveryPath(
  value,
  homeDir,
  { allowMissing = false, allowCwd = false, trustedRoot } = {},
) {
  const expanded = value?.trim().replace(/^~(?=$|[\\/])/, () => homeDir ?? "~");
  if (!expanded || !path.isAbsolute(expanded)) {
    return null;
  }
  const paths = /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(expanded) ? path.win32 : path;
  const absolute = paths.resolve(expanded);
  const cwd = realNodePath(process.cwd()) ?? process.cwd();
  // Trust only the private recovery root when launching from HOME; reject other cwd symlinks.
  const trusted =
    trustedRoot && path.isAbsolute(trustedRoot) && isPathWithin(absolute, trustedRoot);
  const excluded = (filename) =>
    !allowCwd && isPathWithin(filename, cwd) && !(trusted && isPathWithin(filename, trustedRoot));
  if (excluded(absolute)) {
    return null;
  }
  if (!allowCwd) {
    // A final symlink can hide a workspace-owned intermediate directory.
    for (let prefix = paths.dirname(absolute); ;) {
      if (trusted && !isPathWithin(prefix, trustedRoot)) {
        break;
      }
      const real = realNodePath(prefix);
      if (real && excluded(real)) {
        return null;
      }
      const parent = paths.dirname(prefix);
      if (parent === prefix) {
        break;
      }
      prefix = parent;
    }
  }
  let existing = absolute;
  const missing = [];
  for (;;) {
    const real = realNodePath(existing);
    if (real) {
      const resolved = paths.resolve(real, ...missing);
      return path.isAbsolute(resolved) && !excluded(resolved) ? resolved : null;
    }
    if (!allowMissing) {
      return null;
    }
    // An existing dangling symlink or unreadable path is not a creatable suffix.
    try {
      lstatSync(existing);
      return null;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        return null;
      }
    }
    const parent = paths.dirname(existing);
    if (parent === existing) {
      return null;
    }
    missing.unshift(paths.basename(existing));
    existing = parent;
  }
}

// Do not pass preload hooks, native-library overrides, or application secrets to probes.
export function isUsableNode(
  nodePath,
  { allowCwd = false, trustedRoot, env = process.env, acceptVersion } = {},
) {
  const resolved = resolveRecoveryPath(nodePath, undefined, { allowCwd, trustedRoot });
  if (!resolved || !/^node(?:\.exe)?$/i.test(path.basename(resolved))) {
    return false;
  }
  const probeEnv = { NODE_NO_WARNINGS: "1" };
  for (const [key, value] of Object.entries(env)) {
    if (/^(SystemRoot|WINDIR|TEMP|TMP|TMPDIR)$/i.test(key)) {
      probeEnv[key] = value;
    }
  }
  const result = spawnSync(
    resolved,
    [
      "-e",
      `const probe = ${SQLITE_CAPABILITY_PROBE}; process.stdout.write(JSON.stringify({ version: process.versions.node, probe }));`,
    ],
    {
      encoding: "utf8",
      env: probeEnv,
      timeout: 5_000,
      killSignal: "SIGKILL",
      maxBuffer: 65_536,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  try {
    const details = JSON.parse(result.stdout);
    return (
      result.status === 0 &&
      !nodeRuntimeFailure(details.version, details.probe) &&
      (!acceptVersion || acceptVersion(details.version))
    );
  } catch {
    return false;
  }
}

function windowsServiceNode(text) {
  for (const line of text.split(/\r?\n/)) {
    const command = line.trimStart().replace(/^@/, "");
    let executable = "";
    let quoted = false;
    // Mirror quoteCmdScriptArg: other Windows path backslashes stay literal.
    for (let index = 0; index < command.length; index += 1) {
      const char = command[index];
      if (char === "\\" && command[index + 1] === '"') {
        executable += '"';
        index += 1;
      } else if (char === '"') {
        quoted = !quoted;
      } else if (/\s/.test(char) && !quoted) {
        break;
      } else {
        executable += char;
      }
    }
    executable = executable.replace(/\^!/g, "!").replace(/%%/g, "%");
    if (
      !quoted &&
      path.win32.isAbsolute(executable) &&
      /^node\.exe$/i.test(path.win32.basename(executable))
    ) {
      return executable;
    }
  }
  return null;
}

function managedServiceNode(homeDir, env) {
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
  let command;
  if (process.platform === "darwin") {
    if (!homeDir) {
      return null;
    }
    const label = env.OPENCLAW_LAUNCHD_LABEL?.trim() || `ai.openclaw.${suffix || "gateway"}`;
    if (!/^[A-Za-z0-9._-]+$/.test(label)) {
      return null;
    }
    const text = readSmallFile(path.join(homeDir, "Library", "LaunchAgents", `${label}.plist`));
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
    if (!homeDir) {
      return null;
    }
    const name =
      env.OPENCLAW_SYSTEMD_UNIT?.trim() || `openclaw-gateway${suffix ? `-${suffix}` : ""}`;
    if (!/^[A-Za-z0-9._@-]+$/.test(name)) {
      return null;
    }
    const filename = name.endsWith(".service") ? name : `${name}.service`;
    const text = readSmallFile(path.join(homeDir, ".config", "systemd", "user", filename));
    const service = text?.split(/^\s*\[Service\]\s*$/m)[1]?.split(/^\s*\[/m)[0];
    const executable = service?.match(/^\s*ExecStart=\s*(?:"((?:[^"\\]|\\.)*)"|(\S+))/m);
    command = (executable?.[1] ?? executable?.[2])?.replace(/\\(.)/g, "$1");
  } else if (process.platform === "win32") {
    const scriptName = env.OPENCLAW_TASK_SCRIPT_NAME?.trim() || "gateway.cmd";
    if (/[/\\]|\.\./.test(scriptName)) {
      return null;
    }
    const stateDir = resolveRecoveryPath(
      env.OPENCLAW_STATE_DIR?.trim() ||
        (homeDir && path.join(homeDir, `.openclaw${suffix ? `-${suffix}` : ""}`)),
      homeDir,
    );
    const filename = resolveRecoveryPath(
      env.OPENCLAW_TASK_SCRIPT?.trim() || (stateDir && path.join(stateDir, scriptName)),
      homeDir,
    );
    const text = readWindowsServiceScript(filename);
    command = text && windowsServiceNode(text);
  }
  // Service definitions are data. Never execute a shell, service wrapper, or manager shim.
  return command && path.isAbsolute(command) && /^node(?:\.exe)?$/i.test(path.basename(command))
    ? command
    : null;
}

function directoryNames(directory) {
  const resolved = resolveRecoveryPath(directory);
  if (!resolved) {
    return [];
  }
  try {
    return readdirSync(resolved).toSorted().slice(0, 256);
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

// Discovery uses inherited roots; dotenv must never select an executable.
function* availableNodeCandidates(homeDir, env) {
  yield [managedServiceNode(homeDir, env), "managed Gateway service"];
  const pathKey =
    process.platform === "win32"
      ? Object.keys(env).find((key) => key.toUpperCase() === "PATH") || "PATH"
      : "PATH";
  const binary = process.platform === "win32" ? "node.exe" : "node";
  for (const directory of (env[pathKey] || "").split(path.delimiter)) {
    if (path.isAbsolute(directory)) {
      yield [path.join(directory, binary), "PATH"];
    }
  }
  for (const candidate of new Set([env.NVM_DIR, homeDir && path.join(homeDir, ".nvm")])) {
    const root = resolveRecoveryPath(candidate, homeDir);
    if (root) {
      yield [resolveNvmDefault(root), "nvm default"];
    }
  }
  for (const candidate of new Set([
    env.FNM_DIR,
    homeDir && path.join(homeDir, ".fnm"),
    homeDir && path.join(homeDir, ".local", "share", "fnm"),
    ...(process.platform === "darwin" && homeDir
      ? [path.join(homeDir, "Library", "Application Support", "fnm")]
      : []),
  ])) {
    const root = resolveRecoveryPath(candidate, homeDir);
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
  for (const candidate of new Set([env.VOLTA_HOME, homeDir && path.join(homeDir, ".volta")])) {
    const root = resolveRecoveryPath(candidate, homeDir);
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

/** Select a verified runtime without respawning; callers own target admission and activation. */
export async function findUsableNodeRuntime({
  homeDir,
  allowInstall = false,
  env = process.env,
  acceptVersion,
  nodeVersion,
  installCommand,
} = {}) {
  // userInfo reads the account home without consulting the mutable process environment.
  const inheritedHome = env.HOME?.trim() || env.USERPROFILE?.trim();
  let accountHome;
  if (!inheritedHome || /^~(?=$|[\\/])/.test(inheritedHome)) {
    try {
      accountHome = os.userInfo().homedir;
    } catch {
      // Containers may have no account record; independent PATH discovery still works.
    }
  }
  const osHome = resolveRecoveryPath(inheritedHome || accountHome, accountHome, {
    allowMissing: true,
    allowCwd: true,
  });
  const recoveryHome = resolveRecoveryPath(
    homeDir ?? (env.OPENCLAW_HOME?.trim() || osHome),
    osHome,
    { allowMissing: true, allowCwd: true },
  );
  const recoveryPath = recoveryHome && path.join(recoveryHome, ".openclaw");
  const recoveryRoot =
    recoveryPath &&
    resolveRecoveryPath(recoveryPath, undefined, {
      allowMissing: true,
      trustedRoot: recoveryPath,
    });
  const { resolveUpdatedNodeRuntime } = await import("./node-runtime-update.mjs");
  let nodePath = recoveryRoot
    ? await resolveUpdatedNodeRuntime(recoveryRoot, {
        allowInstall: false,
        env,
        acceptVersion,
        installCommand,
      })
    : null;
  let reason = "cached OpenClaw runtime";
  const currentNode = realNodePath(process.execPath);
  if (!nodePath) {
    const seen = new Set([currentNode]);
    for (const [candidate, source] of availableNodeCandidates(osHome, env)) {
      // Only an explicitly named PATH directory may opt into cwd executables.
      const target = source === "PATH" ? realNodePath(candidate) : null;
      const allowCwd = Boolean(
        target && realNodePath(path.dirname(candidate)) === path.dirname(target),
      );
      const realPath = resolveRecoveryPath(candidate, undefined, { allowCwd });
      if (!realPath || seen.has(realPath)) {
        continue;
      }
      seen.add(realPath);
      if (isUsableNode(realPath, { allowCwd, env, acceptVersion })) {
        nodePath = realPath;
        reason = source;
        break;
      }
    }
  }
  if (!nodePath && allowInstall && recoveryRoot) {
    nodePath = await resolveUpdatedNodeRuntime(recoveryRoot, {
      env,
      acceptVersion,
      nodeVersion,
      installCommand,
    });
    reason = "private OpenClaw runtime";
  }
  return nodePath ? { nodePath, reason } : null;
}

/** Recover only at CLI startup, before reading config or state. */
export async function recoverNodeRuntime({
  homeDir,
  allowInstall = false,
  env = process.env,
} = {}) {
  if (
    process.versions.bun ||
    env.OPENCLAW_NODE_UPDATE_RESPAWNED === "1" ||
    !process.argv[1] ||
    isForegroundGmailRunInvocation(process.argv) ||
    (process.platform !== "win32" && isNativeHookRelayInvocation(process.argv)) ||
    !nodeRuntimeFailure(process.versions.node, detectCurrentSqliteCapabilities())
  ) {
    return false;
  }
  const selected = await findUsableNodeRuntime({ homeDir, allowInstall, env });
  const nodePath = selected?.nodePath;
  const reason = selected?.reason;
  if (!nodePath) {
    return false;
  }
  process.stderr.write(
    `openclaw: Retrying with ${JSON.stringify(nodePath)} (${reason}; current Node failed runtime admission).\n`,
  );
  runRespawnedChild(nodePath, [...process.execArgv, process.argv[1], ...process.argv.slice(2)], {
    ...env,
    OPENCLAW_NODE_UPDATE_RESPAWNED: "1",
  });
  // The original CLI must not continue while the replacement owns the invocation.
  return await new Promise(() => {});
}
