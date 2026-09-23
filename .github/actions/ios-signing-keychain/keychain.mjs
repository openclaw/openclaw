#!/usr/bin/env node

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const KEYCHAIN_ROOT_PREFIX = "openclaw-ios-signing-keychain-";
const KEYCHAIN_NAME = "signing.keychain";
const PROBE_ROOT_PREFIX = "openclaw-ios-codesign-probe-";
const KEYCHAIN_LIFETIME_SECONDS = 10_800;
const FASTLANE_TIMEOUT_MS = 60_000;
const IDENTITY_TIMEOUT_MS = 15_000;
const CODESIGN_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

function requiredEnvironment(env, name) {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function assertSingleLine(name, value) {
  if (/[\r\n]/u.test(value)) {
    throw new Error(`${name} must be a single line`);
  }
}

function isStrictDescendant(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== "..";
}

function assertStrictDescendant(parent, candidate, label) {
  if (!isStrictDescendant(parent, candidate)) {
    throw new Error(`${label} must stay inside ${parent}`);
  }
}

function appendCommandValue(file, name, value, appendFile = fs.appendFileSync) {
  assertSingleLine(name, value);
  appendFile(file, `${name}=${value}\n`, "utf8");
}

function maskSecret(secret, output = process.stdout) {
  const escaped = secret.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  output.write(`::add-mask::${escaped}\n`);
}

function existingOwnedKeychain(root, candidate) {
  if (!fs.existsSync(candidate)) {
    return undefined;
  }
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Owned keychain path is not a regular file: ${candidate}`);
  }
  const resolved = fs.realpathSync(candidate);
  assertStrictDescendant(root, resolved, "Owned keychain");
  return resolved;
}

function validateOwnedRoot(runnerTemp, ownedRoot, requireExisting) {
  const resolvedRunnerTemp = fs.realpathSync(runnerTemp);
  const absoluteRoot = path.resolve(ownedRoot);
  assertStrictDescendant(resolvedRunnerTemp, absoluteRoot, "Owned keychain root");
  if (!path.basename(absoluteRoot).startsWith(KEYCHAIN_ROOT_PREFIX)) {
    throw new Error(`Unexpected owned keychain root: ${absoluteRoot}`);
  }
  if (!fs.existsSync(absoluteRoot)) {
    if (requireExisting) {
      throw new Error(`Owned keychain root is missing: ${absoluteRoot}`);
    }
    return absoluteRoot;
  }
  const stat = fs.lstatSync(absoluteRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Owned keychain root is not a directory: ${absoluteRoot}`);
  }
  const resolvedRoot = fs.realpathSync(absoluteRoot);
  assertStrictDescendant(resolvedRunnerTemp, resolvedRoot, "Owned keychain root");
  if (resolvedRoot !== absoluteRoot) {
    throw new Error(`Owned keychain root changed identity: ${absoluteRoot}`);
  }
  return resolvedRoot;
}

function validateOwnedKeychain(root, requestedPath, candidate, requireExisting) {
  const expectedPaths = new Set([requestedPath, `${requestedPath}-db`]);
  const absoluteCandidate = path.resolve(candidate);
  if (!expectedPaths.has(absoluteCandidate)) {
    throw new Error(`Unexpected owned keychain path: ${absoluteCandidate}`);
  }
  assertStrictDescendant(root, absoluteCandidate, "Owned keychain");
  const resolved = existingOwnedKeychain(root, absoluteCandidate);
  if (requireExisting && !resolved) {
    throw new Error(`Owned keychain is missing: ${absoluteCandidate}`);
  }
  return resolved ?? absoluteCandidate;
}

function fastlaneCommand(action, parameters) {
  return [
    "_2.6.9_",
    "exec",
    "fastlane",
    "run",
    action,
    ...Object.entries(parameters).map(([name, value]) => `${name}:${value}`),
  ];
}

export async function runBounded(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const terminateGraceMs = options.terminateGraceMs ?? 2_000;
  const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  const ownsProcessGroup = process.platform !== "win32";
  const child = spawn(command, args, {
    cwd: options.cwd,
    detached: ownsProcessGroup,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  let outputBytes = 0;
  let terminationReason;
  let terminationStartedAt;
  let terminationError;
  let closed = false;
  let forceKillTimer;

  const signalOwnedProcess = (signal) => {
    try {
      if (ownsProcessGroup && child.pid) {
        process.kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") {
        return false;
      }
      terminationError ??= error;
      return false;
    }
  };
  const ownedProcessGroupExists = () => {
    if (!ownsProcessGroup || !child.pid) {
      return false;
    }
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") {
        return false;
      }
      throw error;
    }
  };
  const terminate = (reason) => {
    if (closed || terminationReason) {
      return;
    }
    terminationReason = reason;
    terminationStartedAt = Date.now();
    signalOwnedProcess("SIGTERM");
    forceKillTimer = setTimeout(() => {
      if (!closed || ownedProcessGroupExists()) {
        signalOwnedProcess("SIGKILL");
      }
    }, terminateGraceMs);
    forceKillTimer.unref();
  };
  const capture = (target, chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > maxOutputBytes) {
      terminate(`exceeded the ${maxOutputBytes}-byte output limit`);
      return;
    }
    target.push(chunk);
  };

  child.stdout.on("data", (chunk) => capture(stdout, chunk));
  child.stderr.on("data", (chunk) => capture(stderr, chunk));
  const timeout = setTimeout(() => terminate(`timed out after ${timeoutMs}ms`), timeoutMs);
  timeout.unref();

  try {
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        closed = true;
        resolve({ code, signal });
      });
    });
    const stdoutText = Buffer.concat(stdout).toString("utf8");
    const stderrText = Buffer.concat(stderr).toString("utf8");
    if (terminationReason && ownsProcessGroup && child.pid) {
      const graceRemaining = Math.max(
        0,
        (terminationStartedAt ?? Date.now()) + terminateGraceMs - Date.now(),
      );
      if (graceRemaining > 0) {
        await new Promise((resolve) => {
          setTimeout(resolve, graceRemaining);
        });
      }
      if (ownedProcessGroupExists()) {
        signalOwnedProcess("SIGKILL");
        const joinDeadline = Date.now() + 2_000;
        while (ownedProcessGroupExists() && Date.now() < joinDeadline) {
          await new Promise((resolve) => {
            setTimeout(resolve, 10);
          });
        }
        if (ownedProcessGroupExists()) {
          throw new Error(`${command} owned process group did not terminate`);
        }
      }
    }
    if (terminationError) {
      throw terminationError;
    }
    if (terminationReason) {
      throw new Error(`${command} ${terminationReason}`);
    }
    if (result.code !== 0) {
      const detail =
        stderrText.trim() || stdoutText.trim() || `signal ${result.signal ?? "unknown"}`;
      throw new Error(`${command} exited with ${result.code}: ${detail}`);
    }
    return { stderr: stderrText, stdout: stdoutText };
  } finally {
    clearTimeout(timeout);
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
    }
  }
}

export async function createOwnedKeychain(options = {}) {
  const env = options.env ?? process.env;
  const runCommand = options.runCommand ?? runBounded;
  const appendFile = options.appendFile ?? fs.appendFileSync;
  const output = options.output ?? process.stdout;
  const runnerTemp = fs.realpathSync(requiredEnvironment(env, "RUNNER_TEMP"));
  const workspace = fs.realpathSync(requiredEnvironment(env, "GITHUB_WORKSPACE"));
  const stateFile = requiredEnvironment(env, "GITHUB_STATE");
  const environmentFile = requiredEnvironment(env, "GITHUB_ENV");
  const ownedRoot = fs.mkdtempSync(path.join(runnerTemp, KEYCHAIN_ROOT_PREFIX));
  fs.chmodSync(ownedRoot, 0o700);
  const requestedPath = path.join(ownedRoot, KEYCHAIN_NAME);

  // State is registered before creation so the post action owns partial failures too.
  appendCommandValue(stateFile, "owned_root", ownedRoot, appendFile);
  appendCommandValue(stateFile, "requested_path", requestedPath, appendFile);

  const password = crypto.randomBytes(32).toString("hex");
  maskSecret(password, output);
  await runCommand(
    "bundle",
    fastlaneCommand("create_keychain", {
      add_to_search_list: true,
      default_keychain: false,
      lock_after_timeout: true,
      lock_when_sleeps: false,
      path: requestedPath,
      require_create: true,
      timeout: KEYCHAIN_LIFETIME_SECONDS,
      unlock: true,
    }),
    {
      cwd: path.join(workspace, "apps/ios"),
      env: { ...env, KEYCHAIN_PASSWORD: password },
      timeoutMs: FASTLANE_TIMEOUT_MS,
    },
  );

  const created = [requestedPath, `${requestedPath}-db`]
    .map((candidate) => existingOwnedKeychain(ownedRoot, candidate))
    .filter(Boolean);
  if (created.length !== 1) {
    throw new Error(`Expected one job-owned keychain, found ${created.length}`);
  }
  const resolvedPath = created[0];

  appendCommandValue(stateFile, "resolved_path", resolvedPath, appendFile);
  appendCommandValue(environmentFile, "MATCH_KEYCHAIN_NAME", resolvedPath, appendFile);
  appendCommandValue(environmentFile, "MATCH_KEYCHAIN_PASSWORD", password, appendFile);
  return { ownedRoot, password, requestedPath, resolvedPath };
}

export async function cleanupOwnedKeychain(options = {}) {
  const env = options.env ?? process.env;
  const runCommand = options.runCommand ?? runBounded;
  const ownedRoot = env.STATE_owned_root?.trim();
  if (!ownedRoot) {
    return { removed: false };
  }
  const runnerTemp = requiredEnvironment(env, "RUNNER_TEMP");
  const workspace = fs.realpathSync(requiredEnvironment(env, "GITHUB_WORKSPACE"));
  const root = validateOwnedRoot(runnerTemp, ownedRoot, false);
  if (!fs.existsSync(root)) {
    return { removed: false };
  }
  const expectedRequestedPath = path.join(root, KEYCHAIN_NAME);
  const requestedPath = path.resolve(requiredEnvironment(env, "STATE_requested_path"));
  if (requestedPath !== expectedRequestedPath) {
    throw new Error(`Unexpected requested keychain path: ${requestedPath}`);
  }

  const candidates = env.STATE_resolved_path?.trim()
    ? [validateOwnedKeychain(root, requestedPath, env.STATE_resolved_path, false)]
    : [requestedPath, `${requestedPath}-db`];
  const existing = candidates
    .map((candidate) => existingOwnedKeychain(root, candidate))
    .filter(Boolean);
  if (existing.length > 1) {
    throw new Error(`Refusing ambiguous job-owned keychain cleanup in ${root}`);
  }
  if (existing.length === 1) {
    const keychainPath = existing[0];
    await runCommand(
      "bundle",
      fastlaneCommand("delete_keychain", { keychain_path: keychainPath }),
      {
        cwd: path.join(workspace, "apps/ios"),
        env,
        timeoutMs: FASTLANE_TIMEOUT_MS,
      },
    );
    if (fs.existsSync(keychainPath)) {
      throw new Error(`Job-owned keychain still exists after cleanup: ${keychainPath}`);
    }
  }
  fs.rmdirSync(root);
  return { removed: existing.length === 1 };
}

function expectedTeamId(workspace) {
  const signingConfig = JSON.parse(
    fs.readFileSync(path.join(workspace, "apps/ios/Config/AppStoreSigning.json"), "utf8"),
  );
  const teamId = signingConfig.teamId;
  if (typeof teamId !== "string" || !/^[A-Z0-9]{10}$/u.test(teamId)) {
    throw new Error("AppStoreSigning.json has an invalid teamId");
  }
  return teamId;
}

function selectDistributionIdentity(source, teamId) {
  const identities = source
    .split(/\r?\n/u)
    .map((line) => line.match(/^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"([^"]+)"\s*$/u))
    .filter(Boolean)
    .map((match) => ({ hash: match[1], name: match[2] }))
    .filter(
      (identity) =>
        identity.name.startsWith("Apple Distribution:") && identity.name.endsWith(`(${teamId})`),
    );
  if (identities.length !== 1) {
    throw new Error(
      `Expected one Apple Distribution identity for team ${teamId}, found ${identities.length}`,
    );
  }
  return identities[0];
}

export async function probeOwnedKeychain(options = {}) {
  const env = options.env ?? process.env;
  const runCommand = options.runCommand ?? runBounded;
  const runnerTemp = fs.realpathSync(requiredEnvironment(env, "RUNNER_TEMP"));
  const workspace = fs.realpathSync(requiredEnvironment(env, "GITHUB_WORKSPACE"));
  const keychainPath = path.resolve(requiredEnvironment(env, "MATCH_KEYCHAIN_NAME"));
  const ownedRoot = validateOwnedRoot(runnerTemp, path.dirname(keychainPath), true);
  const requestedPath = path.join(ownedRoot, KEYCHAIN_NAME);
  const resolvedKeychain = validateOwnedKeychain(ownedRoot, requestedPath, keychainPath, true);

  const teamId = expectedTeamId(workspace);
  const identityResult = await runCommand(
    "/usr/bin/security",
    ["find-identity", "-v", "-p", "codesigning", resolvedKeychain],
    { env, timeoutMs: IDENTITY_TIMEOUT_MS },
  );
  const identity = selectDistributionIdentity(
    `${identityResult.stdout}\n${identityResult.stderr}`,
    teamId,
  );
  const probeRoot = fs.mkdtempSync(path.join(runnerTemp, PROBE_ROOT_PREFIX));
  fs.chmodSync(probeRoot, 0o700);
  const probePath = path.join(probeRoot, "true");

  try {
    fs.copyFileSync("/usr/bin/true", probePath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(probePath, 0o700);
    await runCommand(
      "/usr/bin/codesign",
      [
        "--force",
        "--sign",
        identity.hash,
        "--timestamp=none",
        "--keychain",
        resolvedKeychain,
        probePath,
      ],
      { env, timeoutMs: CODESIGN_TIMEOUT_MS },
    );
    await runCommand("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", probePath], {
      env,
      timeoutMs: CODESIGN_TIMEOUT_MS,
    });
    const details = await runCommand("/usr/bin/codesign", ["--display", "--verbose=4", probePath], {
      env,
      timeoutMs: IDENTITY_TIMEOUT_MS,
    });
    if (
      !`${details.stdout}\n${details.stderr}`.split(/\r?\n/u).includes(`TeamIdentifier=${teamId}`)
    ) {
      throw new Error(`Signed probe does not belong to expected team ${teamId}`);
    }
    return { identity: identity.name, teamId };
  } finally {
    fs.rmSync(probeRoot, { force: true, recursive: true });
  }
}

async function main() {
  if (process.argv[2] === "probe") {
    await probeOwnedKeychain();
    return;
  }
  if (process.argv.length > 2) {
    throw new Error(`Unknown iOS signing keychain operation: ${process.argv[2]}`);
  }
  await createOwnedKeychain();
}

const isDirectRun =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
