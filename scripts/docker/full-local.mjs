#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import fsPromises from "node:fs/promises";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspectPathPermissions, safeStat } from "@openclaw/fs-safe/permissions";
import { readSecureFile } from "@openclaw/fs-safe/secure-file";
import JSON5 from "json5";

const require = createRequire(import.meta.url);
const { normalizeAgentOsArtifactContract } = require("../lib/agent-os-contracts.cjs");

export const FULL_LOCAL_SERVICES = [
  "openclaw-gateway",
  "openclaw-sentinel",
  "openclaw-signal-hub",
  "openclaw-obsidian-syncer",
];
export const FULL_LOCAL_START_SERVICES = [...FULL_LOCAL_SERVICES, "openclaw-cli"];
export const FULL_LOCAL_MOUNT_REPAIR_SERVICES = ["openclaw-gateway"];

export const FULL_LOCAL_COMPOSE_FILES = ["docker-compose.yml", "docker-compose.sidecars.yml"];
export const FULL_LOCAL_PROFILE = "local-sidecars";

const DEFAULT_GATEWAY_PORT = 18789;
const DEFAULT_SENTINEL_PORT = 18888;
export const DEFAULT_READY_TIMEOUT_MS = 300_000;
export const DEFAULT_SMOKE_TIMEOUT_MS = 240_000;
const DEFAULT_GOLDEN_E2E_TIMEOUT_MS = 600_000;
const DEFAULT_PROOF_PATH = path.join(".artifacts", "full-local-proof.json");
const DEFAULT_SENTINEL_PROOF_PATH = path.join(".artifacts", "full-local-sentinel-proof.json");
const DEFAULT_MEMORY_PROOF_PATH = path.join(".artifacts", "full-local-memory-proof.json");
const DEFAULT_BENCHMARK_PATH = path.join(".artifacts", "full-local-benchmark.json");
const DEFAULT_SMOKE_PATH = path.join(".artifacts", "full-local-autonomy-smoke.json");
const DEFAULT_GOLDEN_E2E_PATH = path.join(".artifacts", "full-local-agent-os-golden-e2e.json");
const DEFAULT_MEMORY_WIKI_GATEWAY_TIMEOUT_MS = 300_000;
const DEFAULT_SENTINEL_MODEL = "nvidia/meta/llama-3.1-8b-instruct";
const DEFAULT_SENTINEL_PROMPT = "Reply exactly: sentinel-smoke-ok";
const DEFAULT_SMOKE_AGENT = "main";
const DEFAULT_FULL_LOCAL_BLACKBOARD_JOURNAL_MODE = "DELETE";
const DEFAULT_FULL_LOCAL_BLACKBOARD_BUSY_TIMEOUT_MS = 10_000;
const BLACKBOARD_CLI_CONTAINER_PATH = "/app/scripts/docker/sidecars/blackboard-cli.cjs";
const NODE_MCP_LAUNCHER_CONTAINER_PATH = "/app/scripts/docker/sidecars/node-mcp-launcher.cjs";
const PYTHON_MCP_LAUNCHER_CONTAINER_PATH = "/app/scripts/docker/sidecars/python-mcp-launcher.cjs";
const SENTINEL_PUBLISH_PROBE_HOSTS = ["0.0.0.0", "127.0.0.1"];
const FULL_LOCAL_SMOKE_CREATED_BY = "scripts/docker/full-local.mjs";
const FULL_LOCAL_SMOKE_NONCE_PREFIX = "full-local-smoke-";
const FULL_LOCAL_GOLDEN_E2E_RUN_ID_PREFIX = "full-local-golden-e2e-";
const FULL_LOCAL_STALE_SMOKE_STATUSES = new Set(["OPEN", "CLAIMED", "IN_PROGRESS"]);
const CONTAINER_OPENCLAW_DIR = "/home/node/.openclaw";
const CONTAINER_WORKSPACE_DIR = `${CONTAINER_OPENCLAW_DIR}/workspace`;
const CONTAINER_CUSTOM_SWARM_DIR = "/home/node/custom-swarm";
const CONTAINER_CONFIG_SOURCE_DIR = "/home/node/openclaw-source-config";
const CONTAINER_EXTRA_AGENT_ROOT_DIR = "/home/node/openclaw-extra-agent-root";
const EXTRA_AGENT_ROOT_CONTAINER_DIRS = [
  CONTAINER_EXTRA_AGENT_ROOT_DIR,
  "/home/node/openclaw-extra-agent-root-2",
  "/home/node/openclaw-extra-agent-root-3",
  "/home/node/openclaw-extra-agent-root-4",
  "/home/node/openclaw-extra-agent-root-5",
  "/home/node/openclaw-extra-agent-root-6",
  "/home/node/openclaw-extra-agent-root-7",
  "/home/node/openclaw-extra-agent-root-8",
];
const DEFAULT_CONTAINER_CONFIG_PATH = `${CONTAINER_OPENCLAW_DIR}/full-local/openclaw.json`;
const DEFAULT_FULL_LOCAL_PATH_MAP = `${CONTAINER_OPENCLAW_DIR}/full-local/path-map.json`;
const CONTAINER_NVIDIA_VAULT_PATH = "/home/node/.openclaw/workspace_nvidia_key_sentinel/vault.json";
const CONTAINER_PYTHON_BIN = "/usr/bin/python3";
const CONTAINER_AGENT_VENV_ROOT = `${CONTAINER_OPENCLAW_DIR}/python-venvs`;
const CONTAINER_PATH_DELIMITER = ":";
const INCLUDE_KEY = "$include";
const MAX_INCLUDE_DEPTH = 10;
const DEFAULT_SECRET_PROVIDER_ALIAS = "default";
const SINGLE_VALUE_FILE_REF_ID = "value";
const LEGACY_SECRETREF_ENV_MARKER_PREFIX = "secretref-env:";
const LEGACY_DOUBLE_UNDERSCORE_ENV_MARKER_PREFIX = "__env__:";
const ENV_SECRET_REF_ID_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
const ENV_SECRET_TEMPLATE_RE = /^\$\{([A-Z][A-Z0-9_]{0,127})\}$/;
const ENV_SECRET_SHORTHAND_RE = /^\$([A-Z][A-Z0-9_]{0,127})$/;
const EXEC_SECRET_REF_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const DEFAULT_FILE_MAX_BYTES = 1024 * 1024;
const DEFAULT_FILE_TIMEOUT_MS = 5_000;
const DEFAULT_EXEC_TIMEOUT_MS = 5_000;
const DEFAULT_EXEC_MAX_OUTPUT_BYTES = 1024 * 1024;
const WINDOWS_ABS_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\[^\\]+\\[^\\]+/;
const DEFAULT_NATIVE_AGENT_IDS = ["uba_god_mode", "pipeline_guardian"];
const HOST_NATIVE_MARKERS = new Set([
  "desktop",
  "desktop-native",
  "host",
  "host-native",
  "native",
  "windows",
  "windows-native",
]);
const BLOCKED_STDIO_MCP_ENV_KEYS = new Set([
  "BASH_ENV",
  "ENV",
  "LD_AUDIT",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "PYTHONHOME",
  "PYTHONPATH",
  "RUBYOPT",
  "SHELLOPTS",
]);
const BLACKBOARD_JOURNAL_MODES = new Set(["DELETE", "TRUNCATE", "PERSIST", "WAL"]);

function cleanString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseNvidiaPoolKeys(value) {
  const raw = cleanString(value);
  if (!raw) {
    return [];
  }
  const keys = [];
  const seen = new Set();
  for (const entry of raw.split(/[,\r\n]+/u)) {
    const key = entry.trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

function buildNvidiaPoolValue(...values) {
  const keys = [];
  const seen = new Set();
  for (const value of values) {
    for (const key of parseNvidiaPoolKeys(value)) {
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      keys.push(key);
    }
  }
  return keys.length > 0 ? keys.join(",") : null;
}

function readNvidiaVaultKeys(vaultPath) {
  if (!existsSync(vaultPath)) {
    return [];
  }
  const data = JSON.parse(readFileSync(vaultPath, "utf8"));
  if (!Array.isArray(data?.keys)) {
    return [];
  }
  return data.keys.filter((key) => typeof key === "string" && key.trim().length > 0);
}

function readNvidiaVaultKeyCount(vaultPath) {
  try {
    return readNvidiaVaultKeys(vaultPath).length;
  } catch {
    return 0;
  }
}

export function seedNvidiaVaultFromRuntime(runtime) {
  const vaultPath = cleanString(runtime?.facts?.nvidiaVaultPathHost);
  if (!vaultPath) {
    return { keyCount: 0, reason: "missing-vault-path", seeded: false };
  }

  const env = runtime.env ?? {};
  const seedKeys = parseNvidiaPoolKeys(
    buildNvidiaPoolValue(
      env.NVIDIA_API_KEYS,
      env.NVIDIA_API_KEY,
      env.OPENCLAW_NVIDIA_API_KEY,
      env.OPENCLAW_SIGNAL_HUB_NVIDIA_API_KEYS,
    ),
  );
  const force =
    asBoolean(env.OPENCLAW_FULL_LOCAL_RESEED_NVIDIA_VAULT) ||
    asBoolean(env.OPENCLAW_SENTINEL_RESEED_NVIDIA_VAULT);
  const markerPath = `${vaultPath}.seeded-by-full-local`;
  let existingKeys = [];
  let malformedVault = false;
  if (!force) {
    try {
      existingKeys = readNvidiaVaultKeys(vaultPath);
    } catch {
      malformedVault = true;
    }
  }

  if (!force && existingKeys.length > 0) {
    return { keyCount: existingKeys.length, markerPath, reason: "vault-has-keys", seeded: false };
  }
  if (!force && !malformedVault && existsSync(markerPath)) {
    return { keyCount: existingKeys.length, markerPath, reason: "already-seeded", seeded: false };
  }
  if (seedKeys.length === 0) {
    return {
      keyCount: existingKeys.length,
      markerPath,
      reason: malformedVault ? "malformed-vault" : "no-seed-keys",
      seeded: false,
    };
  }

  mkdirSync(path.dirname(vaultPath), { recursive: true });
  const now = new Date().toISOString();
  const vaultTmp = `${vaultPath}.full-local.tmp`;
  writeFileSync(
    vaultTmp,
    JSON.stringify({ keys: seedKeys, updatedAt: now, version: "1.0" }, null, 2),
  );
  renameSync(vaultTmp, vaultPath);
  writeFileSync(
    markerPath,
    JSON.stringify({ keyCount: seedKeys.length, seededAt: now, source: "full-local" }, null, 2),
  );
  return {
    keyCount: seedKeys.length,
    markerPath,
    reason: force ? "forced" : malformedVault ? "repaired-malformed-vault" : "seeded",
    seeded: true,
  };
}

function asBoolean(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
}

function normalizeBlackboardJournalMode(value) {
  const mode = cleanString(value)?.toUpperCase() ?? DEFAULT_FULL_LOCAL_BLACKBOARD_JOURNAL_MODE;
  return BLACKBOARD_JOURNAL_MODES.has(mode) ? mode : DEFAULT_FULL_LOCAL_BLACKBOARD_JOURNAL_MODE;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseTcpPortString(value, label) {
  const raw = cleanString(value);
  if (!raw) {
    return null;
  }
  if (!/^\d+$/u.test(raw)) {
    throw new Error(`${label} must be a TCP port number from 1 to 65535. Received: ${raw}`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${label} must be a TCP port number from 1 to 65535. Received: ${raw}`);
  }
  return String(parsed);
}

function parseJsonStringArrayEnv(value, label) {
  const raw = cleanString(value);
  if (!raw) {
    return [];
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be a JSON array of strings.`);
  }
  return parsed;
}

export function resolveRepoRoot(scriptUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(scriptUrl)), "..", "..");
}

function resolveUserPath(input, cwd, homeDir) {
  const value = cleanString(input);
  if (!value) {
    return null;
  }
  if (value === "~") {
    return homeDir;
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.resolve(homeDir, value.slice(2));
  }
  return path.resolve(cwd, value);
}

export function resolveOpenClawConfigPath(
  env = process.env,
  homeDir = os.homedir(),
  cwd = process.cwd(),
) {
  const explicitConfigPath = resolveUserPath(env.OPENCLAW_CONFIG_PATH, cwd, homeDir);
  if (explicitConfigPath) {
    return explicitConfigPath;
  }

  const openclawHome = resolveUserPath(env.OPENCLAW_HOME, cwd, homeDir) ?? homeDir;
  const stateDir = resolveUserPath(env.OPENCLAW_STATE_DIR, cwd, homeDir);
  const configDir =
    resolveUserPath(env.OPENCLAW_CONFIG_DIR, cwd, homeDir) ??
    stateDir ??
    path.join(openclawHome, ".openclaw");
  return path.join(configDir, "openclaw.json");
}

function isPlainObject(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
  );
}

function secretRefKey(ref) {
  return `${ref.source}:${ref.provider}:${ref.id}`;
}

function isValidSecretSource(value) {
  return value === "env" || value === "file" || value === "exec";
}

function defaultSecretProviderAlias(config, source) {
  const configured =
    source === "env"
      ? config?.secrets?.defaults?.env
      : source === "file"
        ? config?.secrets?.defaults?.file
        : config?.secrets?.defaults?.exec;
  return cleanString(configured) ?? DEFAULT_SECRET_PROVIDER_ALIAS;
}

function normalizeSecretRef(value, config) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    const legacyPrefix = trimmed.startsWith(LEGACY_SECRETREF_ENV_MARKER_PREFIX)
      ? LEGACY_SECRETREF_ENV_MARKER_PREFIX
      : trimmed.startsWith(LEGACY_DOUBLE_UNDERSCORE_ENV_MARKER_PREFIX)
        ? LEGACY_DOUBLE_UNDERSCORE_ENV_MARKER_PREFIX
        : null;
    if (legacyPrefix) {
      const id = trimmed.slice(legacyPrefix.length);
      return ENV_SECRET_REF_ID_RE.test(id)
        ? {
            source: "env",
            provider: defaultSecretProviderAlias(config, "env"),
            id,
          }
        : null;
    }

    const envTemplate =
      ENV_SECRET_TEMPLATE_RE.exec(trimmed) ?? ENV_SECRET_SHORTHAND_RE.exec(trimmed);
    return envTemplate
      ? {
          source: "env",
          provider: defaultSecretProviderAlias(config, "env"),
          id: envTemplate[1],
        }
      : null;
  }

  if (!isPlainObject(value)) {
    return null;
  }
  if (!isValidSecretSource(value.source) || !cleanString(value.id)) {
    return null;
  }
  const provider = cleanString(value.provider) ?? defaultSecretProviderAlias(config, value.source);
  return provider ? { source: value.source, provider, id: value.id.trim() } : null;
}

function resolveSecretProviderConfig(config, ref) {
  const providerConfig = config?.secrets?.providers?.[ref.provider];
  if (!providerConfig) {
    if (ref.source === "env" && ref.provider === defaultSecretProviderAlias(config, "env")) {
      return { source: "env" };
    }
    throw new Error(
      `Secret provider "${ref.provider}" is not configured for ${secretRefKey(ref)}.`,
    );
  }
  if (providerConfig.source !== ref.source) {
    throw new Error(
      `Secret provider "${ref.provider}" has source "${String(providerConfig.source)}" but ${secretRefKey(ref)} requests "${ref.source}".`,
    );
  }
  return providerConfig;
}

function readJsonPointerLocal(payload, pointer) {
  if (pointer === "") {
    return payload;
  }
  if (typeof pointer !== "string" || !pointer.startsWith("/")) {
    throw new Error(`File SecretRef id must be a JSON pointer or "${SINGLE_VALUE_FILE_REF_ID}".`);
  }

  let current = payload;
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (current === null || typeof current !== "object" || !(segment in current)) {
      throw new Error(`JSON pointer "${pointer}" did not resolve.`);
    }
    current = current[segment];
  }
  return current;
}

function resolveEnvSecretRef(ref, providerConfig, env) {
  if (Array.isArray(providerConfig.allowlist) && !providerConfig.allowlist.includes(ref.id)) {
    throw new Error(`Environment variable "${ref.id}" is not allowlisted.`);
  }
  const value = cleanString(env[ref.id]);
  if (!value) {
    throw new Error(`Environment variable "${ref.id}" is missing or empty.`);
  }
  return value;
}

function isAbsolutePathname(value) {
  return (
    path.isAbsolute(value) ||
    WINDOWS_ABS_PATH_PATTERN.test(value) ||
    WINDOWS_UNC_PATH_PATTERN.test(value)
  );
}

async function readFileStatOrThrow(pathname, label) {
  const stat = await safeStat(pathname);
  if (!stat.ok) {
    throw new Error(`${label} is not readable: ${pathname}`);
  }
  if (stat.isDir) {
    throw new Error(`${label} must be a file: ${pathname}`);
  }
  return stat;
}

async function assertSecureSecretPath(params) {
  if (!isAbsolutePathname(params.targetPath)) {
    throw new Error(`${params.label} must be an absolute path.`);
  }

  let effectivePath = params.targetPath;
  let stat = await readFileStatOrThrow(effectivePath, params.label);
  if (stat.isSymlink) {
    if (!params.allowSymlinkPath) {
      throw new Error(`${params.label} must not be a symlink: ${effectivePath}`);
    }
    try {
      effectivePath = await fsPromises.realpath(effectivePath);
    } catch {
      throw new Error(`${params.label} symlink target is not readable: ${params.targetPath}`);
    }
    if (!isAbsolutePathname(effectivePath)) {
      throw new Error(`${params.label} resolved symlink target must be an absolute path.`);
    }
    stat = await readFileStatOrThrow(effectivePath, params.label);
    if (stat.isSymlink) {
      throw new Error(`${params.label} symlink target must not be a symlink: ${effectivePath}`);
    }
  }

  if (params.trustedDirs && params.trustedDirs.length > 0) {
    const trusted = params.trustedDirs.map((entry) =>
      resolveUserPath(entry, params.cwd, params.homeDir),
    );
    const inTrustedDir = trusted.some((dir) => dir && isPathInside(dir, effectivePath));
    if (!inTrustedDir) {
      throw new Error(`${params.label} is outside trustedDirs: ${effectivePath}`);
    }
  }
  if (params.allowInsecurePath) {
    return effectivePath;
  }

  const perms = await inspectPathPermissions(effectivePath);
  if (!perms.ok) {
    throw new Error(`${params.label} permissions could not be verified: ${effectivePath}`);
  }
  const writableByOthers = perms.worldWritable || perms.groupWritable;
  const readableByOthers = perms.worldReadable || perms.groupReadable;
  if (writableByOthers || (!params.allowReadableByOthers && readableByOthers)) {
    throw new Error(`${params.label} permissions are too open: ${effectivePath}`);
  }
  if (process.platform === "win32" && perms.source === "unknown") {
    throw new Error(
      `${params.label} ACL verification unavailable on Windows for ${effectivePath}. Set allowInsecurePath=true for this provider to bypass this check when the path is trusted.`,
    );
  }
  if (process.platform !== "win32" && typeof process.getuid === "function" && stat.uid != null) {
    const uid = process.getuid();
    if (stat.uid !== uid) {
      throw new Error(
        `${params.label} must be owned by the current user (uid=${uid}): ${effectivePath}`,
      );
    }
  }
  return effectivePath;
}

async function resolveFileSecretRef(ref, providerConfig, cwd, homeDir) {
  const providerPath = cleanString(providerConfig.path);
  if (!providerPath) {
    throw new Error(`File secret provider "${ref.provider}" is missing path.`);
  }
  const filePath = resolveUserPath(providerPath, cwd, homeDir);
  const maxBytes = parsePositiveInteger(providerConfig.maxBytes, DEFAULT_FILE_MAX_BYTES);
  const timeoutMs = parsePositiveInteger(providerConfig.timeoutMs, DEFAULT_FILE_TIMEOUT_MS);
  const { buffer: raw } = await readSecureFile({
    filePath,
    label: `secrets.providers.${ref.provider}.path`,
    io: { maxBytes, timeoutMs },
    permissions: { allowInsecure: providerConfig.allowInsecurePath },
  });
  const text = raw.toString("utf8").replace(/^\uFEFF/, "");
  if (providerConfig.mode === "singleValue") {
    if (ref.id !== SINGLE_VALUE_FILE_REF_ID) {
      throw new Error(
        `singleValue file provider "${ref.provider}" expects ref id "${SINGLE_VALUE_FILE_REF_ID}".`,
      );
    }
    return text.replace(/\r?\n$/, "");
  }

  const payload = JSON.parse(text);
  return readJsonPointerLocal(payload, ref.id);
}

function parseExecSecretValues(providerName, ids, stdout, jsonOnly) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(`Exec provider "${providerName}" returned empty stdout.`);
  }

  let parsed;
  if (!jsonOnly && ids.length === 1) {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { [ids[0]]: trimmed };
    }
  } else {
    parsed = JSON.parse(trimmed);
  }

  if (!isPlainObject(parsed)) {
    if (!jsonOnly && ids.length === 1 && typeof parsed === "string") {
      return { [ids[0]]: parsed };
    }
    throw new Error(`Exec provider "${providerName}" response must be an object.`);
  }
  if (parsed.protocolVersion !== 1 || !isPlainObject(parsed.values)) {
    throw new Error(
      `Exec provider "${providerName}" response must include protocolVersion 1 and values.`,
    );
  }

  const errors = isPlainObject(parsed.errors) ? parsed.errors : {};
  const values = {};
  for (const id of ids) {
    if (id in errors) {
      const entry = errors[id];
      const message =
        isPlainObject(entry) && cleanString(entry.message) ? ` (${entry.message.trim()})` : "";
      throw new Error(`Exec provider "${providerName}" failed for id "${id}"${message}.`);
    }
    if (!(id in parsed.values)) {
      throw new Error(`Exec provider "${providerName}" response missing id "${id}".`);
    }
    values[id] = parsed.values[id];
  }
  return values;
}

async function resolveExecSecretRef(ref, providerConfig, env, cwd, homeDir) {
  if (
    !EXEC_SECRET_REF_ID_RE.test(ref.id) ||
    ref.id.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error(`Exec SecretRef id "${ref.id}" is invalid.`);
  }
  if (!cleanString(providerConfig.command)) {
    throw new Error(`Exec secret provider "${ref.provider}" is missing command.`);
  }
  const commandPath = resolveUserPath(providerConfig.command, cwd, homeDir);
  const secureCommandPath = await assertSecureSecretPath({
    targetPath: commandPath,
    label: `secrets.providers.${ref.provider}.command`,
    trustedDirs: providerConfig.trustedDirs,
    allowInsecurePath: providerConfig.allowInsecurePath,
    allowReadableByOthers: true,
    allowSymlinkPath: providerConfig.allowSymlinkCommand,
    cwd,
    homeDir,
  });
  const childEnv = {};
  for (const key of providerConfig.passEnv ?? []) {
    if (env[key] !== undefined) {
      childEnv[key] = env[key];
    }
  }
  for (const [key, value] of Object.entries(providerConfig.env ?? {})) {
    childEnv[key] = String(value);
  }

  const timeoutMs = parsePositiveInteger(providerConfig.timeoutMs, DEFAULT_EXEC_TIMEOUT_MS);
  const maxOutputBytes = parsePositiveInteger(
    providerConfig.maxOutputBytes,
    DEFAULT_EXEC_MAX_OUTPUT_BYTES,
  );
  const input = JSON.stringify({
    protocolVersion: 1,
    provider: ref.provider,
    ids: [ref.id],
  });
  const result = spawnSync(secureCommandPath, providerConfig.args ?? [], {
    cwd: path.dirname(secureCommandPath),
    encoding: "utf8",
    env: childEnv,
    input,
    maxBuffer: maxOutputBytes,
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Exec provider "${ref.provider}" exited with code ${String(result.status)}.`);
  }
  const parsed = parseExecSecretValues(
    ref.provider,
    [ref.id],
    result.stdout,
    providerConfig.jsonOnly ?? true,
  );
  return parsed[ref.id];
}

async function resolveSecretRefStringForFullLocal(ref, params) {
  const providerConfig = resolveSecretProviderConfig(params.config, ref);
  const value =
    providerConfig.source === "env"
      ? resolveEnvSecretRef(ref, providerConfig, params.env)
      : providerConfig.source === "file"
        ? await resolveFileSecretRef(ref, providerConfig, params.cwd, params.homeDir)
        : await resolveExecSecretRef(ref, providerConfig, params.env, params.cwd, params.homeDir);
  const resolved = cleanString(value);
  if (!resolved) {
    throw new Error(`Secret reference "${secretRefKey(ref)}" resolved to an empty value.`);
  }
  return resolved;
}

async function resolveConfiguredStringForFullLocal(value, params) {
  const ref = normalizeSecretRef(value, params.config);
  if (!ref) {
    return cleanString(value);
  }
  try {
    return await resolveSecretRefStringForFullLocal(ref, params);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${params.path}: failed to resolve SecretRef "${secretRefKey(ref)}": ${message}`,
      { cause: error },
    );
  }
}

function isPathInside(rootPath, candidatePath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return (
    relative === "" ||
    (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function realpathForFullLocalConfig(filePath, label) {
  try {
    const nativeRealpath = realpathSync.native;
    return nativeRealpath ? nativeRealpath(filePath) : realpathSync(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} could not be resolved: ${filePath}: ${message}`, { cause: error });
  }
}

function deepMergeConfig(target, source) {
  if (Array.isArray(target) && Array.isArray(source)) {
    return [...target, ...source];
  }
  if (isPlainObject(target) && isPlainObject(source)) {
    const result = { ...target };
    for (const [key, value] of Object.entries(source)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        continue;
      }
      result[key] = key in result ? deepMergeConfig(result[key], value) : value;
    }
    return result;
  }
  return source;
}

function resolveIncludeRoots(env, cwd, homeDir) {
  const raw = cleanString(env.OPENCLAW_INCLUDE_ROOTS);
  if (!raw) {
    return [];
  }
  return raw
    .split(path.delimiter)
    .map((entry) => resolveUserPath(entry, cwd, homeDir))
    .filter((entry) => entry && path.isAbsolute(entry));
}

function resolveConfigIncludePath(includePath, basePath, roots) {
  const resolved = path.normalize(
    path.isAbsolute(includePath) ? includePath : path.resolve(path.dirname(basePath), includePath),
  );
  const candidateRoots = roots.filter((root) => isPathInside(root, resolved));
  if (candidateRoots.length === 0) {
    throw new Error(`Config include escapes allowed roots: ${includePath}`);
  }
  const realIncludePath = realpathForFullLocalConfig(resolved, "Config include");
  const realRoots = candidateRoots.map((root) =>
    realpathForFullLocalConfig(root, "Config include root"),
  );
  if (!realRoots.some((root) => isPathInside(root, realIncludePath))) {
    throw new Error(`Config include escapes allowed roots: ${includePath}`);
  }
  return realIncludePath;
}

function resolveConfigIncludesForFullLocal(value, params) {
  if (Array.isArray(value)) {
    return value.map((item) => resolveConfigIncludesForFullLocal(item, params));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  if (!(INCLUDE_KEY in value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolveConfigIncludesForFullLocal(item, params),
      ]),
    );
  }

  const includeValue = value[INCLUDE_KEY];
  const includeItems = Array.isArray(includeValue) ? includeValue : [includeValue];
  let included = {};
  for (const includeItem of includeItems) {
    if (typeof includeItem !== "string" || includeItem.trim().length === 0) {
      throw new Error(`Invalid config ${INCLUDE_KEY} entry.`);
    }
    if (params.depth >= MAX_INCLUDE_DEPTH) {
      throw new Error(`Maximum config include depth exceeded: ${includeItem}`);
    }
    const includePath = resolveConfigIncludePath(includeItem, params.basePath, params.roots);
    if (params.seen.has(includePath)) {
      throw new Error(`Circular config include detected: ${includePath}`);
    }
    const parsed = JSON5.parse(readFileSync(includePath, "utf8"));
    const resolved = resolveConfigIncludesForFullLocal(parsed, {
      ...params,
      basePath: includePath,
      depth: params.depth + 1,
      seen: new Set([...params.seen, includePath]),
    });
    included = deepMergeConfig(included, resolved);
  }

  const rest = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== INCLUDE_KEY)
      .map(([key, item]) => [key, resolveConfigIncludesForFullLocal(item, params)]),
  );
  return Object.keys(rest).length > 0 ? deepMergeConfig(included, rest) : included;
}

function readJsonIfExists(filePath, options = {}) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  try {
    const parsed = JSON5.parse(raw);
    return resolveConfigIncludesForFullLocal(parsed, {
      basePath: filePath,
      depth: 0,
      roots: [
        path.dirname(filePath),
        ...resolveIncludeRoots(
          options.env ?? {},
          options.cwd ?? process.cwd(),
          options.homeDir ?? os.homedir(),
        ),
      ],
      seen: new Set([path.normalize(filePath)]),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse full-local OpenClaw config ${filePath}: ${message}`, {
      cause: error,
    });
  }
}

function parseDotenv(raw) {
  const parsed = {};
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u);
    if (!match) {
      continue;
    }
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/u, "").trim();
    }
    parsed[key] = value;
  }
  return parsed;
}

function readDotenvIfExists(filePath) {
  try {
    return parseDotenv(readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function configuredEnvEntries(env) {
  return Object.fromEntries(
    Object.entries(env ?? {}).filter(([, value]) => cleanString(value) !== null),
  );
}

function hydrateFullLocalEnv(rawEnv, cwd, homeDir) {
  const repoDotenv = readDotenvIfExists(path.join(cwd, ".env"));
  const envAfterRepo = { ...configuredEnvEntries(repoDotenv), ...configuredEnvEntries(rawEnv) };
  const effectiveHomeDir = resolveUserPath(envAfterRepo.OPENCLAW_HOME, cwd, homeDir) ?? homeDir;
  const configDir = resolveConfigDir(envAfterRepo, cwd, homeDir);
  const stateDotenv = readDotenvIfExists(path.join(configDir, ".env"));
  const defaultStateEnvPath = path.join(effectiveHomeDir, ".openclaw", ".env");
  const stateEnvPath = path.join(configDir, ".env");
  const defaultConfigDir = path.join(effectiveHomeDir, ".openclaw");
  const explicitConfigDir = resolveUserPath(envAfterRepo.OPENCLAW_CONFIG_DIR, cwd, homeDir);
  const explicitStateDir = resolveUserPath(envAfterRepo.OPENCLAW_STATE_DIR, cwd, homeDir);
  const hasExplicitNonDefaultConfigRoot =
    Boolean(
      explicitConfigDir && path.resolve(explicitConfigDir) !== path.resolve(defaultConfigDir),
    ) ||
    Boolean(explicitStateDir && path.resolve(stateEnvPath) !== path.resolve(defaultStateEnvPath));
  const gatewayDotenv = hasExplicitNonDefaultConfigRoot
    ? {}
    : readDotenvIfExists(path.join(effectiveHomeDir, ".config", "openclaw", "gateway.env"));
  return {
    ...configuredEnvEntries(gatewayDotenv),
    ...configuredEnvEntries(stateDotenv),
    ...configuredEnvEntries(repoDotenv),
    ...configuredEnvEntries(rawEnv),
  };
}

function readNestedString(input, pathSegments) {
  let current = input;
  for (const segment of pathSegments) {
    if (!current || typeof current !== "object" || !(segment in current)) {
      return null;
    }
    current = current[segment];
  }
  return cleanString(current);
}

function readNestedValue(input, pathSegments) {
  let current = input;
  for (const segment of pathSegments) {
    if (!current || typeof current !== "object" || !(segment in current)) {
      return { exists: false, value: undefined };
    }
    current = current[segment];
  }
  return { exists: true, value: current };
}

function firstNestedString(input, paths) {
  for (const candidatePath of paths) {
    const value = readNestedString(input, candidatePath);
    if (value) {
      return value;
    }
  }
  return null;
}

async function firstConfiguredString(input, paths, params) {
  for (const candidatePath of paths) {
    const found = readNestedValue(input, candidatePath);
    if (!found.exists) {
      continue;
    }
    const value = await resolveConfiguredStringForFullLocal(found.value, {
      ...params,
      path: candidatePath.join("."),
    });
    if (value) {
      return value;
    }
  }
  return null;
}

async function firstConfiguredRuntimeString(input, paths, params, options = {}) {
  if (options.resolveSecretRefs === false) {
    return firstNestedString(input, paths);
  }
  return firstConfiguredString(input, paths, params);
}

function cloneJsonObject(input) {
  return input && typeof input === "object" ? structuredClone(input) : {};
}

function ensureRecord(parent, key) {
  const current = parent[key];
  if (current && typeof current === "object" && !Array.isArray(current)) {
    return current;
  }
  const next = {};
  parent[key] = next;
  return next;
}

function ensureEnabledPluginEntry(plugins, pluginId) {
  const entries = ensureRecord(plugins, "entries");
  const entry = ensureRecord(entries, pluginId);
  entry.enabled = true;
  return entry;
}

function normalizeComparablePath(inputPath) {
  return path.resolve(inputPath).replace(/\\/g, "/").toLowerCase();
}

function relativeContainerPath(containerRoot, relativePath) {
  const normalized = relativePath.split(path.sep).join("/");
  return normalized ? `${containerRoot}/${normalized}` : containerRoot;
}

function mapHostPathToContainer(inputPath, mappings) {
  const value = cleanString(inputPath);
  if (!value) {
    return value;
  }

  const resolved = path.resolve(value);
  const sortedMappings = [...mappings].toSorted(
    (left, right) =>
      normalizeComparablePath(right.hostRoot).length -
      normalizeComparablePath(left.hostRoot).length,
  );
  for (const mapping of sortedMappings) {
    const relative = path.relative(path.resolve(mapping.hostRoot), resolved);
    if (relative === "") {
      return mapping.containerRoot;
    }
    if (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      return relativeContainerPath(mapping.containerRoot, relative);
    }
  }
  return value;
}

function mapRequiredHostPathToContainer(inputPath, mappings, label) {
  const value = cleanString(inputPath);
  if (!value) {
    return value;
  }
  const mapped = mapHostPathToContainer(value, mappings);
  if (mapped === value) {
    throw new Error(
      `${label} is outside the mounted full-local roots. Set OPENCLAW_WORKSPACE_DIR, OPENCLAW_CONFIG_SOURCE_DIR, OPENCLAW_CUSTOM_SWARM_DIR, or OPENCLAW_EXTRA_AGENT_ROOT_DIR_* so Docker can mount ${value}.`,
    );
  }
  return mapped;
}

function mapConfiguredHostPathToContainer(inputPath, mappings, label, params) {
  const value = cleanString(inputPath);
  if (!value) {
    return value;
  }
  return mapRequiredHostPathToContainer(
    resolveUserPath(value, params.cwd, params.homeDir),
    mappings,
    label,
  );
}

function mapContainerPathToHost(inputPath, mappings) {
  const value = cleanString(inputPath);
  if (!value) {
    return null;
  }

  const normalized = value.replace(/\\/g, "/");
  const sortedMappings = [...mappings].toSorted(
    (left, right) => right.containerRoot.length - left.containerRoot.length,
  );
  for (const mapping of sortedMappings) {
    const containerRoot = mapping.containerRoot.replace(/\\/g, "/");
    if (normalized === containerRoot) {
      return mapping.hostRoot;
    }
    if (normalized.startsWith(`${containerRoot}/`)) {
      return path.join(mapping.hostRoot, ...normalized.slice(containerRoot.length + 1).split("/"));
    }
  }
  return null;
}

function normalizeContainerPath(inputPath) {
  const value = cleanString(inputPath);
  if (!value) {
    return null;
  }
  return path.posix.normalize(value.replace(/\\/g, "/")).replace(/\/+$/u, "") || "/";
}

function containerPathInside(inputPath, rootPath) {
  const normalized = normalizeContainerPath(inputPath);
  const root = normalizeContainerPath(rootPath);
  if (!normalized || !root) {
    return false;
  }
  return normalized === root || normalized.startsWith(`${root}/`);
}

function mapRequiredWritableContainerPathToHost(
  inputPath,
  mappings,
  label,
  example = CONTAINER_NVIDIA_VAULT_PATH,
) {
  const normalized = normalizeContainerPath(inputPath);
  if (containerPathInside(normalized, CONTAINER_CONFIG_SOURCE_DIR)) {
    throw new Error(
      `${label} must point inside a writable full-local mounted container path, for example ${example}. The /home/node/openclaw-source-config mount is read-only. Received: ${inputPath}`,
    );
  }
  if (containerPathInside(normalized, "/app")) {
    throw new Error(
      `${label} must point inside a writable full-local mounted container path, for example ${example}. The /app image path is not a writable host state mount. Received: ${inputPath}`,
    );
  }
  const writableMappings = mappings.filter(
    (mapping) =>
      !containerPathInside(mapping.containerRoot, CONTAINER_CONFIG_SOURCE_DIR) &&
      !containerPathInside(mapping.containerRoot, "/app"),
  );
  const mapped = mapContainerPathToHost(normalized, writableMappings);
  if (!mapped) {
    throw new Error(
      `${label} must point inside a writable full-local mounted container path, for example ${example}. Received: ${inputPath}`,
    );
  }
  return mapped;
}

function buildPathMappings({
  configDir,
  configSourceDir,
  cwd,
  customSwarmDir,
  extraAgentRootDir,
  extraAgentRootDirs,
  workspaceDir,
}) {
  const mappings = [];
  if (cleanString(workspaceDir)) {
    mappings.push({ hostRoot: workspaceDir, containerRoot: CONTAINER_WORKSPACE_DIR });
  }
  if (cleanString(customSwarmDir)) {
    mappings.push({ hostRoot: customSwarmDir, containerRoot: CONTAINER_CUSTOM_SWARM_DIR });
  }
  const extraRoots = Array.isArray(extraAgentRootDirs) ? extraAgentRootDirs : [extraAgentRootDir];
  for (const [index, extraRoot] of extraRoots.entries()) {
    if (cleanString(extraRoot) && EXTRA_AGENT_ROOT_CONTAINER_DIRS[index]) {
      mappings.push({
        hostRoot: extraRoot,
        containerRoot: EXTRA_AGENT_ROOT_CONTAINER_DIRS[index],
      });
    }
  }
  if (
    cleanString(configSourceDir) &&
    normalizeComparablePath(configSourceDir) !== normalizeComparablePath(configDir)
  ) {
    mappings.push({ hostRoot: configSourceDir, containerRoot: CONTAINER_CONFIG_SOURCE_DIR });
  }
  mappings.push(
    { hostRoot: configDir, containerRoot: CONTAINER_OPENCLAW_DIR },
    { hostRoot: cwd, containerRoot: "/app" },
  );
  return mappings;
}

function collectConfiguredAgentRootCandidates(config, params) {
  const agents = config?.agents;
  if (!agents || typeof agents !== "object") {
    return [];
  }

  const candidates = [];
  const pushCandidate = (value) => {
    const cleaned = cleanString(value);
    if (!cleaned) {
      return;
    }
    candidates.push(resolveUserPath(cleaned, params.cwd, params.homeDir));
  };
  const defaultsWorkspace = cleanString(agents.defaults?.workspace);
  if (defaultsWorkspace) {
    pushCandidate(defaultsWorkspace);
  }
  for (const entry of Array.isArray(agents.list) ? agents.list : []) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const workspace = cleanString(entry.workspace);
    const agentDir = cleanString(entry.agentDir);
    if (workspace) {
      pushCandidate(workspace);
    }
    if (agentDir) {
      pushCandidate(agentDir);
    }
  }
  return candidates;
}

function collectMcpServerRootCandidates(servers, params) {
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return [];
  }
  const candidates = [];
  const pushCandidate = (value) => {
    const cleaned = cleanString(value);
    if (!cleaned || !isHostAbsolutePath(cleaned)) {
      return;
    }
    const resolved = resolveUserPath(cleaned, params.cwd, params.homeDir);
    const root = path.extname(resolved) ? path.dirname(resolved) : resolved;
    if (isPathInside(params.cwd, root) && !isRepoLocalRuntimeMountCandidate(root, params)) {
      return;
    }
    candidates.push(root);
  };
  for (const server of Object.values(servers)) {
    if (!server || typeof server !== "object" || Array.isArray(server)) {
      continue;
    }
    const command = cleanString(server.command);
    const commandIsWindowsExe = Boolean(
      command && isWindowsAbsolutePath(command) && commandName(command).endsWith(".exe"),
    );
    if (commandIsWindowsExe) {
      continue;
    }
    pushCandidate(command);
    for (const arg of Array.isArray(server.args) ? server.args : []) {
      if (typeof arg === "string") {
        pushCandidate(arg);
      }
    }
  }
  return candidates;
}

function isRepoLocalRuntimeMountCandidate(root, params) {
  return isPathInside(path.join(params.cwd, ".agents"), root);
}

function collectConfiguredMcpRootCandidates(config, params) {
  const candidates = collectMcpServerRootCandidates(config?.mcp?.servers, params);
  const acpxMcpServers = config?.plugins?.entries?.acpx?.config?.mcpServers;
  candidates.push(...collectMcpServerRootCandidates(acpxMcpServers, params));
  return candidates;
}

function isWindowsAbsolutePath(value) {
  return WINDOWS_ABS_PATH_PATTERN.test(value) || WINDOWS_UNC_PATH_PATTERN.test(value);
}

function isHostAbsolutePath(value) {
  const cleaned = cleanString(value);
  return Boolean(cleaned && (path.isAbsolute(cleaned) || isWindowsAbsolutePath(cleaned)));
}

function splitDelimitedList(value) {
  const raw = cleanString(value);
  if (!raw) {
    return [];
  }
  const entries = raw
    .split(/[,\r\n;]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [...new Set(entries)];
}

function normalizeRuntimeMarker(value) {
  return cleanString(value)?.toLowerCase().replace(/_/g, "-") ?? null;
}

function agentRequestsHostNativeRuntime(entry) {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const params = entry.params && typeof entry.params === "object" ? entry.params : {};
  for (const key of ["runtime", "execution", "placement", "node", "runOn", "hostRuntime"]) {
    const marker = normalizeRuntimeMarker(entry[key]);
    if (marker && HOST_NATIVE_MARKERS.has(marker)) {
      return true;
    }
  }
  for (const key of ["fullLocalRuntime", "runtime", "placement", "hostRuntime"]) {
    const marker = normalizeRuntimeMarker(params[key]);
    if (marker && HOST_NATIVE_MARKERS.has(marker)) {
      return true;
    }
  }
  return entry.native === true || entry.hostNative === true || entry.desktopNative === true;
}

export function resolveFullLocalNativeAgentIds(config, env = process.env) {
  const explicit = splitDelimitedList(env.OPENCLAW_NATIVE_AGENT_IDS);
  const disabledDefaults = asBoolean(env.OPENCLAW_FULL_LOCAL_DISABLE_DEFAULT_NATIVE_AGENTS);
  const ids = new Set(disabledDefaults ? [] : DEFAULT_NATIVE_AGENT_IDS);
  for (const id of explicit) {
    ids.add(id);
  }
  const list = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  for (const entry of list) {
    const id = cleanString(entry?.id);
    if (!id) {
      continue;
    }
    if (agentRequestsHostNativeRuntime(entry) || isHostAbsolutePath(entry.command)) {
      ids.add(id);
    }
  }
  return [...ids].toSorted((left, right) => left.localeCompare(right));
}

function isMappedByFullLocal(value, mappings) {
  const mountedMappings = mappings.filter((mapping) => mapping.containerRoot !== "/app");
  return mapHostPathToContainer(value, mountedMappings) !== value;
}

function commonHostRoot(paths) {
  const resolved = paths.map((item) => path.resolve(item));
  if (resolved.length === 0) {
    return null;
  }
  if (resolved.length === 1) {
    return resolved[0];
  }

  const parsed = resolved.map((item) => {
    const root = path.parse(item).root;
    return {
      root,
      segments: path.relative(root, item).split(path.sep).filter(Boolean),
    };
  });
  const firstRoot = parsed[0]?.root;
  if (!firstRoot) {
    return null;
  }
  if (
    parsed.some((item) => normalizeComparablePath(item.root) !== normalizeComparablePath(firstRoot))
  ) {
    return null;
  }

  const commonSegments = [];
  for (let index = 0; ; index += 1) {
    const segment = parsed[0]?.segments[index];
    if (!segment) {
      break;
    }
    if (parsed.every((item) => item.segments[index]?.toLowerCase() === segment.toLowerCase())) {
      commonSegments.push(segment);
      continue;
    }
    break;
  }
  return commonSegments.length > 0 ? path.join(firstRoot, ...commonSegments) : firstRoot;
}

function commandName(command) {
  const cleaned = cleanString(command);
  if (!cleaned) {
    return "";
  }
  return path.basename(cleaned.replace(/\\/g, "/")).toLowerCase();
}

function normalizeContainerExecutable(command) {
  const name = commandName(command);
  if (
    name === "python" ||
    name === "python.exe" ||
    name === "python3" ||
    name === "python3.exe" ||
    name === "py" ||
    name === "py.exe"
  ) {
    return CONTAINER_PYTHON_BIN;
  }
  if (name === "node" || name === "node.exe") {
    return "node";
  }
  if (name === "npx" || name === "npx.cmd") {
    return "npx";
  }
  if (name === "pnpm" || name === "pnpm.cmd") {
    return "pnpm";
  }
  return null;
}

function executableIsPython(command) {
  return normalizeContainerExecutable(command) === CONTAINER_PYTHON_BIN;
}

function executableIsScriptRunner(command) {
  const normalized = normalizeContainerExecutable(command);
  return normalized === CONTAINER_PYTHON_BIN || normalized === "node";
}

function isLaunchScriptArg(value) {
  const cleaned = cleanString(value);
  return Boolean(cleaned && /\.(?:cjs|js|mjs|py|ts)$/iu.test(cleaned));
}

function mapHostAbsolutePathForContainer(value, mappings, params) {
  const cleaned = cleanString(value);
  if (!cleaned || !isHostAbsolutePath(cleaned)) {
    return { hostPath: null, mapped: cleaned, pathLike: false, visible: true };
  }
  const hostPath = resolveUserPath(cleaned, params.cwd, params.homeDir);
  const mapped = mapHostPathToContainer(hostPath, mappings);
  const visible = mapped !== hostPath && mapped !== cleaned;
  return { hostPath, mapped: visible ? mapped : cleaned, pathLike: true, visible };
}

function mapMcpArgsForContainer(args, mappings, params) {
  const nextArgs = [];
  const pathArgs = [];
  let unmappedHostPath = null;
  for (const arg of Array.isArray(args) ? args : []) {
    if (typeof arg !== "string") {
      nextArgs.push(arg);
      continue;
    }
    const mapped = mapHostAbsolutePathForContainer(arg, mappings, params);
    if (mapped.pathLike) {
      pathArgs.push({ ...mapped, original: arg });
      if (!mapped.visible && !unmappedHostPath) {
        unmappedHostPath = arg;
      }
    }
    nextArgs.push(mapped.visible ? mapped.mapped : arg);
  }
  return { args: nextArgs, pathArgs, unmappedHostPath };
}

function sanitizeMcpEnvForContainer(env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    return { env: undefined, removedKeys: [] };
  }
  const next = {};
  const removedKeys = [];
  for (const [key, value] of Object.entries(env)) {
    const normalized = key.toUpperCase();
    if (BLOCKED_STDIO_MCP_ENV_KEYS.has(normalized)) {
      removedKeys.push(key);
      continue;
    }
    next[key] = value;
  }
  return {
    env: Object.keys(next).length > 0 ? next : undefined,
    removedKeys,
  };
}

function findPrimaryMappedLaunchScript(command, argInfo) {
  if (!executableIsScriptRunner(command)) {
    return null;
  }
  return (
    argInfo.pathArgs.find((entry) => entry.visible && isLaunchScriptArg(entry.original)) ?? null
  );
}

function classifyPythonLaunchScriptForMcp(launchScript) {
  if (!launchScript?.hostPath || !launchScript.hostPath.endsWith(".py")) {
    return { compatible: true };
  }
  let source = "";
  try {
    source = readFileSync(launchScript.hostPath, "utf8").slice(0, 128 * 1024);
  } catch {
    return { compatible: true };
  }
  const looksLikeMcp =
    /\b(?:from|import)\s+mcp\b/u.test(source) ||
    /\bFastMCP\b/u.test(source) ||
    /\bstdio_server\b/u.test(source) ||
    /\bmcp\.server\b/u.test(source);
  const looksLikeHttpApp =
    /\bFastAPI\b/u.test(source) ||
    /\buvicorn\b/u.test(source) ||
    /\bstreamlit\b/u.test(source) ||
    /\bflask\b/u.test(source) ||
    /\baiohttp\.web\b/u.test(source);
  if (looksLikeHttpApp && !looksLikeMcp) {
    return {
      compatible: false,
      reason: `Python launch script appears to start an HTTP app, not a stdio MCP server: ${launchScript.original}`,
    };
  }
  return { compatible: true };
}

function normalizeFullLocalMcpServer(server, params) {
  if (!server || typeof server !== "object" || Array.isArray(server)) {
    return { kind: "container", server };
  }
  const command = cleanString(server.command);
  if (!command) {
    return { kind: "container", server };
  }

  const argInfo = mapMcpArgsForContainer(server.args, params.mappings, params);
  if (argInfo.unmappedHostPath) {
    return {
      kind: "host-only",
      reason: `argument path is not mounted in Docker: ${argInfo.unmappedHostPath}`,
      server,
    };
  }

  const commandPath = mapHostAbsolutePathForContainer(command, params.mappings, params);
  let nextCommand = command;
  if (commandPath.pathLike) {
    if (commandPath.visible) {
      if (isWindowsAbsolutePath(command) && commandName(command).endsWith(".exe")) {
        return {
          kind: "host-only",
          reason: `Windows executable is mounted but cannot run in the Linux container: ${command}`,
          server,
        };
      }
      nextCommand = commandPath.mapped;
    } else if (executableIsPython(command)) {
      const launchScript = findPrimaryMappedLaunchScript(command, argInfo);
      if (!launchScript?.hostPath || !existsSync(launchScript.hostPath)) {
        return {
          kind: "host-only",
          reason: `Python launcher ${command} is host-only and its container launch script is not present`,
          server,
        };
      }
      nextCommand = CONTAINER_PYTHON_BIN;
    } else {
      return {
        kind: "host-only",
        reason: `command path is not mounted in Docker: ${command}`,
        server,
      };
    }
  } else {
    nextCommand = normalizeContainerExecutable(command) ?? command;
  }

  const launchScript = findPrimaryMappedLaunchScript(nextCommand, argInfo);
  if (launchScript?.hostPath && !existsSync(launchScript.hostPath)) {
    return {
      kind: "host-only",
      reason: `launch script is not present on the mounted host path: ${launchScript.original}`,
      server,
    };
  }
  if (executableIsPython(nextCommand) && launchScript) {
    const compatibility = classifyPythonLaunchScriptForMcp(launchScript);
    if (!compatibility.compatible) {
      return {
        kind: "host-only",
        reason: compatibility.reason,
        server,
      };
    }
  }

  const envResult = sanitizeMcpEnvForContainer(server.env);
  const wrapMountedNodeScript =
    nextCommand === "node" &&
    launchScript?.mapped &&
    !containerPathInside(launchScript.mapped, "/app");
  const next = { ...server, command: nextCommand };
  if (Array.isArray(server.args)) {
    next.args = argInfo.args;
  }
  if (executableIsPython(nextCommand) && launchScript) {
    next.command = "node";
    next.args = [PYTHON_MCP_LAUNCHER_CONTAINER_PATH, ...(next.args ?? [])];
  } else if (wrapMountedNodeScript) {
    next.command = "node";
    next.args = [NODE_MCP_LAUNCHER_CONTAINER_PATH, ...(next.args ?? [])];
  }
  if (envResult.env) {
    next.env = envResult.env;
  } else {
    delete next.env;
  }
  return { kind: "container", server: next };
}

function sanitizeMcpServersForContainer(servers, params) {
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return { servers, hostOnly: [] };
  }
  const nextServers = {};
  const hostOnly = [];
  for (const [serverName, server] of Object.entries(servers)) {
    const normalized = normalizeFullLocalMcpServer(server, params);
    if (normalized.kind === "host-only") {
      hostOnly.push({ name: serverName, reason: normalized.reason });
      continue;
    }
    nextServers[serverName] = normalized.server;
  }
  return { servers: nextServers, hostOnly };
}

function applyFullLocalMcpRuntimeConfig(next, params) {
  const hostOnly = [];
  if (next.mcp && typeof next.mcp === "object" && !Array.isArray(next.mcp)) {
    const result = sanitizeMcpServersForContainer(next.mcp.servers, params);
    if (result.servers !== next.mcp.servers) {
      next.mcp = { ...next.mcp, servers: result.servers };
    }
    hostOnly.push(...result.hostOnly);
  }
  const acpxConfig = next.plugins?.entries?.acpx?.config;
  if (acpxConfig && typeof acpxConfig === "object" && !Array.isArray(acpxConfig)) {
    const result = sanitizeMcpServersForContainer(acpxConfig.mcpServers, params);
    if (result.servers !== acpxConfig.mcpServers) {
      acpxConfig.mcpServers = result.servers;
    }
    for (const entry of result.hostOnly) {
      hostOnly.push(Object.assign({}, entry, { source: "acpx" }));
    }
  }
  return hostOnly.toSorted((left, right) => left.name.localeCompare(right.name));
}

function collectFullLocalHostOnlyMcpServers(config, params) {
  const clone = cloneJsonObject(config);
  return applyFullLocalMcpRuntimeConfig(clone, params);
}

function isFilesystemRoot(inputPath) {
  const resolved = path.resolve(inputPath);
  return normalizeComparablePath(resolved) === normalizeComparablePath(path.parse(resolved).root);
}

function minimalMountRoots(paths) {
  const roots = [];
  const sorted = [...new Set(paths.map((item) => path.resolve(item)))].toSorted(
    (left, right) => normalizeComparablePath(left).length - normalizeComparablePath(right).length,
  );
  for (const candidate of sorted) {
    if (
      roots.some((root) => {
        const relative = path.relative(root, candidate);
        return (
          relative === "" ||
          (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative))
        );
      })
    ) {
      continue;
    }
    roots.push(candidate);
  }
  return roots;
}

function assertMandatoryExtraRootsMounted(params) {
  const writableMappings = buildPathMappings({
    ...params,
    configSourceDir: params.configDir,
    extraAgentRootDirs: params.extraAgentRootDirs,
  });
  const readMappings = buildPathMappings({
    ...params,
    extraAgentRootDirs: params.extraAgentRootDirs,
  });
  const unmappedWritableRoots = params.writableRootDirs.filter(
    (value) => !isMappedByFullLocal(value, writableMappings),
  );
  const unmappedIncludeRoots = params.includeRootDirs.filter(
    (value) => !isMappedByFullLocal(value, readMappings),
  );
  const unmapped = minimalMountRoots([...unmappedWritableRoots, ...unmappedIncludeRoots]);
  if (unmapped.length === 0) {
    return;
  }
  throw new Error(
    `Full-local needs to mount ${unmapped.join(
      ", ",
    )}, but all ${EXTRA_AGENT_ROOT_CONTAINER_DIRS.length} extra agent root slots are occupied. Move the path under an existing OPENCLAW_EXTRA_AGENT_ROOT_DIR_* root, free a slot, or consolidate related roots under one parent directory.`,
  );
}

function finalizeExtraAgentRootDirs(rootDirs, params) {
  const extraAgentRootDirs = rootDirs.slice(0, EXTRA_AGENT_ROOT_CONTAINER_DIRS.length);
  assertMandatoryExtraRootsMounted({
    ...params,
    extraAgentRootDirs,
  });
  return extraAgentRootDirs;
}

function resolveExtraAgentRootDirs(config, params) {
  const rawConfigNeedsWritableSource =
    asBoolean(params.env.OPENCLAW_FULL_LOCAL_USE_RAW_CONFIG) &&
    normalizeComparablePath(params.configSourceDir) !== normalizeComparablePath(params.configDir);
  const writableConfigSourceDirs = rawConfigNeedsWritableSource ? [params.configSourceDir] : [];
  const includeRootDirs = (Array.isArray(params.includeRootDirs) ? params.includeRootDirs : [])
    .filter((value) => cleanString(value) && path.isAbsolute(value))
    .map((value) => path.resolve(value));
  const mandatoryRootDirs = [...writableConfigSourceDirs, ...includeRootDirs]
    .filter((value) => cleanString(value) && path.isAbsolute(value))
    .map((value) => path.resolve(value));
  const explicit = resolveUserPath(
    params.env.OPENCLAW_EXTRA_AGENT_ROOT_DIR,
    params.cwd,
    params.homeDir,
  );
  if (explicit) {
    const explicitRoots = [
      explicit,
      ...EXTRA_AGENT_ROOT_CONTAINER_DIRS.slice(1)
        .map((_, index) =>
          resolveUserPath(
            params.env[`OPENCLAW_EXTRA_AGENT_ROOT_DIR_${index + 2}`],
            params.cwd,
            params.homeDir,
          ),
        )
        .filter(Boolean),
    ];
    const explicitMappings = buildPathMappings({
      configDir: params.configDir,
      configSourceDir: params.configDir,
      cwd: params.cwd,
      customSwarmDir: params.customSwarmDir,
      extraAgentRootDirs: explicitRoots,
      workspaceDir: params.workspaceDir,
    });
    const remainingMandatoryRoots = minimalMountRoots(
      mandatoryRootDirs.filter((value) => !isMappedByFullLocal(value, explicitMappings)),
    );
    return finalizeExtraAgentRootDirs([...explicitRoots, ...remainingMandatoryRoots], {
      ...params,
      includeRootDirs,
      writableRootDirs: writableConfigSourceDirs,
    });
  }

  const baseMappings = buildPathMappings({
    configDir: params.configDir,
    configSourceDir: params.configDir,
    cwd: params.cwd,
    customSwarmDir: params.customSwarmDir,
    workspaceDir: params.workspaceDir,
  });
  const configuredRootCandidates = [
    ...collectConfiguredAgentRootCandidates(config, params),
    ...collectConfiguredMcpRootCandidates(config, params),
  ];
  const unmappedConfiguredRoots = configuredRootCandidates
    .filter((value) => path.isAbsolute(value) && !isMappedByFullLocal(value, baseMappings))
    .map((value) => path.resolve(value));
  const unmappedMandatoryRoots = mandatoryRootDirs.filter(
    (value) => !isMappedByFullLocal(value, baseMappings),
  );
  const common = commonHostRoot(unmappedConfiguredRoots);
  const configuredMountRoots =
    common && !isFilesystemRoot(common) ? [common] : minimalMountRoots(unmappedConfiguredRoots);
  const unmapped = minimalMountRoots([...unmappedMandatoryRoots, ...configuredMountRoots]);
  if (common && !isFilesystemRoot(common)) {
    return finalizeExtraAgentRootDirs(unmapped, {
      ...params,
      includeRootDirs,
      writableRootDirs: writableConfigSourceDirs,
    });
  }
  return finalizeExtraAgentRootDirs(minimalMountRoots(unmapped), {
    ...params,
    includeRootDirs,
    writableRootDirs: writableConfigSourceDirs,
  });
}

export function buildFullLocalContainerConfig(config, params) {
  const next = cloneJsonObject(config);
  const mappings = buildPathMappings(params);
  const gatewayToken = cleanString(params.gatewayToken);
  const gatewayPassword = cleanString(params.gatewayPassword);
  const gatewayAuthMode = cleanString(params.gatewayAuthMode)?.toLowerCase();
  if (gatewayAuthMode || gatewayToken || gatewayPassword) {
    const gateway = ensureRecord(next, "gateway");
    const auth = ensureRecord(gateway, "auth");
    const tokenAllowed =
      gatewayAuthMode !== "password" &&
      gatewayAuthMode !== "trusted-proxy" &&
      gatewayAuthMode !== "none";
    const passwordAllowed = gatewayAuthMode !== "token" && gatewayAuthMode !== "none";
    if (!tokenAllowed) {
      delete auth.token;
    }
    if (!passwordAllowed) {
      delete auth.password;
    }
    if (gatewayToken) {
      auth.token = gatewayToken;
    }
    if (gatewayPassword) {
      auth.password = gatewayPassword;
    }
  }

  const agents = ensureRecord(next, "agents");
  const defaults = ensureRecord(agents, "defaults");
  defaults.workspace =
    mapConfiguredHostPathToContainer(
      defaults.workspace,
      mappings,
      "agents.defaults.workspace",
      params,
    ) || CONTAINER_WORKSPACE_DIR;
  defaults.memorySearch = {
    ...(defaults.memorySearch && typeof defaults.memorySearch === "object"
      ? defaults.memorySearch
      : {}),
    enabled: true,
    sync: {
      ...(defaults.memorySearch?.sync && typeof defaults.memorySearch.sync === "object"
        ? defaults.memorySearch.sync
        : {}),
      watch: false,
    },
  };

  const list = Array.isArray(agents.list) ? agents.list : [];
  if (list.length === 0) {
    agents.list = [{ id: "main", default: true }];
  } else {
    agents.list = list.map((entry) => {
      if (!entry || typeof entry !== "object") {
        return entry;
      }
      const mapped = Object.assign({}, entry);
      // Capability-agent prototypes briefly wrote this unsupported key; keep
      // full-local overlays bootable when refreshing older local configs.
      delete mapped.systemPromptOverride;
      if (typeof mapped.workspace === "string") {
        mapped.workspace = mapConfiguredHostPathToContainer(
          mapped.workspace,
          mappings,
          `agents.list[${mapped.id ?? "unknown"}].workspace`,
          params,
        );
      }
      if (typeof mapped.agentDir === "string") {
        mapped.agentDir = mapConfiguredHostPathToContainer(
          mapped.agentDir,
          mappings,
          `agents.list[${mapped.id ?? "unknown"}].agentDir`,
          params,
        );
      }
      if (mapped.id === "main" && !mapped.workspace) {
        mapped.workspace = CONTAINER_WORKSPACE_DIR;
      }
      return mapped;
    });
    if (!agents.list.some((entry) => entry && typeof entry === "object" && entry.id === "main")) {
      agents.list.push({ id: "main", default: true, workspace: CONTAINER_WORKSPACE_DIR });
    }
  }

  const plugins = ensureRecord(next, "plugins");
  const nvidiaSentinelBaseUrl = cleanString(params.nvidiaSentinelBaseUrl);
  if (nvidiaSentinelBaseUrl) {
    const models = ensureRecord(next, "models");
    const providers = ensureRecord(models, "providers");
    const nvidiaProvider = ensureRecord(providers, "nvidia");
    nvidiaProvider.baseUrl = nvidiaSentinelBaseUrl;
    const nvidiaGatewayApiKey = cleanString(params.nvidiaGatewayApiKey);
    if (nvidiaGatewayApiKey) {
      nvidiaProvider.apiKey = nvidiaGatewayApiKey;
    }
  }

  applyFullLocalMcpRuntimeConfig(next, {
    ...params,
    mappings,
  });

  const slots = ensureRecord(plugins, "slots");
  slots.memory =
    cleanString(slots.memory) && slots.memory !== "none" ? slots.memory : "memory-core";
  ensureEnabledPluginEntry(plugins, "memory-core");
  const wikiEntry = ensureEnabledPluginEntry(plugins, "memory-wiki");
  const existingWikiConfig =
    wikiEntry.config && typeof wikiEntry.config === "object" ? wikiEntry.config : {};
  const existingVaultConfig =
    existingWikiConfig.vault && typeof existingWikiConfig.vault === "object"
      ? existingWikiConfig.vault
      : {};
  const mappedVaultPath =
    typeof existingVaultConfig.path === "string"
      ? mapConfiguredHostPathToContainer(
          existingVaultConfig.path,
          mappings,
          "plugins.entries.memory-wiki.config.vault.path",
          params,
        )
      : undefined;
  wikiEntry.config = {
    ...existingWikiConfig,
    vaultMode: "bridge",
    vault: {
      ...existingVaultConfig,
      ...(mappedVaultPath ? { path: mappedVaultPath } : {}),
      renderMode: "obsidian",
    },
    obsidian: {
      ...(existingWikiConfig.obsidian && typeof existingWikiConfig.obsidian === "object"
        ? existingWikiConfig.obsidian
        : {}),
      enabled: true,
      useOfficialCli: false,
      openAfterWrites: false,
    },
    bridge: {
      ...(existingWikiConfig.bridge && typeof existingWikiConfig.bridge === "object"
        ? existingWikiConfig.bridge
        : {}),
      enabled: true,
      readMemoryArtifacts: true,
      indexDreamReports: true,
      indexDailyNotes: true,
      indexMemoryRoot: true,
      followMemoryEvents: true,
    },
    search: {
      ...(existingWikiConfig.search && typeof existingWikiConfig.search === "object"
        ? existingWikiConfig.search
        : {}),
      backend: "shared",
      corpus: "all",
    },
  };

  return next;
}

function resolveHostPathForContainerConfig(containerConfigPath, configPath, mappings = []) {
  const normalized = normalizeContainerPath(containerConfigPath);
  const mapped = mapRequiredWritableContainerPathToHost(
    normalized,
    mappings,
    "OPENCLAW_CONTAINER_CONFIG_PATH",
    DEFAULT_CONTAINER_CONFIG_PATH,
  );
  if (normalized === `${CONTAINER_OPENCLAW_DIR}/openclaw.json`) {
    throw new Error(
      `OPENCLAW_CONTAINER_CONFIG_PATH must not overwrite the active OpenClaw config. Use a Docker-only overlay path such as ${DEFAULT_CONTAINER_CONFIG_PATH}.`,
    );
  }
  if (normalizeComparablePath(mapped) === normalizeComparablePath(configPath)) {
    throw new Error(
      `OPENCLAW_CONTAINER_CONFIG_PATH must not overwrite the active OpenClaw config at ${configPath}. Use a Docker-only overlay path such as ${DEFAULT_CONTAINER_CONFIG_PATH}.`,
    );
  }
  return mapped;
}

function resolveFullLocalContainerConfigOverlayLocation(env, configPath, mappings = []) {
  const containerPath =
    cleanString(env.OPENCLAW_CONTAINER_CONFIG_PATH) ?? DEFAULT_CONTAINER_CONFIG_PATH;
  return {
    containerPath,
    hostPath: resolveHostPathForContainerConfig(containerPath, configPath, mappings),
  };
}

function writeFullLocalContainerConfigOverlay(params) {
  const mappings = buildPathMappings(params);
  if (asBoolean(params.env.OPENCLAW_FULL_LOCAL_USE_RAW_CONFIG)) {
    return {
      enabled: false,
      containerPath:
        mapHostPathToContainer(params.configPath, mappings) ?? "/home/node/.openclaw/openclaw.json",
      hostPath: params.configPath,
    };
  }

  const { containerPath, hostPath } = resolveFullLocalContainerConfigOverlayLocation(
    params.env,
    params.configPath,
    mappings,
  );
  const overlay = buildFullLocalContainerConfig(params.config, {
    configDir: params.configDir,
    configSourceDir: params.configSourceDir,
    customSwarmDir: params.customSwarmDir,
    cwd: params.cwd,
    extraAgentRootDir: params.extraAgentRootDir,
    extraAgentRootDirs: params.extraAgentRootDirs,
    gatewayAuthMode: params.gatewayAuthMode,
    gatewayPassword: params.gatewayPassword,
    gatewayToken: params.gatewayToken,
    homeDir: params.homeDir,
    nvidiaGatewayApiKey: params.nvidiaGatewayApiKey,
    nvidiaSentinelBaseUrl: params.nvidiaSentinelBaseUrl,
    workspaceDir: params.workspaceDir,
  });
  mkdirSync(path.dirname(hostPath), { recursive: true });
  writeFileSync(hostPath, `${JSON.stringify(overlay, null, 2)}\n`, { mode: 0o600 });
  return { enabled: true, containerPath, hostPath };
}

function writeFullLocalPathMap(params) {
  const mappings = buildPathMappings(params);
  const containerPath =
    cleanString(params.env.OPENCLAW_FULL_LOCAL_PATH_MAP) ?? DEFAULT_FULL_LOCAL_PATH_MAP;
  const hostPath = mapRequiredWritableContainerPathToHost(
    containerPath,
    mappings,
    "OPENCLAW_FULL_LOCAL_PATH_MAP",
    DEFAULT_FULL_LOCAL_PATH_MAP,
  );
  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    containerPython: CONTAINER_PYTHON_BIN,
    agentVenvRoot: CONTAINER_AGENT_VENV_ROOT,
    nativeAgentIds: params.nativeAgentIds,
    hostOnlyMcpServers: collectFullLocalHostOnlyMcpServers(params.config ?? {}, {
      ...params,
      mappings,
    }),
    mounts: mappings.map((mapping) => ({
      hostRoot: mapping.hostRoot,
      containerRoot: mapping.containerRoot,
    })),
  };
  mkdirSync(path.dirname(hostPath), { recursive: true });
  writeFileSync(hostPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return { containerPath, hostPath };
}

function readFullLocalContainerConfigOverlay(params) {
  const mappings = buildPathMappings(params);
  if (asBoolean(params.env.OPENCLAW_FULL_LOCAL_USE_RAW_CONFIG)) {
    return {
      enabled: false,
      containerPath:
        mapHostPathToContainer(params.configPath, mappings) ?? "/home/node/.openclaw/openclaw.json",
      hostPath: params.configPath,
    };
  }

  const { containerPath, hostPath } = resolveFullLocalContainerConfigOverlayLocation(
    params.env,
    params.configPath,
    mappings,
  );
  if (existsSync(hostPath)) {
    return { enabled: true, containerPath, hostPath };
  }
  return {
    enabled: false,
    containerPath:
      cleanString(params.env.OPENCLAW_CONTAINER_CONFIG_PATH) ??
      "/home/node/.openclaw/openclaw.json",
    hostPath: params.configPath,
  };
}

function resolveConfigDir(env, cwd, homeDir) {
  const openclawHome = resolveUserPath(env.OPENCLAW_HOME, cwd, homeDir) ?? homeDir;
  return (
    resolveUserPath(env.OPENCLAW_CONFIG_DIR, cwd, homeDir) ??
    resolveUserPath(env.OPENCLAW_STATE_DIR, cwd, homeDir) ??
    path.join(openclawHome, ".openclaw")
  );
}

function resolveWorkspaceDir(env, cwd, homeDir, configDir) {
  return (
    resolveUserPath(env.OPENCLAW_WORKSPACE_DIR, cwd, homeDir) ?? path.join(configDir, "workspace")
  );
}

function resolveAuthProfileSecretDir(env, cwd, homeDir) {
  return (
    resolveUserPath(env.OPENCLAW_AUTH_PROFILE_SECRET_DIR, cwd, homeDir) ??
    path.join(homeDir, ".openclaw-auth-profile-secrets")
  );
}

function resolveCustomSwarmDir(env, cwd, homeDir) {
  const explicit =
    resolveUserPath(env.OPENCLAW_CUSTOM_SWARM_DIR, cwd, homeDir) ??
    resolveUserPath(env.AG_CUSTOM_SWARM_DIR, cwd, homeDir);
  if (explicit) {
    return explicit;
  }

  const windowsDefault = "C:\\AG-Custom-Swarm";
  if (process.platform === "win32" && existsSync(windowsDefault)) {
    return windowsDefault;
  }

  return path.join(cwd, ".local", "openclaw-custom-swarm");
}

export async function isPortAvailable(port, host = "127.0.0.1") {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

export async function chooseSentinelPort(env = process.env, portAvailable = isPortAvailable) {
  const explicitPort = cleanString(env.OPENCLAW_SENTINEL_PORT);
  if (explicitPort) {
    return parseTcpPortString(explicitPort, "OPENCLAW_SENTINEL_PORT");
  }

  for (let port = DEFAULT_SENTINEL_PORT; port < DEFAULT_SENTINEL_PORT + 20; port += 1) {
    let available = true;
    for (const host of SENTINEL_PUBLISH_PROBE_HOSTS) {
      if (!(await portAvailable(port, host))) {
        available = false;
        break;
      }
    }
    if (available) {
      return String(port);
    }
  }

  throw new Error(
    `No available Sentinel port found in ${DEFAULT_SENTINEL_PORT}-${
      DEFAULT_SENTINEL_PORT + 19
    }. Set OPENCLAW_SENTINEL_PORT to a free port.`,
  );
}

export async function deriveFullLocalRuntime(options = {}) {
  const cwd = options.cwd ?? resolveRepoRoot();
  const homeDir = options.homeDir ?? os.homedir();
  const env = hydrateFullLocalEnv(options.env ?? process.env, cwd, homeDir);
  const configPath = resolveOpenClawConfigPath(env, homeDir, cwd);
  const config =
    options.config ??
    readJsonIfExists(configPath, {
      cwd,
      env,
      homeDir,
    });
  const configDir = resolveConfigDir(env, cwd, homeDir);
  const configSourceDir = path.dirname(configPath);
  const workspaceDir = resolveWorkspaceDir(env, cwd, homeDir, configDir);
  const customSwarmDir = resolveCustomSwarmDir(env, cwd, homeDir);
  const includeRootDirs = resolveIncludeRoots(env, cwd, homeDir);
  if (asBoolean(env.OPENCLAW_FULL_LOCAL_USE_RAW_CONFIG) && includeRootDirs.length > 0) {
    throw new Error(
      "Raw full-local config cannot use external OPENCLAW_INCLUDE_ROOTS because container runtime includes must be container-visible paths. Unset OPENCLAW_FULL_LOCAL_USE_RAW_CONFIG so full-local can write a container-safe overlay.",
    );
  }
  const extraAgentRootDirs = resolveExtraAgentRootDirs(config, {
    configDir,
    configSourceDir,
    customSwarmDir,
    cwd,
    env,
    homeDir,
    includeRootDirs,
    workspaceDir,
  });
  const extraAgentRootDir = extraAgentRootDirs[0] ?? null;
  const nativeAgentIds = resolveFullLocalNativeAgentIds(config, env);
  const sentinelListenPort =
    parseTcpPortString(env.OPENCLAW_SENTINEL_LISTEN_PORT, "OPENCLAW_SENTINEL_LISTEN_PORT") ??
    String(DEFAULT_SENTINEL_PORT);
  const nvidiaSentinelBaseUrl = `http://openclaw-sentinel:${sentinelListenPort}/v1`;
  const shouldWriteContainerConfig =
    options.writeContainerConfigOverlay ?? options.config === undefined;
  const resolveConfiguredSecretRefs = options.writeContainerConfigOverlay !== false;
  const configuredNvidiaApiKey = await firstConfiguredRuntimeString(
    config,
    [
      ["models", "providers", "nvidia", "apiKey"],
      ["plugins", "entries", "nvidia", "config", "apiKey"],
    ],
    { config, cwd, env, homeDir },
    { resolveSecretRefs: resolveConfiguredSecretRefs },
  );
  const nvidiaBaseUrl = firstNestedString(config, [
    ["models", "providers", "nvidia", "baseUrl"],
    ["plugins", "entries", "nvidia", "config", "baseUrl"],
  ]);
  const rawNvidiaProviderUsesSentinel =
    Boolean(nvidiaBaseUrl) &&
    /\bopenclaw-sentinel\b|127\.0\.0\.1:1888[89]|localhost:1888[89]/u.test(nvidiaBaseUrl);
  const envNvidiaApiKeys = cleanString(env.NVIDIA_API_KEYS);
  const envNvidiaApiKey =
    cleanString(env.NVIDIA_API_KEY) ?? cleanString(env.OPENCLAW_NVIDIA_API_KEY);
  const configuredNvidiaPoolApiKey = rawNvidiaProviderUsesSentinel ? null : configuredNvidiaApiKey;
  const nvidiaApiKey = envNvidiaApiKey ?? configuredNvidiaPoolApiKey;
  const signalHubNvidiaApiKeys =
    cleanString(env.OPENCLAW_SIGNAL_HUB_NVIDIA_API_KEYS) ??
    buildNvidiaPoolValue(envNvidiaApiKeys, nvidiaApiKey, env.OPENCLAW_SIGNAL_HUB_NVIDIA_API_KEY);
  const configuredSentinelToken = await firstConfiguredRuntimeString(
    config,
    [
      ["models", "providers", "nvidia", "sentinelToken"],
      ["plugins", "entries", "nvidia", "config", "sentinelToken"],
    ],
    { config, cwd, env, homeDir },
    { resolveSecretRefs: resolveConfiguredSecretRefs },
  );
  const explicitSentinelToken = cleanString(env.OPENCLAW_SENTINEL_TOKEN) ?? configuredSentinelToken;
  const nvidiaGatewayApiKey = explicitSentinelToken ?? configuredNvidiaApiKey ?? envNvidiaApiKey;
  const gatewayAuthMode = cleanString(firstNestedString(config, [["gateway", "auth", "mode"]]));
  const gatewayAuthModeNormalized = gatewayAuthMode?.toLowerCase();
  const gatewayTokenCanWin =
    gatewayAuthModeNormalized !== "password" &&
    gatewayAuthModeNormalized !== "trusted-proxy" &&
    gatewayAuthModeNormalized !== "none";
  const gatewayPasswordCanWin =
    gatewayAuthModeNormalized !== "token" && gatewayAuthModeNormalized !== "none";
  const gatewayToken = gatewayTokenCanWin
    ? (cleanString(env.OPENCLAW_GATEWAY_TOKEN) ??
      (await firstConfiguredRuntimeString(
        config,
        [
          ["gateway", "auth", "token"],
          ["gateway", "remote", "token"],
        ],
        { config, cwd, env, homeDir },
        { resolveSecretRefs: resolveConfiguredSecretRefs },
      )))
    : undefined;
  const gatewayPassword = gatewayPasswordCanWin
    ? (cleanString(env.OPENCLAW_GATEWAY_PASSWORD) ??
      (await firstConfiguredRuntimeString(
        config,
        [
          ["gateway", "auth", "password"],
          ["gateway", "remote", "password"],
        ],
        { config, cwd, env, homeDir },
        { resolveSecretRefs: resolveConfiguredSecretRefs },
      )))
    : undefined;
  const containerConfig = shouldWriteContainerConfig
    ? writeFullLocalContainerConfigOverlay({
        config,
        configDir,
        configPath,
        configSourceDir,
        customSwarmDir,
        cwd,
        env,
        extraAgentRootDir,
        extraAgentRootDirs,
        gatewayAuthMode: gatewayAuthModeNormalized,
        gatewayPassword,
        gatewayToken,
        homeDir,
        nvidiaGatewayApiKey,
        nvidiaSentinelBaseUrl,
        workspaceDir,
      })
    : readFullLocalContainerConfigOverlay({
        configDir,
        configPath,
        configSourceDir,
        customSwarmDir,
        cwd,
        env,
        extraAgentRootDir,
        extraAgentRootDirs,
        workspaceDir,
      });
  const authProfileSecretDir = resolveAuthProfileSecretDir(env, cwd, homeDir);
  const nvidiaProviderUsesSentinel = containerConfig.enabled
    ? Boolean(nvidiaGatewayApiKey || envNvidiaApiKeys || nvidiaBaseUrl)
    : rawNvidiaProviderUsesSentinel;
  const sentinelToken =
    nvidiaProviderUsesSentinel && nvidiaGatewayApiKey
      ? nvidiaGatewayApiKey
      : (explicitSentinelToken ?? configuredNvidiaApiKey ?? envNvidiaApiKey);
  const sentinelPort = await chooseSentinelPort(env, options.portAvailable ?? isPortAvailable);
  const gatewayPort = cleanString(env.OPENCLAW_GATEWAY_PORT) ?? String(DEFAULT_GATEWAY_PORT);
  const containerNvidiaVaultPath =
    cleanString(env.OPENCLAW_FULL_LOCAL_NVIDIA_VAULT_PATH) ?? CONTAINER_NVIDIA_VAULT_PATH;
  const pathMappings = buildPathMappings({
    configDir,
    configSourceDir,
    cwd,
    customSwarmDir,
    extraAgentRootDir,
    extraAgentRootDirs,
    workspaceDir,
  });
  const hostNvidiaVaultPath = mapRequiredWritableContainerPathToHost(
    containerNvidiaVaultPath,
    pathMappings,
    "OPENCLAW_FULL_LOCAL_NVIDIA_VAULT_PATH",
  );
  const nvidiaVaultKeyCount = readNvidiaVaultKeyCount(hostNvidiaVaultPath);
  const containerIncludeRoots = includeRootDirs.map((includeRootDir) =>
    mapRequiredHostPathToContainer(includeRootDir, pathMappings, "OPENCLAW_INCLUDE_ROOTS"),
  );
  const pathMap = shouldWriteContainerConfig
    ? writeFullLocalPathMap({
        configDir,
        config,
        configSourceDir,
        customSwarmDir,
        cwd,
        env,
        extraAgentRootDir,
        extraAgentRootDirs,
        nativeAgentIds,
        workspaceDir,
      })
    : {
        containerPath: cleanString(env.OPENCLAW_FULL_LOCAL_PATH_MAP) ?? DEFAULT_FULL_LOCAL_PATH_MAP,
        hostPath:
          mapContainerPathToHost(
            cleanString(env.OPENCLAW_FULL_LOCAL_PATH_MAP) ?? DEFAULT_FULL_LOCAL_PATH_MAP,
            pathMappings,
          ) ?? null,
      };

  const runtimeEnv = {
    ...env,
    OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: cleanString(env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS) ?? "1",
    OPENCLAW_AUTH_PROFILE_SECRET_DIR: authProfileSecretDir,
    OPENCLAW_CONFIG_DIR: configDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_CONFIG_SOURCE_DIR: configSourceDir,
    OPENCLAW_CONTAINER_CONFIG_PATH: containerConfig.containerPath,
    OPENCLAW_CONTAINER_PYTHON: CONTAINER_PYTHON_BIN,
    OPENCLAW_CUSTOM_SWARM_DIR: customSwarmDir,
    OPENCLAW_AGENT_VENV_ROOT: CONTAINER_AGENT_VENV_ROOT,
    OPENCLAW_EXTRA_AGENT_ROOT_DIR: extraAgentRootDir ?? workspaceDir,
    OPENCLAW_EXTRA_AGENT_ROOT_DIR_2: extraAgentRootDirs[1] ?? workspaceDir,
    OPENCLAW_EXTRA_AGENT_ROOT_DIR_3: extraAgentRootDirs[2] ?? workspaceDir,
    OPENCLAW_EXTRA_AGENT_ROOT_DIR_4: extraAgentRootDirs[3] ?? workspaceDir,
    OPENCLAW_EXTRA_AGENT_ROOT_DIR_5: extraAgentRootDirs[4] ?? workspaceDir,
    OPENCLAW_EXTRA_AGENT_ROOT_DIR_6: extraAgentRootDirs[5] ?? workspaceDir,
    OPENCLAW_EXTRA_AGENT_ROOT_DIR_7: extraAgentRootDirs[6] ?? workspaceDir,
    OPENCLAW_EXTRA_AGENT_ROOT_DIR_8: extraAgentRootDirs[7] ?? workspaceDir,
    OPENCLAW_GATEWAY_PORT: gatewayPort,
    OPENCLAW_NATIVE_AGENT_IDS: nativeAgentIds.join(","),
    OPENCLAW_FULL_LOCAL_PATH_MAP: pathMap.containerPath,
    ...(containerIncludeRoots.length > 0
      ? { OPENCLAW_CONTAINER_INCLUDE_ROOTS: containerIncludeRoots.join(CONTAINER_PATH_DELIMITER) }
      : {}),
    OPENCLAW_MEMORY_WIKI_GATEWAY_TIMEOUT_MS:
      cleanString(env.OPENCLAW_MEMORY_WIKI_GATEWAY_TIMEOUT_MS) ??
      String(DEFAULT_MEMORY_WIKI_GATEWAY_TIMEOUT_MS),
    OPENCLAW_NVIDIA_VAULT_PATH: containerNvidiaVaultPath,
    OPENCLAW_SENTINEL_HOST: cleanString(env.OPENCLAW_SENTINEL_HOST) ?? "0.0.0.0",
    OPENCLAW_SENTINEL_LISTEN_PORT: sentinelListenPort,
    OPENCLAW_SENTINEL_PORT: sentinelPort,
    OPENCLAW_SENTINEL_REQUIRE_TOKEN: cleanString(env.OPENCLAW_SENTINEL_REQUIRE_TOKEN) ?? "1",
    OPENCLAW_STATE_DIR: configDir,
    OPENCLAW_WORKSPACE_DIR: workspaceDir,
    SWARM_BLACKBOARD_BUSY_TIMEOUT_MS: String(
      parsePositiveInteger(
        env.SWARM_BLACKBOARD_BUSY_TIMEOUT_MS,
        DEFAULT_FULL_LOCAL_BLACKBOARD_BUSY_TIMEOUT_MS,
      ),
    ),
    SWARM_BLACKBOARD_JOURNAL_MODE: normalizeBlackboardJournalMode(
      env.SWARM_BLACKBOARD_JOURNAL_MODE,
    ),
  };

  if (gatewayToken) {
    runtimeEnv.OPENCLAW_GATEWAY_TOKEN = gatewayToken;
  } else if (!gatewayTokenCanWin) {
    runtimeEnv.OPENCLAW_GATEWAY_TOKEN = "";
  }
  if (gatewayPassword) {
    runtimeEnv.OPENCLAW_GATEWAY_PASSWORD = gatewayPassword;
  } else if (!gatewayPasswordCanWin) {
    runtimeEnv.OPENCLAW_GATEWAY_PASSWORD = "";
  }
  if (sentinelToken) {
    runtimeEnv.OPENCLAW_SENTINEL_TOKEN = sentinelToken;
  }
  if (nvidiaApiKey) {
    runtimeEnv.NVIDIA_API_KEY = nvidiaApiKey;
  }
  if (signalHubNvidiaApiKeys) {
    runtimeEnv.OPENCLAW_SIGNAL_HUB_NVIDIA_API_KEYS = signalHubNvidiaApiKeys;
  }

  const facts = {
    authProfileSecretDir,
    configDir,
    configSourceDir,
    containerConfigOverlay: containerConfig.enabled,
    containerConfigPath: containerConfig.containerPath,
    containerConfigPathHost: containerConfig.hostPath,
    configPath,
    customSwarmDir,
    extraAgentRootDir,
    extraAgentRootDirs,
    includeRootDirs,
    gatewayPort,
    gatewayPortExplicit: Boolean(cleanString(env.OPENCLAW_GATEWAY_PORT)),
    gatewayAuthMode: gatewayAuthModeNormalized,
    gatewayAuthConfigured:
      Boolean(gatewayToken || gatewayPassword) || gatewayAuthModeNormalized === "none",
    gatewayPasswordConfigured: Boolean(gatewayPassword),
    gatewayTokenConfigured: Boolean(gatewayToken),
    nvidiaApiKeyConfigured: Boolean(nvidiaApiKey || envNvidiaApiKeys || nvidiaVaultKeyCount > 0),
    nvidiaProviderUsesSentinel,
    nvidiaSeedKeysConfigured: Boolean(nvidiaApiKey || envNvidiaApiKeys),
    nvidiaVaultPath: containerNvidiaVaultPath,
    nvidiaVaultPathHost: hostNvidiaVaultPath,
    nvidiaVaultKeyCount,
    nativeAgentIds,
    pathMapPath: pathMap.containerPath,
    pathMapPathHost: pathMap.hostPath,
    sentinelPort,
    sentinelPortExplicit: Boolean(cleanString(env.OPENCLAW_SENTINEL_PORT)),
    sentinelTokenConfigured: Boolean(sentinelToken),
    sentinelTokenMatchesNvidiaProvider: Boolean(
      nvidiaGatewayApiKey && sentinelToken === nvidiaGatewayApiKey,
    ),
    workspaceDir,
  };

  return { env: runtimeEnv, facts };
}

export function validateFullLocalRuntime(facts, env = process.env) {
  const errors = [];

  if (
    !facts.gatewayAuthConfigured &&
    !asBoolean(env.OPENCLAW_FULL_LOCAL_ALLOW_MISSING_GATEWAY_TOKEN)
  ) {
    errors.push(
      "Missing gateway auth. Set OPENCLAW_GATEWAY_TOKEN/gateway.auth.token or OPENCLAW_GATEWAY_PASSWORD/gateway.auth.password before full-local startup.",
    );
  }

  if (facts.gatewayAuthMode === "trusted-proxy") {
    errors.push(
      "Full-local sidecars cannot authenticate through gateway.auth.mode=trusted-proxy over the Docker bridge. Use gateway.auth.mode token or password for full-local startup.",
    );
  }

  if (facts.gatewayAuthMode === "none") {
    errors.push(
      "Full-local refuses gateway.auth.mode=none because the Docker Gateway is host-accessible by default. Use gateway.auth.mode token or password for full-local startup.",
    );
  }

  const gatewayBind = cleanString(env.OPENCLAW_GATEWAY_BIND)?.toLowerCase();
  if (gatewayBind === "loopback" || gatewayBind === "127.0.0.1" || gatewayBind === "localhost") {
    errors.push(
      "Full-local sidecars require the Gateway to listen on the Docker bridge. Remove OPENCLAW_GATEWAY_BIND=loopback or set OPENCLAW_GATEWAY_BIND=lan for full-local startup.",
    );
  }

  const sentinelHost = cleanString(env.OPENCLAW_SENTINEL_HOST)?.toLowerCase();
  if (
    sentinelHost === "loopback" ||
    sentinelHost === "127.0.0.1" ||
    sentinelHost === "localhost" ||
    sentinelHost === "::1"
  ) {
    errors.push(
      "Full-local sidecars require Sentinel to listen on the Docker bridge. Remove OPENCLAW_SENTINEL_HOST=loopback or set OPENCLAW_SENTINEL_HOST=0.0.0.0 for full-local startup.",
    );
  }

  if (
    facts.gatewayTokenConfigured &&
    facts.gatewayPasswordConfigured &&
    !["password", "token", "trusted-proxy"].includes(facts.gatewayAuthMode)
  ) {
    errors.push(
      "Gateway token and password are both configured. Set gateway.auth.mode to token or password before full-local startup.",
    );
  }

  const sentinelRequiresToken = asBoolean(cleanString(env.OPENCLAW_SENTINEL_REQUIRE_TOKEN) ?? "1");
  if (!facts.sentinelTokenConfigured && sentinelRequiresToken) {
    errors.push(
      "Missing Sentinel token. Set OPENCLAW_SENTINEL_TOKEN or models.providers.nvidia.apiKey before enabling Sentinel.",
    );
  }

  if (!facts.nvidiaApiKeyConfigured) {
    errors.push(
      "Missing NVIDIA API key pool. Set NVIDIA_API_KEY/NVIDIA_API_KEYS, or set models.providers.nvidia.apiKey when the provider is not already routed through Sentinel.",
    );
  }

  return errors;
}

export function buildComposeArgs(commandArgs = []) {
  const args = ["compose"];
  for (const composeFile of FULL_LOCAL_COMPOSE_FILES) {
    args.push("-f", composeFile);
  }
  args.push("--profile", FULL_LOCAL_PROFILE, ...commandArgs);
  return args;
}

export function buildUpArgs(env = process.env) {
  const args = ["up", "-d"];
  if (!asBoolean(env.OPENCLAW_FULL_LOCAL_SKIP_BUILD)) {
    args.push("--build");
  }
  args.push(...FULL_LOCAL_START_SERVICES);
  return buildComposeArgs(args);
}

export function buildMountPermissionRepairScript() {
  return `
const fs = require("node:fs");
const path = require("node:path");
const uid = Number(process.env.OPENCLAW_FULL_LOCAL_CONTAINER_UID || 1000);
const gid = Number(process.env.OPENCLAW_FULL_LOCAL_CONTAINER_GID || 1000);
const targets = new Map();
function remember(target, recursive = false) {
  if (!target || typeof target !== "string" || !target.startsWith("/home/node/")) return;
  targets.set(target, targets.get(target) || recursive);
}
function rememberPathAndParent(target, recursive = false) {
  remember(target, recursive);
  if (target && target !== "/home/node") remember(path.dirname(target), recursive);
}
for (const target of [
  "/home/node/.openclaw",
  "/home/node/.openclaw/full-local",
  "/home/node/.openclaw/workspace_nvidia_key_sentinel",
  "/home/node/.openclaw/workspace",
  "/home/node/.config/openclaw",
  "/home/node/custom-swarm",
  "/home/node/openclaw-extra-agent-root",
  "/home/node/openclaw-extra-agent-root-2",
  "/home/node/openclaw-extra-agent-root-3",
  "/home/node/openclaw-extra-agent-root-4",
  "/home/node/openclaw-extra-agent-root-5",
  "/home/node/openclaw-extra-agent-root-6",
  "/home/node/openclaw-extra-agent-root-7",
  "/home/node/openclaw-extra-agent-root-8",
]) {
  remember(target, target.includes("full-local") || target.includes("workspace_nvidia_key_sentinel"));
}
for (const envName of [
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_WORKSPACE_DIR",
  "OPENCLAW_NVIDIA_VAULT_PATH",
]) {
  rememberPathAndParent(process.env[envName]);
}
let repaired = 0;
let skipped = 0;
let failed = 0;
function repair(target, recursive, depth = 0) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    skipped += 1;
    return;
  }
  try {
    fs.chownSync(target, uid, gid);
  } catch {
    failed += 1;
  }
  if (stat.isDirectory()) {
    try {
      fs.chmodSync(target, 0o755);
      repaired += 1;
    } catch {
      failed += 1;
    }
    if (recursive && depth < 5) {
      let children = [];
      try {
        children = fs.readdirSync(target);
      } catch {
        return;
      }
      for (const child of children) {
        repair(path.join(target, child), true, depth + 1);
      }
    }
  } else {
    repaired += 1;
  }
}
for (const [target, recursive] of targets) {
  repair(target, recursive);
}
console.log(JSON.stringify({ failed, repaired, skipped }));
`.trim();
}

export function buildMountPermissionRepairArgs(service = FULL_LOCAL_MOUNT_REPAIR_SERVICES[0]) {
  return buildComposeArgs([
    "exec",
    "-T",
    "-u",
    "root",
    service,
    "node",
    "-e",
    buildMountPermissionRepairScript(),
  ]);
}

function runDocker(args, options = {}) {
  const env = options.env ?? process.env;
  const command = cleanString(env.OPENCLAW_DOCKER_COMMAND) ?? "docker";
  const commandArgs = parseJsonStringArrayEnv(
    env.OPENCLAW_DOCKER_COMMAND_ARGS_JSON,
    "OPENCLAW_DOCKER_COMMAND_ARGS_JSON",
  );
  const result = spawnSync(command, [...commandArgs, ...args], {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    timeout: options.timeoutMs,
  });

  if (result.error) {
    return {
      ok: false,
      status: null,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? result.error.message,
    };
  }

  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function dockerCommandShouldRetry(result) {
  if (result.ok) {
    return false;
  }
  if (!result.ok && result.status === null) {
    return true;
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.toLowerCase();
  return (
    output.includes("database is locked") ||
    output.includes("sqlite_busy") ||
    output.includes("is not running") ||
    output.includes("is not a running container") ||
    output.includes("container is restarting") ||
    output.includes("no container found")
  );
}

function runDockerWithRetries(args, options = {}) {
  const attempts = Math.max(1, options.attempts ?? 3);
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = runDocker(args, options);
    if (!dockerCommandShouldRetry(last)) {
      return {
        ...last,
        attempts: attempt,
      };
    }
    if (attempt < attempts) {
      sleepSync(options.retryDelayMs ?? 2_000);
    }
  }
  return {
    ...last,
    attempts,
  };
}

function repairFullLocalMountPermissions(runtime, options = {}) {
  if (asBoolean(runtime.env.OPENCLAW_FULL_LOCAL_SKIP_MOUNT_REPAIR)) {
    return { ok: true, repairs: [], skipped: true };
  }
  const cwd = options.cwd ?? resolveRepoRoot();
  const repairs = [];
  for (const service of FULL_LOCAL_MOUNT_REPAIR_SERVICES) {
    const result = runDocker(buildMountPermissionRepairArgs(service), {
      capture: true,
      cwd,
      env: runtime.env,
      maxBuffer: 4 * 1024 * 1024,
      timeoutMs: options.timeoutMs ?? 60_000,
    });
    const summary = extractJson(result.stdout);
    const failed = summary && typeof summary === "object" ? Number(summary.failed ?? 0) : 0;
    repairs.push({
      ok: result.ok && failed === 0,
      service,
      status: result.status,
      stderr: result.ok ? "" : result.stderr.trim(),
      summary,
    });
  }
  return {
    ok: repairs.every((repair) => repair.ok),
    repairs,
    skipped: false,
  };
}

function collectPythonMcpLaunchScripts(runtime) {
  if (
    !runtime?.facts?.containerConfigPathHost ||
    !existsSync(runtime.facts.containerConfigPathHost)
  ) {
    return [];
  }
  let config;
  try {
    config = JSON.parse(readFileSync(runtime.facts.containerConfigPathHost, "utf8"));
  } catch {
    return [];
  }
  const scripts = new Set();
  const collectServers = (servers) => {
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      return;
    }
    for (const server of Object.values(servers)) {
      if (!server || typeof server !== "object" || Array.isArray(server)) {
        continue;
      }
      if (server.command !== "node" || !Array.isArray(server.args)) {
        continue;
      }
      const [launcher, scriptPath] = server.args;
      if (launcher === PYTHON_MCP_LAUNCHER_CONTAINER_PATH && cleanString(scriptPath)) {
        scripts.add(scriptPath);
      }
    }
  };
  collectServers(config.mcp?.servers);
  collectServers(config.plugins?.entries?.acpx?.config?.mcpServers);
  return [...scripts].toSorted((left, right) => left.localeCompare(right));
}

function prepareFullLocalPythonMcpEnvironments(runtime, options = {}) {
  if (asBoolean(runtime.env.OPENCLAW_FULL_LOCAL_SKIP_PYTHON_MCP_PREPARE)) {
    return { ok: true, prepared: [], skipped: true };
  }
  const scripts = collectPythonMcpLaunchScripts(runtime);
  if (scripts.length === 0) {
    return { ok: true, prepared: [], skipped: true };
  }
  const cwd = options.cwd ?? resolveRepoRoot();
  const timeoutMs = parsePositiveInteger(
    runtime.env.OPENCLAW_FULL_LOCAL_PYTHON_MCP_PREPARE_TIMEOUT_MS,
    600_000,
  );
  const prepared = [];
  for (const scriptPath of scripts) {
    const result = runGatewayNode(
      runtime,
      ["node", PYTHON_MCP_LAUNCHER_CONTAINER_PATH, "--prepare", scriptPath],
      {
        capture: true,
        cwd,
        maxBuffer: 8 * 1024 * 1024,
        timeoutMs,
      },
    );
    prepared.push({
      ok: result.ok,
      scriptPath,
      status: result.status,
      stderr: result.ok ? "" : result.stderr.trim(),
    });
  }
  return {
    ok: prepared.every((entry) => entry.ok),
    prepared,
    skipped: false,
  };
}

export function resolveWindowsNativeNodePidPath(
  runtime,
  cwd = resolveRepoRoot(),
  homeDir = os.homedir(),
) {
  const explicit = resolveUserPath(runtime?.env?.SWARM_WINDOWS_NODE_PID_PATH, cwd, homeDir);
  if (explicit) {
    return explicit;
  }
  const configDir = cleanString(runtime?.facts?.configDir);
  return path.join(
    configDir ?? path.dirname(resolveOpenClawConfigPath(runtime?.env ?? {}, homeDir, cwd)),
    "full-local",
    "windows-node.pid",
  );
}

function readWindowsNativeNodePid(pidPath) {
  try {
    const raw = readFileSync(pidPath, "utf8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function localProcessIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function stopWindowsNativeNode(runtime, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return { ok: true, skipped: true, reason: "not-windows" };
  }

  const cwd = options.cwd ?? resolveRepoRoot();
  const homeDir = options.homeDir ?? os.homedir();
  const pidPath = options.pidPath ?? resolveWindowsNativeNodePidPath(runtime, cwd, homeDir);
  const pid = readWindowsNativeNodePid(pidPath);
  if (!pid) {
    return { ok: true, pidPath, skipped: true, reason: "no-pid-file" };
  }

  const processIsAlive = options.processIsAlive ?? localProcessIsAlive;
  if (!processIsAlive(pid)) {
    rmSync(pidPath, { force: true });
    return { ok: true, pid, pidPath, skipped: true, reason: "stale-pid-file" };
  }

  const killProcess = options.killProcess ?? ((targetPid) => process.kill(targetPid, "SIGTERM"));
  const sleep = options.sleep ?? sleepSync;
  try {
    killProcess(pid);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      pid,
      pidPath,
      skipped: false,
    };
  }

  const timeoutMs = Math.max(0, options.timeoutMs ?? 5_000);
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid) && Date.now() < deadline) {
    sleep(Math.min(200, Math.max(10, deadline - Date.now())));
  }

  if (processIsAlive(pid) && platform === "win32" && !options.disableTaskkill) {
    spawnSync("taskkill", ["/PID", String(pid), "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  }

  if (processIsAlive(pid)) {
    return {
      ok: false,
      error: `Windows-native bridge pid ${pid} did not exit`,
      pid,
      pidPath,
      skipped: false,
    };
  }

  rmSync(pidPath, { force: true });
  return { ok: true, pid, pidPath, skipped: false };
}

function startWindowsNativeNode(runtime, options = {}) {
  if (process.platform !== "win32") {
    return { ok: true, skipped: true, reason: "not-windows" };
  }
  if (asBoolean(runtime.env.OPENCLAW_FULL_LOCAL_SKIP_WINDOWS_NODE)) {
    return { ok: true, skipped: true, reason: "disabled" };
  }
  if (!Array.isArray(runtime.facts.nativeAgentIds) || runtime.facts.nativeAgentIds.length === 0) {
    return { ok: true, skipped: true, reason: "no-native-agents" };
  }
  const cwd = options.cwd ?? resolveRepoRoot();
  const scriptPath = path.join(cwd, "scripts", "docker", "sidecars", "windows-node.cjs");
  try {
    const child = spawn(process.execPath, [scriptPath], {
      cwd,
      detached: true,
      env: {
        ...process.env,
        ...runtime.env,
        OPENCLAW_CONFIG_PATH: runtime.facts.configPath,
        OPENCLAW_REPO_ROOT: cwd,
        OPENCLAW_STATE_DIR: runtime.facts.configDir,
      },
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => {});
    child.unref();
    return { ok: true, pid: child.pid, skipped: false };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      skipped: false,
    };
  }
}

function runGatewayNode(runtime, args, options = {}) {
  const envArgs = [
    "-e",
    `OPENCLAW_CONFIG_PATH=${runtime.facts.containerConfigPath}`,
    "-e",
    `OPENCLAW_CONTAINER_CONFIG_PATH=${runtime.facts.containerConfigPath}`,
  ];
  const memoryWikiGatewayTimeoutMs = cleanString(
    runtime.env.OPENCLAW_MEMORY_WIKI_GATEWAY_TIMEOUT_MS,
  );
  if (memoryWikiGatewayTimeoutMs) {
    envArgs.push("-e", `OPENCLAW_MEMORY_WIKI_GATEWAY_TIMEOUT_MS=${memoryWikiGatewayTimeoutMs}`);
  }
  for (const [key, value] of Object.entries(options.execEnv ?? {})) {
    envArgs.push("-e", `${key}=${value}`);
  }
  return runDocker(buildComposeArgs(["exec", "-T", ...envArgs, "openclaw-gateway", ...args]), {
    ...options,
    env: {
      ...runtime.env,
      ...options.env,
    },
  });
}

function runGatewayOpenClaw(runtime, args, options = {}) {
  return runGatewayNode(runtime, ["node", "openclaw.mjs", ...args], options);
}

function gatewayCommandShouldRetry(result) {
  if (!result.ok && result.status === null) {
    return true;
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.toLowerCase();
  return (
    output.includes("gateway timeout") ||
    output.includes("econnreset") ||
    output.includes("eperm: operation not permitted, fchmod")
  );
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runGatewayOpenClawWithRetries(runtime, args, options = {}) {
  const attempts = Math.max(1, options.attempts ?? 3);
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = runGatewayOpenClaw(runtime, args, options);
    if (!gatewayCommandShouldRetry(last)) {
      return {
        ...last,
        attempts: attempt,
      };
    }
    if (attempt < attempts) {
      sleepSync(options.retryDelayMs ?? 2_000);
    }
  }
  return {
    ...last,
    attempts,
  };
}

export function parseComposePublishedPort(stdout) {
  const text = stdout.trim().split(/\r?\n/u).findLast(Boolean) ?? "";
  const bracketMatch = text.match(/\]:(\d+)$/u);
  if (bracketMatch) {
    return bracketMatch[1];
  }
  const match = text.match(/:(\d+)$/u);
  return match ? match[1] : null;
}

function resolveComposePublishedPort(service, privatePort, runtime, cwd) {
  const result = runDocker(buildComposeArgs(["port", service, String(privatePort)]), {
    capture: true,
    cwd,
    env: runtime.env,
    timeoutMs: 15_000,
  });
  return result.ok ? parseComposePublishedPort(result.stdout) : null;
}

function reuseExistingPublishedPorts(runtime, cwd) {
  const gatewayPort = resolveComposePublishedPort(
    "openclaw-gateway",
    DEFAULT_GATEWAY_PORT,
    runtime,
    cwd,
  );
  if (gatewayPort && !runtime.facts.gatewayPortExplicit) {
    runtime.env.OPENCLAW_GATEWAY_PORT = gatewayPort;
    runtime.facts.gatewayPort = gatewayPort;
  }

  const sentinelPrivatePort = parsePositiveInteger(
    runtime.env.OPENCLAW_SENTINEL_LISTEN_PORT,
    DEFAULT_SENTINEL_PORT,
  );
  const sentinelPort = resolveComposePublishedPort(
    "openclaw-sentinel",
    sentinelPrivatePort,
    runtime,
    cwd,
  );
  if (sentinelPort && !runtime.facts.sentinelPortExplicit) {
    runtime.env.OPENCLAW_SENTINEL_PORT = sentinelPort;
    runtime.facts.sentinelPort = sentinelPort;
  }
}

export function parseComposePsJson(stdout) {
  const text = stdout.trim();
  if (!text) {
    return [];
  }
  if (text.startsWith("[")) {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  }
  return text
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function normalizeServiceRow(row) {
  return {
    health: cleanString(row.Health) ?? cleanString(row.health) ?? "",
    name: cleanString(row.Name) ?? cleanString(row.name) ?? "",
    service: cleanString(row.Service) ?? cleanString(row.service) ?? "",
    state: cleanString(row.State) ?? cleanString(row.state) ?? "",
  };
}

function serviceIsReady(row) {
  const state = row.state.toLowerCase();
  const health = row.health.toLowerCase();
  if (state !== "running") {
    return false;
  }
  return !health || health === "healthy";
}

function extractJson(stdout) {
  const text = stdout.trim();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    const starts = [];
    const pattern = /(^|\r?\n)\s*[[{]/gu;
    for (const match of text.matchAll(pattern)) {
      const rawIndex = match.index ?? 0;
      const prefix = match[1] ?? "";
      starts.push(rawIndex + prefix.length + (match[0].length - prefix.length - 1));
    }
    if (starts.length === 0) {
      const fallback = text.indexOf("{");
      if (fallback !== -1) {
        starts.push(fallback);
      }
    }
    for (const start of starts) {
      const opener = text[start];
      const closer = opener === "[" ? "]" : "}";
      const end = text.lastIndexOf(closer);
      if (end === -1 || end <= start) {
        continue;
      }
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        // Keep scanning; command wrappers may print diagnostics before JSON.
      }
    }
    return null;
  }
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  try {
    const response = await fetch(url, {
      headers: options.headers,
      signal: controller.signal,
    });
    const text = await response.text();
    return {
      body: extractJson(text) ?? text,
      ok: response.ok,
      status: response.status,
      url,
    };
  } catch (error) {
    return {
      body: error instanceof Error ? error.message : String(error),
      ok: false,
      status: null,
      url,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchJsonWithRetries(url, options = {}) {
  const attempts = Math.max(1, options.attempts ?? 1);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 1_000);
  let result = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = await fetchJson(url, options);
    const ready = options.isReady ? options.isReady(result) : result.ok;
    if (ready || attempt === attempts) {
      return result;
    }
    if (retryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  return result ?? (await fetchJson(url, options));
}

function endpointReady(result) {
  if (!result.ok || result.status !== 200) {
    return false;
  }
  if (!result.body || typeof result.body !== "object") {
    return true;
  }
  if ("ready" in result.body) {
    return result.body.ready === true;
  }
  return true;
}

function sentinelReady(result) {
  if (!endpointReady(result)) {
    return false;
  }
  if (!result.body || typeof result.body !== "object") {
    return false;
  }
  return Number(result.body.keys ?? 0) > 0;
}

function proofChecks(proof) {
  const servicesByName = new Map(proof.compose.services.map((row) => [row.service, row]));
  const checks = [];
  for (const service of FULL_LOCAL_SERVICES) {
    const row = servicesByName.get(service);
    checks.push({
      name: `service:${service}`,
      ok: Boolean(row && serviceIsReady(row)),
      value: row ? { health: row.health, state: row.state } : "missing",
    });
  }
  checks.push({
    name: "gateway:readyz",
    ok: endpointReady(proof.endpoints.gateway),
    value: { status: proof.endpoints.gateway.status },
  });
  checks.push({
    name: "sentinel:readyz",
    ok: sentinelReady(proof.endpoints.sentinel),
    value: {
      keys:
        proof.endpoints.sentinel.body && typeof proof.endpoints.sentinel.body === "object"
          ? proof.endpoints.sentinel.body.keys
          : null,
      status: proof.endpoints.sentinel.status,
    },
  });
  checks.push({
    name: "memory-wiki:status",
    ok: proof.wiki.ok,
    value: proof.wiki.summary,
  });
  return checks;
}

export function wikiSummaryReady(summary) {
  return (
    summary?.bridgeEnabled === true &&
    summary?.renderMode === "obsidian" &&
    summary?.vaultMode === "bridge"
  );
}

export function evaluateProof(proof) {
  const checks = proofChecks(proof);
  return {
    checks,
    ok: checks.every((check) => check.ok),
  };
}

function proofEnvFacts(facts, publishedPorts = {}) {
  const gatewayAuth =
    facts.gatewayTokenConfigured && facts.gatewayPasswordConfigured
      ? "token+password"
      : facts.gatewayTokenConfigured
        ? "token"
        : facts.gatewayPasswordConfigured
          ? "password"
          : facts.gatewayAuthMode === "none"
            ? "none"
            : "missing";
  return {
    containerConfig: facts.containerConfigOverlay ? "overlay" : "raw",
    customSwarmDirConfigured: existsSync(facts.customSwarmDir),
    gatewayAuth,
    gatewayPort: publishedPorts.gatewayPort ?? facts.gatewayPort,
    gatewayPassword: facts.gatewayPasswordConfigured ? "set" : "missing",
    gatewayToken: facts.gatewayTokenConfigured ? "set" : "missing",
    nvidiaApiKey: facts.nvidiaApiKeyConfigured ? "set" : "missing",
    nvidiaProviderUsesSentinel: facts.nvidiaProviderUsesSentinel,
    sentinelPort: publishedPorts.sentinelPort ?? facts.sentinelPort,
    sentinelToken: facts.sentinelTokenConfigured ? "set" : "missing",
    sentinelTokenMatchesNvidiaProvider: facts.sentinelTokenMatchesNvidiaProvider,
    nativeAgentCount: Array.isArray(facts.nativeAgentIds) ? facts.nativeAgentIds.length : 0,
  };
}

export function resolveMemoryWikiCommandTimeoutMs(env = process.env) {
  const memoryWikiGatewayTimeoutMs = parsePositiveInteger(
    env.OPENCLAW_MEMORY_WIKI_GATEWAY_TIMEOUT_MS,
    DEFAULT_MEMORY_WIKI_GATEWAY_TIMEOUT_MS,
  );
  const minimumCommandTimeoutMs = memoryWikiGatewayTimeoutMs + 60_000;
  const requestedCommandTimeoutMs = parsePositiveInteger(
    env.OPENCLAW_FULL_LOCAL_MEMORY_COMMAND_TIMEOUT_MS,
    minimumCommandTimeoutMs,
  );
  return Math.max(requestedCommandTimeoutMs, minimumCommandTimeoutMs);
}

export async function collectProof(runtime, options = {}) {
  const cwd = options.cwd ?? resolveRepoRoot();
  const deadline = options.deadline ?? Date.now() + (options.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
  const compose = runDocker(buildComposeArgs(["ps", "--format", "json"]), {
    capture: true,
    cwd,
    env: runtime.env,
    timeoutMs: 30_000,
  });
  const services = compose.ok ? parseComposePsJson(compose.stdout).map(normalizeServiceRow) : [];
  const gatewayPort =
    resolveComposePublishedPort("openclaw-gateway", DEFAULT_GATEWAY_PORT, runtime, cwd) ??
    runtime.facts.gatewayPort;
  const sentinelPrivatePort = parsePositiveInteger(
    runtime.env.OPENCLAW_SENTINEL_LISTEN_PORT,
    DEFAULT_SENTINEL_PORT,
  );
  const sentinelPort =
    resolveComposePublishedPort("openclaw-sentinel", sentinelPrivatePort, runtime, cwd) ??
    runtime.facts.sentinelPort;
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}/readyz`;
  const sentinelUrl = `http://127.0.0.1:${sentinelPort}/readyz`;
  const [gateway, sentinel] = await Promise.all([
    fetchJsonWithRetries(gatewayUrl, {
      attempts: 1,
      isReady: endpointReady,
      timeoutMs: 5_000,
    }),
    fetchJsonWithRetries(sentinelUrl, {
      attempts: 1,
      isReady: sentinelReady,
      timeoutMs: 5_000,
    }),
  ]);
  const wikiTimeoutMs = Math.max(
    1_000,
    Math.min(
      resolveMemoryWikiCommandTimeoutMs(runtime.env),
      Math.max(1_000, deadline - Date.now()),
    ),
  );
  const wikiResult = runGatewayOpenClawWithRetries(runtime, ["wiki", "status", "--json"], {
    attempts: 1,
    capture: true,
    cwd,
    timeoutMs: wikiTimeoutMs,
  });
  const wikiBody = extractJson(wikiResult.stdout);
  const wikiSummary = summarizeWikiStatus(wikiBody);
  const proof = {
    compose: {
      ok: compose.ok,
      services,
      stderr: compose.ok ? "" : compose.stderr.trim(),
    },
    endpoints: {
      gateway,
      sentinel,
    },
    environment: proofEnvFacts(runtime.facts, { gatewayPort, sentinelPort }),
    generatedAt: new Date().toISOString(),
    wiki: {
      ok: wikiResult.ok && wikiSummaryReady(wikiSummary),
      stderr: wikiResult.ok ? "" : wikiResult.stderr.trim(),
      summary: wikiSummary,
    },
  };
  const evaluation = evaluateProof(proof);
  return { ...proof, checks: evaluation.checks, ok: evaluation.ok };
}

function summarizeWikiStatus(wikiBody) {
  if (!wikiBody || typeof wikiBody !== "object") {
    return { status: "unavailable" };
  }
  return {
    bridgeEnabled: Boolean(wikiBody.bridge?.enabled),
    bridgePublicArtifactCount:
      wikiBody.bridgePublicArtifactCount ?? wikiBody.bridge?.publicArtifactCount ?? null,
    renderMode: wikiBody.vault?.renderMode ?? wikiBody.renderMode ?? null,
    vaultMode: wikiBody.vault?.mode ?? wikiBody.vaultMode ?? null,
    warningCount: Array.isArray(wikiBody.warnings) ? wikiBody.warnings.length : 0,
  };
}

function ensureArtifactParent(cwd, artifactPath) {
  mkdirSync(path.dirname(path.resolve(cwd, artifactPath)), { recursive: true });
}

function writeJsonArtifact(cwd, artifactPath, payload) {
  ensureArtifactParent(cwd, artifactPath);
  writeFileSync(path.resolve(cwd, artifactPath), `${JSON.stringify(payload, null, 2)}\n`);
}

async function waitForProof(runtime, options = {}) {
  const cwd = options.cwd ?? resolveRepoRoot();
  const timeoutMs = options.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let lastProof = null;

  while (Date.now() <= deadline) {
    lastProof = await collectProof(runtime, { cwd, deadline });
    if (lastProof.ok) {
      return lastProof;
    }
    const sleepMs = Math.min(2_500, Math.max(0, deadline - Date.now()));
    if (sleepMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
  }

  return lastProof ?? (await collectProof(runtime, { cwd, deadline }));
}

function printProofSummary(proof, artifactPath) {
  const verdict = proof.ok ? "ready" : "not ready";
  console.log(`Full local proof: ${verdict}`);
  console.log(`Artifact: ${artifactPath}`);
  for (const check of proof.checks) {
    console.log(`${check.ok ? "OK" : "FAIL"} ${check.name}`);
  }
}

function printRuntimeSummary(runtime) {
  const facts = proofEnvFacts(runtime.facts);
  console.log("Full local runtime:");
  console.log(`- Gateway port: ${facts.gatewayPort}`);
  console.log(`- Sentinel port: ${facts.sentinelPort}`);
  console.log(`- Container config: ${facts.containerConfig}`);
  console.log(`- Gateway auth: ${facts.gatewayAuth}`);
  console.log(`- Gateway token: ${facts.gatewayToken}`);
  console.log(`- Gateway password: ${facts.gatewayPassword}`);
  console.log(`- Sentinel token: ${facts.sentinelToken}`);
  console.log(`- NVIDIA API key: ${facts.nvidiaApiKey}`);
  console.log(`- Custom swarm dir: ${facts.customSwarmDirConfigured ? "present" : "not mounted"}`);
  console.log(`- Native desktop agents: ${facts.nativeAgentCount}`);
}

function extractTicketId(stdout) {
  const match = stdout.match(/Ticket created with id:\s*([A-Za-z0-9-]+)/u);
  return match ? match[1] : null;
}

function parseTicketData(ticket) {
  if (!ticket || typeof ticket !== "object") {
    return null;
  }
  const raw = ticket.data;
  if (raw && typeof raw === "object") {
    return raw;
  }
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function filterStaleFullLocalSmokeTickets(tickets) {
  if (!Array.isArray(tickets)) {
    return [];
  }
  return tickets.filter((ticket) => {
    const status = String(ticket?.status ?? "");
    if (!FULL_LOCAL_STALE_SMOKE_STATUSES.has(status)) {
      return false;
    }
    const data = parseTicketData(ticket);
    return (
      data?.createdBy === FULL_LOCAL_SMOKE_CREATED_BY &&
      typeof data.nonce === "string" &&
      data.nonce.startsWith(FULL_LOCAL_SMOKE_NONCE_PREFIX)
    );
  });
}

function runBlackboardCli(runtime, args, options = {}) {
  return runDockerWithRetries(
    buildComposeArgs([
      "exec",
      "-T",
      "openclaw-signal-hub",
      "node",
      BLACKBOARD_CLI_CONTAINER_PATH,
      ...args,
    ]),
    {
      attempts: options.attempts ?? 5,
      capture: true,
      cwd: options.cwd ?? resolveRepoRoot(),
      env: runtime.env,
      retryDelayMs: options.retryDelayMs ?? 2_000,
      timeoutMs: options.timeoutMs ?? 60_000,
    },
  );
}

function archiveStaleFullLocalSmokeTickets(runtime, options = {}) {
  const cwd = options.cwd ?? resolveRepoRoot();
  const list = runBlackboardCli(runtime, ["list"], {
    attempts: 5,
    cwd,
    timeoutMs: options.timeoutMs ?? 60_000,
  });
  const tickets = list.ok ? extractJson(list.stdout) : null;
  const staleTickets = filterStaleFullLocalSmokeTickets(tickets);
  const archived = [];
  const failed = [];
  for (const ticket of staleTickets) {
    const result = runBlackboardCli(
      runtime,
      ["update", ticket.id, "--status", "ARCHIVED", "--agent", "full-local-smoke"],
      {
        attempts: 3,
        cwd,
        timeoutMs: options.timeoutMs ?? 60_000,
      },
    );
    if (result.ok) {
      archived.push(ticket.id);
    } else {
      failed.push({ id: ticket.id, stderr: result.stderr.trim(), status: result.status });
    }
  }
  return {
    archived,
    failed,
    listOk: list.ok,
    staleCount: staleTickets.length,
  };
}

function ensureBlackboardReady(runtime, options = {}) {
  const cwd = options.cwd ?? resolveRepoRoot();
  return runBlackboardCli(runtime, ["list"], {
    attempts: options.attempts ?? 8,
    cwd,
    retryDelayMs: options.retryDelayMs ?? 2_000,
    timeoutMs: options.timeoutMs ?? 30_000,
  });
}

async function waitForBlackboardReady(runtime, options = {}) {
  const cwd = options.cwd ?? resolveRepoRoot();
  const deadline = options.deadline ?? Date.now() + (options.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
  let last = null;
  while (Date.now() <= deadline) {
    const remaining = Math.max(1_000, deadline - Date.now());
    last = ensureBlackboardReady(runtime, {
      attempts: 1,
      cwd,
      timeoutMs: Math.min(30_000, remaining),
    });
    if (last.ok) {
      return last;
    }
    const sleepMs = Math.min(2_000, Math.max(0, deadline - Date.now()));
    if (sleepMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
  }
  return last ?? ensureBlackboardReady(runtime, { attempts: 1, cwd, timeoutMs: 1_000 });
}

async function runAutonomySmoke(runtime, options = {}) {
  const cwd = options.cwd ?? resolveRepoRoot();
  const artifactPath = options.artifactPath ?? DEFAULT_SMOKE_PATH;
  const staleTickets = archiveStaleFullLocalSmokeTickets(runtime, { cwd });
  const nonce = `${FULL_LOCAL_SMOKE_NONCE_PREFIX}${Date.now()}`;
  const data = JSON.stringify({
    createdBy: FULL_LOCAL_SMOKE_CREATED_BY,
    nonce,
    purpose: "Verify signal-hub routes and claims a Blackboard ticket.",
  });
  const postArgs = [
    "exec",
    "-T",
    "openclaw-signal-hub",
    "node",
    BLACKBOARD_CLI_CONTAINER_PATH,
    "post",
    "--type",
    "autonomy_smoke",
    "--priority",
    "7",
    "--data",
    data,
  ];
  const smokeAgent =
    cleanString(runtime.env.OPENCLAW_FULL_LOCAL_SMOKE_AGENT) ?? DEFAULT_SMOKE_AGENT;
  postArgs.push("--target", smokeAgent);

  const posted = runDockerWithRetries(buildComposeArgs(postArgs), {
    attempts: 5,
    capture: true,
    cwd,
    env: runtime.env,
    retryDelayMs: 2_000,
    timeoutMs: 60_000,
  });
  const ticketId = posted.ok ? extractTicketId(posted.stdout) : null;
  const smoke = {
    generatedAt: new Date().toISOString(),
    nonce,
    post: {
      ok: posted.ok,
      stderr: posted.stderr.trim(),
      ticketId,
    },
    completed: false,
    routed: false,
    staleTickets,
    ticket: null,
  };

  if (!ticketId) {
    writeJsonArtifact(cwd, artifactPath, smoke);
    return { ...smoke, artifactPath, ok: false };
  }

  const deadline =
    Date.now() +
    (options.timeoutMs ??
      parsePositiveInteger(
        runtime.env.OPENCLAW_FULL_LOCAL_SMOKE_TIMEOUT_MS,
        DEFAULT_SMOKE_TIMEOUT_MS,
      ));
  while (Date.now() <= deadline) {
    const get = runDocker(
      buildComposeArgs([
        "exec",
        "-T",
        "openclaw-signal-hub",
        "node",
        BLACKBOARD_CLI_CONTAINER_PATH,
        "get",
        ticketId,
      ]),
      {
        capture: true,
        cwd,
        env: runtime.env,
        timeoutMs: 30_000,
      },
    );
    const ticket = extractJson(get.stdout);
    if (ticket && typeof ticket === "object") {
      smoke.ticket = {
        claimedBy: ticket.claimed_by ?? null,
        id: ticket.id,
        status: ticket.status,
        targetAgent: ticket.target_agent ?? null,
      };
      if (ticket.claimed_by || ["CLAIMED", "IN_PROGRESS", "DONE"].includes(String(ticket.status))) {
        smoke.routed = true;
      }
      if (String(ticket.status) === "DONE") {
        smoke.completed = true;
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  writeJsonArtifact(cwd, artifactPath, smoke);
  return { ...smoke, artifactPath, ok: smoke.completed };
}

function collectBlackboardTicket(runtime, ticketId, options = {}) {
  const cwd = options.cwd ?? resolveRepoRoot();
  const get = runBlackboardCli(runtime, ["get", ticketId], {
    attempts: options.attempts ?? 5,
    cwd,
    timeoutMs: options.timeoutMs ?? 30_000,
  });
  const ticket = get.ok ? extractJson(get.stdout) : null;
  return {
    ok: get.ok && Boolean(ticket?.id),
    status: get.status,
    stderr: get.ok ? "" : get.stderr.trim(),
    ticket,
  };
}

function collectBlackboardProofEvents(runtime, ticketId, options = {}) {
  const cwd = options.cwd ?? resolveRepoRoot();
  const limit = String(options.limit ?? 100);
  const list = runBlackboardCli(runtime, ["proof-list", ticketId, "--limit", limit], {
    attempts: options.attempts ?? 5,
    cwd,
    timeoutMs: options.timeoutMs ?? 30_000,
  });
  const events = list.ok ? extractJson(list.stdout) : null;
  return {
    events: Array.isArray(events) ? events : [],
    ok: list.ok && Array.isArray(events),
    status: list.status,
    stderr: list.ok ? "" : list.stderr.trim(),
  };
}

function removeFileIfPresent(filePath) {
  try {
    if (!existsSync(filePath)) {
      return { ok: true, removed: false };
    }
    rmSync(filePath, { force: true });
    return { ok: true, removed: true };
  } catch (error) {
    return {
      ok: false,
      removed: false,
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

function pruneCheckpointedWalFiles(dbPath, checkpoint) {
  const busy = Array.isArray(checkpoint)
    ? checkpoint.some((row) => Number(row?.busy ?? 0) > 0)
    : false;
  const walPath = `${dbPath}-wal`;
  const shmPath = `${dbPath}-shm`;
  const result = {
    removed: [],
    skipped: [],
    warnings: [],
  };
  if (busy) {
    result.skipped.push("busy-checkpoint");
    return result;
  }
  const walSize = existsSync(walPath) ? statSync(walPath).size : 0;
  if (walSize === 0) {
    const removedWal = removeFileIfPresent(walPath);
    if (removedWal.ok && removedWal.removed) {
      result.removed.push("swarm_blackboard.db-wal");
    } else if (!removedWal.ok) {
      result.warnings.push(removedWal.stderr);
    }
  } else {
    result.skipped.push("non-empty-wal");
  }
  const removedShm = removeFileIfPresent(shmPath);
  if (removedShm.ok && removedShm.removed) {
    result.removed.push("swarm_blackboard.db-shm");
  } else if (!removedShm.ok) {
    result.warnings.push(removedShm.stderr);
  }
  return result;
}

function checkpointHostBlackboardDb(runtime, options = {}) {
  const cwd = options.cwd ?? resolveRepoRoot();
  const configDir =
    cleanString(runtime?.facts?.configDir) ??
    path.dirname(resolveOpenClawConfigPath(runtime?.env ?? {}, os.homedir(), cwd));
  const dbPath = path.join(configDir, "swarm_blackboard.db");
  if (!existsSync(dbPath)) {
    return {
      database: "swarm_blackboard.db",
      ok: false,
      stderr: "host Blackboard database is missing",
    };
  }
  let conn = null;
  try {
    const { DatabaseSync } = require("node:sqlite");
    const journalMode = normalizeBlackboardJournalMode(runtime?.env?.SWARM_BLACKBOARD_JOURNAL_MODE);
    conn = new DatabaseSync(dbPath);
    conn.exec("PRAGMA busy_timeout = 5000;");
    const checkpoint = conn.prepare("PRAGMA wal_checkpoint(TRUNCATE);").all();
    const journal = conn.prepare(`PRAGMA journal_mode = ${journalMode};`).get();
    conn.close();
    conn = null;
    return {
      checkpoint,
      database: "swarm_blackboard.db",
      journal,
      journalMode,
      ok: true,
      walFiles: pruneCheckpointedWalFiles(dbPath, checkpoint),
    };
  } catch (error) {
    return {
      database: "swarm_blackboard.db",
      ok: false,
      stderr: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      conn?.close?.();
    } catch {}
  }
}

function restartFullLocalSignalHub(runtime, options = {}) {
  const cwd = options.cwd ?? resolveRepoRoot();
  const windowsNodeStop = stopWindowsNativeNode(runtime, { cwd });
  if (!windowsNodeStop.ok) {
    return {
      checkpoint: null,
      ok: false,
      start: null,
      status: null,
      stderr: windowsNodeStop.error,
      stop: null,
      windowsNodeStop,
    };
  }
  const stop = runDockerWithRetries(buildComposeArgs(["stop", "openclaw-signal-hub"]), {
    attempts: options.attempts ?? 3,
    capture: true,
    cwd,
    env: runtime.env,
    retryDelayMs: options.retryDelayMs ?? 2_000,
    timeoutMs: options.timeoutMs ?? 120_000,
  });
  if (!stop.ok) {
    return {
      checkpoint: null,
      ok: false,
      start: null,
      status: stop.status,
      stderr: stop.stderr.trim(),
      stop: {
        ok: false,
        status: stop.status,
        stderr: stop.stderr.trim(),
      },
      windowsNodeStop,
    };
  }
  const checkpoint = checkpointHostBlackboardDb(runtime, { cwd });
  const start = runDockerWithRetries(buildComposeArgs(["up", "-d", "openclaw-signal-hub"]), {
    attempts: options.attempts ?? 3,
    capture: true,
    cwd,
    env: runtime.env,
    retryDelayMs: options.retryDelayMs ?? 2_000,
    timeoutMs: options.timeoutMs ?? 120_000,
  });
  return {
    checkpoint,
    ok: checkpoint.ok && start.ok,
    start: {
      ok: start.ok,
      status: start.status,
      stderr: start.ok ? "" : start.stderr.trim(),
      stdout: start.stdout.trim(),
    },
    status: start.status,
    stderr: start.ok ? (checkpoint.ok ? "" : checkpoint.stderr) : start.stderr.trim(),
    stop: {
      ok: true,
      status: stop.status,
      stderr: "",
      stdout: stop.stdout.trim(),
    },
    windowsNodeStop,
  };
}

function goldenProofEvents(proof) {
  return [
    ...(Array.isArray(proof?.proofEventsBeforeRestart?.events)
      ? proof.proofEventsBeforeRestart.events
      : []),
    ...(Array.isArray(proof?.proofEventsAfterRestart?.events)
      ? proof.proofEventsAfterRestart.events
      : []),
  ];
}

function eventHasProofContract(event) {
  return event?.agent_os?.schemaVersion === "agent-os.proof-event.v1";
}

function eventHasTicketContract(event) {
  return event?.payload?.agentOsTicket?.schemaVersion === "agent-os.ticket.v1";
}

export function evaluateAgentOsGoldenE2E(proof) {
  const ticketId = proof?.ticketId || proof?.smoke?.post?.ticketId || proof?.smoke?.ticket?.id;
  const beforeTicket = proof?.ticketBeforeRestart?.ticket;
  const afterTicket = proof?.ticketAfterRestart?.ticket;
  const events = goldenProofEvents(proof);
  const eventsAfterRestart = Array.isArray(proof?.proofEventsAfterRestart?.events)
    ? proof.proofEventsAfterRestart.events
    : [];
  const checks = [
    { name: "ticket accepted", ok: Boolean(ticketId && proof?.smoke?.post?.ok) },
    { name: "ticket routed", ok: Boolean(proof?.smoke?.routed) },
    {
      name: "ticket completed",
      ok: Boolean(proof?.smoke?.completed && beforeTicket?.status === "DONE"),
    },
    { name: "proof events listed", ok: events.length > 0 },
    { name: "proof event contract", ok: events.some(eventHasProofContract) },
    { name: "ticket contract in proof", ok: events.some(eventHasTicketContract) },
    {
      name: "artifact contract",
      ok: Boolean(
        proof?.artifactContract?.schemaVersion === "agent-os.artifact.v1" &&
        proof.artifactContract.path,
      ),
    },
    { name: "signal-hub restarted", ok: Boolean(proof?.restart?.ok) },
    { name: "blackboard ready after restart", ok: Boolean(proof?.blackboardAfterRestart?.ok) },
    { name: "readiness proof after restart", ok: Boolean(proof?.readinessAfterRestart?.ok) },
    {
      name: "ticket survived restart",
      ok: afterTicket?.id === ticketId && afterTicket?.status === "DONE",
    },
    { name: "proof survived restart", ok: eventsAfterRestart.length > 0 },
  ];
  return { checks, ok: checks.every((check) => check.ok) };
}

async function runAgentOsGoldenE2E(runtime, options = {}) {
  const cwd = options.cwd ?? resolveRepoRoot();
  const artifactPath =
    options.artifactPath ??
    cleanString(runtime.env.OPENCLAW_FULL_LOCAL_GOLDEN_E2E_PATH) ??
    DEFAULT_GOLDEN_E2E_PATH;
  const runId = `${FULL_LOCAL_GOLDEN_E2E_RUN_ID_PREFIX}${Date.now()}`;
  const smoke = await runAutonomySmoke(runtime, {
    cwd,
    timeoutMs: parsePositiveInteger(
      runtime.env.OPENCLAW_FULL_LOCAL_GOLDEN_E2E_TIMEOUT_MS,
      DEFAULT_GOLDEN_E2E_TIMEOUT_MS,
    ),
  });
  const ticketId = smoke.post?.ticketId ?? smoke.ticket?.id ?? null;
  const ticketBeforeRestart = ticketId
    ? collectBlackboardTicket(runtime, ticketId, { cwd })
    : { ok: false, stderr: "ticket id missing", ticket: null };
  const proofEventsBeforeRestart = ticketId
    ? collectBlackboardProofEvents(runtime, ticketId, { cwd, limit: 100 })
    : { events: [], ok: false, stderr: "ticket id missing" };
  const restart = restartFullLocalSignalHub(runtime, { cwd });
  const blackboardAfterRestart = restart.ok
    ? await waitForBlackboardReady(runtime, {
        cwd,
        timeoutMs: parsePositiveInteger(
          runtime.env.OPENCLAW_FULL_LOCAL_READY_TIMEOUT_MS,
          DEFAULT_READY_TIMEOUT_MS,
        ),
      })
    : { ok: false, stderr: restart.stderr };
  const readinessAfterRestart = blackboardAfterRestart.ok
    ? await waitForProof(runtime, {
        cwd,
        timeoutMs: parsePositiveInteger(
          runtime.env.OPENCLAW_FULL_LOCAL_READY_TIMEOUT_MS,
          DEFAULT_READY_TIMEOUT_MS,
        ),
      })
    : { checks: [], ok: false };
  const ticketAfterRestart =
    ticketId && blackboardAfterRestart.ok
      ? collectBlackboardTicket(runtime, ticketId, { cwd })
      : { ok: false, stderr: "blackboard unavailable after restart", ticket: null };
  const proofEventsAfterRestart =
    ticketId && blackboardAfterRestart.ok
      ? collectBlackboardProofEvents(runtime, ticketId, { cwd, limit: 100 })
      : { events: [], ok: false, stderr: "blackboard unavailable after restart" };
  const windowsNodeAfterRestart = blackboardAfterRestart.ok
    ? startWindowsNativeNode(runtime, { cwd })
    : { ok: false, skipped: true, reason: "blackboard-unavailable-after-restart" };
  const artifactContract = normalizeAgentOsArtifactContract({
    createdBy: FULL_LOCAL_SMOKE_CREATED_BY,
    id: runId,
    kind: "agent-os-golden-e2e",
    mediaType: "application/json",
    path: artifactPath,
    redaction: { status: "not-needed" },
    runId,
    ticketId,
    visibility: "local",
  });
  const proof = {
    artifactContract,
    generatedAt: new Date().toISOString(),
    proofEventsAfterRestart,
    proofEventsBeforeRestart,
    blackboardAfterRestart: {
      ok: Boolean(blackboardAfterRestart.ok),
      status: blackboardAfterRestart.status ?? null,
      stderr: blackboardAfterRestart.ok ? "" : (blackboardAfterRestart.stderr ?? "").trim(),
    },
    readinessAfterRestart,
    restart,
    runId,
    schemaVersion: "agent-os.golden-e2e.v1",
    smoke,
    ticketAfterRestart,
    ticketBeforeRestart,
    ticketId,
    windowsNodeAfterRestart,
  };
  const evaluation = evaluateAgentOsGoldenE2E(proof);
  const result = { ...proof, checks: evaluation.checks, ok: evaluation.ok };
  writeJsonArtifact(cwd, artifactPath, result);
  return { ...result, artifactPath };
}

async function runSentinelModelProof(runtime, options = {}) {
  const cwd = options.cwd ?? resolveRepoRoot();
  const artifactPath =
    cleanString(runtime.env.OPENCLAW_FULL_LOCAL_SENTINEL_PROOF_PATH) ?? DEFAULT_SENTINEL_PROOF_PATH;
  const model =
    cleanString(runtime.env.OPENCLAW_FULL_LOCAL_SENTINEL_MODEL) ?? DEFAULT_SENTINEL_MODEL;
  const prompt =
    cleanString(runtime.env.OPENCLAW_FULL_LOCAL_SENTINEL_PROMPT) ?? DEFAULT_SENTINEL_PROMPT;
  const sentinelModelNames = [
    model,
    ...(model.startsWith("nvidia/") ? [model.slice("nvidia/".length)] : []),
  ];
  const since = new Date(Date.now() - 5_000).toISOString();
  const result = runGatewayOpenClawWithRetries(
    runtime,
    ["infer", "model", "run", "--gateway", "--model", model, "--prompt", prompt, "--json"],
    {
      attempts: 2,
      capture: true,
      cwd,
      timeoutMs: parsePositiveInteger(runtime.env.OPENCLAW_FULL_LOCAL_SENTINEL_TIMEOUT_MS, 240_000),
    },
  );
  const body = extractJson(result.stdout);
  const logs = runDocker(buildComposeArgs(["logs", "--since", since, "openclaw-sentinel"]), {
    capture: true,
    cwd,
    env: runtime.env,
    timeoutMs: 30_000,
  });
  const routed = sentinelModelNames.some((modelName) =>
    logs.stdout.includes(`Routing ${modelName} via cached Sentinel key.`),
  );
  const outputText = Array.isArray(body?.outputs) ? (body.outputs[0]?.text ?? "") : "";
  const proof = {
    gateway: {
      model: body?.model ?? null,
      ok: result.ok && body?.ok === true,
      outputContainsSmokeToken: String(outputText).includes("sentinel-smoke-ok"),
      provider: body?.provider ?? null,
      stderr: result.ok ? "" : result.stderr.trim(),
    },
    generatedAt: new Date().toISOString(),
    model,
    sentinel: {
      routed,
      sentinelModelNames,
    },
  };
  const fullProof = { ...proof, ok: evaluateSentinelModelProof(proof) };
  writeJsonArtifact(cwd, artifactPath, fullProof);
  return { ...fullProof, artifactPath };
}

function payloadContains(value, needle) {
  return JSON.stringify(value ?? "").includes(needle);
}

export function buildFullLocalMemorySeedScript() {
  return [
    "const fs=require('fs'),path=require('path'),JSON5=require('json5');",
    `const INCLUDE_KEY=${JSON.stringify(INCLUDE_KEY)},MAX_INCLUDE_DEPTH=${MAX_INCLUDE_DEPTH};`,
    "const plain=(value)=>value&&typeof value==='object'&&!Array.isArray(value);",
    "const inside=(root,candidate)=>{const rel=path.relative(path.resolve(root),path.resolve(candidate));return rel===''||(rel.length>0&&!rel.startsWith('..')&&!path.isAbsolute(rel));};",
    "const merge=(target,source)=>{if(Array.isArray(target)&&Array.isArray(source))return [...target,...source];if(plain(target)&&plain(source)){const result={...target};for(const [key,value] of Object.entries(source)){if(key==='__proto__'||key==='constructor'||key==='prototype')continue;result[key]=key in result?merge(result[key],value):value;}return result;}return source;};",
    "const configPath=process.env.OPENCLAW_CONFIG_PATH;",
    "const roots=[path.dirname(configPath||'.'),...(process.env.OPENCLAW_INCLUDE_ROOTS||'').split(path.delimiter).filter(Boolean)].map((entry)=>path.resolve(entry));",
    "const includePath=(entry,basePath)=>{const resolved=path.normalize(path.isAbsolute(entry)?entry:path.resolve(path.dirname(basePath),entry));if(!roots.some((root)=>inside(root,resolved)))throw new Error('Config include escapes allowed roots: '+entry);return resolved;};",
    "const resolveIncludes=(value,basePath,depth,seen)=>{if(Array.isArray(value))return value.map((item)=>resolveIncludes(item,basePath,depth,seen));if(!plain(value))return value;if(!(INCLUDE_KEY in value))return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,resolveIncludes(item,basePath,depth,seen)]));const includeItems=Array.isArray(value[INCLUDE_KEY])?value[INCLUDE_KEY]:[value[INCLUDE_KEY]];let included={};for(const includeItem of includeItems){if(typeof includeItem!=='string'||includeItem.trim().length===0)throw new Error('Invalid config '+INCLUDE_KEY+' entry.');if(depth>=MAX_INCLUDE_DEPTH)throw new Error('Maximum config include depth exceeded: '+includeItem);const resolved=includePath(includeItem,basePath);if(seen.has(resolved))throw new Error('Circular config include detected: '+resolved);const parsed=JSON5.parse(fs.readFileSync(resolved,'utf8'));included=merge(included,resolveIncludes(parsed,resolved,depth+1,new Set([...seen,resolved])));}const rest=Object.fromEntries(Object.entries(value).filter(([key])=>key!==INCLUDE_KEY).map(([key,item])=>[key,resolveIncludes(item,basePath,depth,seen)]));return Object.keys(rest).length>0?merge(included,rest):included;};",
    "let cfg={};",
    "try{cfg=resolveIncludes(JSON5.parse(fs.readFileSync(configPath,'utf8')),configPath,0,new Set([path.normalize(configPath)]));}catch(error){console.error(error instanceof Error?error.message:String(error));process.exit(1);}",
    "const agents=cfg.agents||{};",
    "const list=Array.isArray(agents.list)?agents.list:[];",
    "const main=list.find((a)=>a&&a.id==='main')||list.find((a)=>a&&a.default)||{};",
    "const root=main.workspace||agents.defaults?.workspace||process.env.OPENCLAW_WORKSPACE_DIR||'/home/node/.openclaw/workspace';",
    "const file=path.join(root,'memory','full-local-proof.md');",
    "fs.mkdirSync(path.dirname(file),{recursive:true});",
    "fs.writeFileSync(file,process.env.OPENCLAW_FULL_LOCAL_MEMORY_PROOF_CONTENT+'\\n');",
    "console.log(JSON.stringify({relativePath:'memory/full-local-proof.md',workspace:root}));",
  ].join(" ");
}

async function runMemoryObsidianProof(runtime, options = {}) {
  const cwd = options.cwd ?? resolveRepoRoot();
  const artifactPath =
    cleanString(runtime.env.OPENCLAW_FULL_LOCAL_MEMORY_PROOF_PATH) ?? DEFAULT_MEMORY_PROOF_PATH;
  const nonce = `full-local-memory-${Date.now()}`;
  const content = [
    "# Full Local Proof",
    "",
    `nonce: ${nonce}`,
    `generatedAt: ${new Date().toISOString()}`,
    "",
    "OpenClaw full-local memory, bridge, and Obsidian-render proof.",
    "",
  ].join("\n");
  const memoryWikiCommandTimeoutMs = resolveMemoryWikiCommandTimeoutMs(runtime.env);
  const seed = runGatewayNode(runtime, ["node", "-e", buildFullLocalMemorySeedScript()], {
    capture: true,
    cwd,
    execEnv: {
      OPENCLAW_FULL_LOCAL_MEMORY_PROOF_CONTENT: content,
    },
    timeoutMs: 30_000,
  });
  const seedBody = extractJson(seed.stdout);
  const index = runGatewayOpenClawWithRetries(
    runtime,
    ["memory", "index", "--agent", "main", "--force"],
    {
      attempts: 3,
      capture: true,
      cwd,
      timeoutMs: 120_000,
    },
  );
  const memorySearch = runGatewayOpenClawWithRetries(
    runtime,
    ["memory", "search", nonce, "--agent", "main", "--json", "--max-results", "5"],
    {
      attempts: 3,
      capture: true,
      cwd,
      timeoutMs: 120_000,
    },
  );
  const memorySearchBody = extractJson(memorySearch.stdout);
  const bridgeImport = runGatewayOpenClawWithRetries(
    runtime,
    ["wiki", "bridge", "import", "--json"],
    {
      attempts: 4,
      capture: true,
      cwd,
      timeoutMs: memoryWikiCommandTimeoutMs,
    },
  );
  const bridgeBody = extractJson(bridgeImport.stdout);
  const compile = runGatewayOpenClawWithRetries(runtime, ["wiki", "compile", "--json"], {
    attempts: 3,
    capture: true,
    cwd,
    timeoutMs: memoryWikiCommandTimeoutMs,
  });
  const compileBody = extractJson(compile.stdout);
  const wikiSearch = runGatewayOpenClawWithRetries(
    runtime,
    ["wiki", "search", nonce, "--json", "--max-results", "5", "--corpus", "all"],
    {
      attempts: 3,
      capture: true,
      cwd,
      timeoutMs: memoryWikiCommandTimeoutMs,
    },
  );
  const wikiSearchBody = extractJson(wikiSearch.stdout);
  const wikiStatus = runGatewayOpenClawWithRetries(runtime, ["wiki", "status", "--json"], {
    attempts: 5,
    capture: true,
    cwd,
    retryDelayMs: 3_000,
    timeoutMs: memoryWikiCommandTimeoutMs,
  });
  const wikiStatusBody = extractJson(wikiStatus.stdout);
  const obsidianStatus = runGatewayOpenClawWithRetries(
    runtime,
    ["wiki", "obsidian", "status", "--json"],
    {
      attempts: 3,
      capture: true,
      cwd,
      timeoutMs: 60_000,
    },
  );
  const obsidianBody = extractJson(obsidianStatus.stdout);
  const proof = {
    generatedAt: new Date().toISOString(),
    nonce,
    seed: {
      ok: seed.ok && seedBody?.relativePath === "memory/full-local-proof.md",
      relativePath: seedBody?.relativePath ?? null,
      stderr: seed.ok ? "" : seed.stderr.trim(),
    },
    memory: {
      indexed: index.ok,
      searchHit: memorySearch.ok && payloadContains(memorySearchBody, nonce),
      attempts: {
        index: index.attempts ?? 1,
        search: memorySearch.attempts ?? 1,
      },
      stderr: index.ok && memorySearch.ok ? "" : `${index.stderr}\n${memorySearch.stderr}`.trim(),
    },
    bridge: {
      attempts: bridgeImport.attempts ?? 1,
      artifactCount: bridgeBody?.artifactCount ?? null,
      importedCount: bridgeBody?.importedCount ?? null,
      pagePaths: Array.isArray(bridgeBody?.pagePaths) ? bridgeBody.pagePaths : [],
      stderr: bridgeImport.ok ? "" : bridgeImport.stderr.trim(),
      synced:
        bridgeImport.ok &&
        Number.isInteger(bridgeBody?.artifactCount) &&
        bridgeBody.artifactCount > 0,
    },
    compile: {
      attempts: compile.attempts ?? 1,
      ok: compile.ok && Boolean(compileBody),
      stderr: compile.ok ? "" : compile.stderr.trim(),
    },
    wiki: {
      attempts: {
        search: wikiSearch.attempts ?? 1,
        status: wikiStatus.attempts ?? 1,
      },
      searchHit: wikiSearch.ok && payloadContains(wikiSearchBody, nonce),
      status: summarizeWikiStatus(wikiStatusBody),
    },
    obsidian: {
      attempts: obsidianStatus.attempts ?? 1,
      ok: obsidianStatus.ok && Boolean(obsidianBody),
      renderMode: wikiStatusBody?.renderMode ?? wikiStatusBody?.vault?.renderMode ?? null,
      sourceBridgePages: wikiStatusBody?.sourceCounts?.bridge ?? null,
    },
  };
  const fullProof = {
    ...proof,
    ok:
      proof.seed.ok &&
      proof.memory.indexed &&
      proof.memory.searchHit &&
      proof.bridge.synced &&
      proof.compile.ok &&
      proof.wiki.searchHit &&
      proof.obsidian.ok &&
      proof.obsidian.renderMode === "obsidian" &&
      Number(proof.obsidian.sourceBridgePages ?? 0) > 0,
  };
  writeJsonArtifact(cwd, artifactPath, fullProof);
  return { ...fullProof, artifactPath };
}

function summarizeCommandError(result) {
  const stderr = cleanString(result?.stderr);
  if (!stderr) {
    return null;
  }
  return stderr.split(/\r?\n/u).filter(Boolean).slice(0, 3);
}

export function evaluateSentinelModelProof(proof) {
  return Boolean(
    proof?.gateway?.ok && proof.gateway.outputContainsSmokeToken && proof?.sentinel?.routed,
  );
}

async function benchmarkTask(name, run) {
  const startedAt = Date.now();
  try {
    const result = await run();
    return {
      durationMs: Date.now() - startedAt,
      name,
      ok: Boolean(result.ok),
      retries: result.retries ?? 0,
      toolErrors: result.toolErrors ?? [],
    };
  } catch (error) {
    return {
      durationMs: Date.now() - startedAt,
      name,
      ok: false,
      retries: 0,
      toolErrors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

async function runBenchmarkGauntlet(runtime, options = {}) {
  const cwd = options.cwd ?? resolveRepoRoot();
  const artifactPath =
    cleanString(runtime.env.OPENCLAW_FULL_LOCAL_BENCHMARK_PATH) ?? DEFAULT_BENCHMARK_PATH;
  const tasks = [];
  tasks.push(
    await benchmarkTask("readiness-proof", async () => {
      const proof = await collectProof(runtime, { cwd });
      return { ok: proof.ok, toolErrors: proof.ok ? [] : proof.checks.filter((c) => !c.ok) };
    }),
  );
  tasks.push(await benchmarkTask("autonomy-smoke", () => runAutonomySmoke(runtime, { cwd })));
  tasks.push(
    await benchmarkTask("memory-obsidian", () => runMemoryObsidianProof(runtime, { cwd })),
  );
  tasks.push(
    await benchmarkTask("wiki-search", async () => {
      const result = runGatewayOpenClawWithRetries(
        runtime,
        ["wiki", "search", "full-local memory bridge proof", "--json", "--max-results", "5"],
        { attempts: 3, capture: true, cwd, timeoutMs: 90_000 },
      );
      return {
        ok: result.ok && Boolean(extractJson(result.stdout)),
        toolErrors: summarizeCommandError(result) ?? [],
      };
    }),
  );
  tasks.push(await benchmarkTask("sentinel-model", () => runSentinelModelProof(runtime, { cwd })));
  const ok = tasks.every((task) => task.ok);
  const completed = tasks.filter((task) => task.ok).length;
  const failed = tasks.length - completed;
  const benchmark = {
    completed,
    failed,
    generatedAt: new Date().toISOString(),
    ok,
    taskCount: tasks.length,
    tasks,
    totals: {
      latencyMs: tasks.reduce((sum, task) => sum + task.durationMs, 0),
      retries: tasks.reduce((sum, task) => sum + task.retries, 0),
      toolErrors: tasks.reduce((sum, task) => sum + task.toolErrors.length, 0),
    },
  };
  writeJsonArtifact(cwd, artifactPath, benchmark);
  return { ...benchmark, artifactPath };
}

function showHelp() {
  console.log(`Usage: node scripts/docker/full-local.mjs <command>

Commands:
  up       Start Gateway, Sentinel, signal hub, memory wiki syncer, and CLI helper; wait for proof.
  proof    Write a machine-readable readiness proof without changing state.
  smoke    Post a low-impact Blackboard ticket and wait for signal-hub to claim it.
  golden   Run Agent OS E2E: ticket, route, proof, artifact contract, restart survival.
  sentinel Run a real Gateway model request through openclaw-sentinel.
  memory   Seed active memory, import it into memory-wiki, and verify Obsidian render mode.
  bench    Run a five-task full-local benchmark gauntlet.
  status   Print the same readiness proof checks without starting services.
  down     Stop the full-local compose stack without deleting volumes.

Useful env:
  OPENCLAW_GATEWAY_TOKEN                 Gateway shared-secret token.
  OPENCLAW_SENTINEL_TOKEN                Sentinel inbound token. Defaults to NVIDIA provider apiKey when present.
  OPENCLAW_SENTINEL_PORT                 Host Sentinel port. Defaults to 18888 or next free port.
  OPENCLAW_FULL_LOCAL_SKIP_BUILD=1       Do not pass --build to docker compose up.
  OPENCLAW_MEMORY_WIKI_GATEWAY_TIMEOUT_MS Timeout for active memory-wiki Gateway calls.
  OPENCLAW_FULL_LOCAL_RESEED_NVIDIA_VAULT=1 Replace the Sentinel vault from current NVIDIA env keys.
  OPENCLAW_FULL_LOCAL_SENTINEL_MODEL     Model for the live Sentinel model proof.
  OPENCLAW_FULL_LOCAL_SMOKE_AGENT=<id>   Force the autonomy smoke ticket target agent (default: main).
  OPENCLAW_FULL_LOCAL_SMOKE_TIMEOUT_MS   End-to-end autonomy smoke timeout (default: 240000).
  OPENCLAW_FULL_LOCAL_GOLDEN_E2E_PATH    Artifact path for the Agent OS golden E2E proof.
  OPENCLAW_FULL_LOCAL_GOLDEN_E2E_TIMEOUT_MS Golden ticket timeout (default: 600000).
  OPENCLAW_FULL_LOCAL_SKIP_MOUNT_REPAIR=1 Skip bind-mount ownership repair after Compose starts.
  OPENCLAW_FULL_LOCAL_SKIP_PYTHON_MCP_PREPARE=1 Skip Python MCP venv preparation after Compose starts.
  OPENCLAW_FULL_LOCAL_PYTHON_MCP_PREPARE_TIMEOUT_MS Timeout for each Python MCP venv prepare.
  OPENCLAW_FULL_LOCAL_SKIP_WINDOWS_NODE=1 Skip the Windows-native desktop agent bridge.
  OPENCLAW_FULL_LOCAL_USE_RAW_CONFIG=1   Disable the generated container config overlay.
`);
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0] ?? "help";
  const cwd = resolveRepoRoot();

  if (command === "help" || command === "--help" || command === "-h") {
    showHelp();
    return 0;
  }

  if (command === "down") {
    const runtimeForStop = {
      env: process.env,
      facts: {
        configDir: path.dirname(resolveOpenClawConfigPath(process.env, os.homedir(), cwd)),
      },
    };
    stopWindowsNativeNode(runtimeForStop, { cwd });
    const down = runDocker(buildComposeArgs(["down"]), { cwd });
    return down.status ?? 1;
  }

  const readOnlyProofCommand = command === "proof" || command === "status";
  const runtime = await deriveFullLocalRuntime({
    cwd,
    writeContainerConfigOverlay: !readOnlyProofCommand,
  });
  reuseExistingPublishedPorts(runtime, cwd);

  if (command === "up") {
    const vaultSeed = seedNvidiaVaultFromRuntime(runtime);
    runtime.facts.nvidiaVaultKeyCount = vaultSeed.keyCount;
    runtime.facts.nvidiaApiKeyConfigured =
      runtime.facts.nvidiaSeedKeysConfigured || vaultSeed.keyCount > 0;
    const validationErrors = validateFullLocalRuntime(runtime.facts, runtime.env);
    if (validationErrors.length > 0) {
      for (const error of validationErrors) {
        console.error(`ERROR: ${error}`);
      }
      return 1;
    }
    if (vaultSeed.seeded) {
      console.log(`Seeded Sentinel NVIDIA vault with ${vaultSeed.keyCount} key(s).`);
    }

    printRuntimeSummary(runtime);
    const stoppedWindowsNode = stopWindowsNativeNode(runtime, { cwd });
    if (!stoppedWindowsNode.ok) {
      console.error(
        `ERROR: failed to stop previous Windows-native agent bridge: ${stoppedWindowsNode.error}`,
      );
      return 1;
    }
    if (!stoppedWindowsNode.skipped) {
      console.log(`Stopped previous Windows-native agent bridge pid ${stoppedWindowsNode.pid}.`);
    }

    const blackboardPrep = checkpointHostBlackboardDb(runtime, { cwd });
    if (blackboardPrep.ok) {
      console.log(`Prepared host Blackboard database journal=${blackboardPrep.journalMode}.`);
    } else if (blackboardPrep.stderr !== "host Blackboard database is missing") {
      console.warn(`WARN: host Blackboard database preparation failed: ${blackboardPrep.stderr}`);
    }

    const up = runDocker(buildUpArgs(runtime.env), { cwd, env: runtime.env });
    if (!up.ok) {
      return up.status ?? 1;
    }

    const mountRepair = repairFullLocalMountPermissions(runtime, { cwd });
    if (!mountRepair.ok) {
      console.warn("WARN: full-local mount permission repair did not complete cleanly.");
      for (const repair of mountRepair.repairs) {
        if (repair.ok) {
          continue;
        }
        console.warn(`WARN: ${repair.service}: ${repair.stderr || `status ${repair.status}`}`);
      }
      if (asBoolean(runtime.env.OPENCLAW_FULL_LOCAL_STRICT_MOUNT_REPAIR)) {
        return 1;
      }
    }

    const pythonMcpPrep = prepareFullLocalPythonMcpEnvironments(runtime, { cwd });
    if (pythonMcpPrep.prepared.length > 0) {
      console.log(
        `Prepared ${pythonMcpPrep.prepared.filter((entry) => entry.ok).length}/${
          pythonMcpPrep.prepared.length
        } Python MCP environment(s).`,
      );
    }
    if (!pythonMcpPrep.ok) {
      for (const entry of pythonMcpPrep.prepared) {
        if (entry.ok) {
          continue;
        }
        console.warn(
          `WARN: Python MCP preparation failed for ${entry.scriptPath}: ${
            entry.stderr || `status ${entry.status}`
          }`,
        );
      }
    }

    const readyTimeoutMs = parsePositiveInteger(
      runtime.env.OPENCLAW_FULL_LOCAL_READY_TIMEOUT_MS,
      DEFAULT_READY_TIMEOUT_MS,
    );
    const readyDeadline = Date.now() + readyTimeoutMs;
    const blackboard = await waitForBlackboardReady(runtime, { cwd, deadline: readyDeadline });
    if (!blackboard.ok) {
      console.error("ERROR: signal hub Blackboard database is unavailable.");
      const detail = summarizeCommandError(blackboard);
      if (detail) {
        for (const line of detail) {
          console.error(line);
        }
      }
      return blackboard.status ?? 1;
    }

    const windowsNode = startWindowsNativeNode(runtime, { cwd });
    if (windowsNode.ok && !windowsNode.skipped) {
      console.log(
        `Started Windows-native agent bridge for ${runtime.facts.nativeAgentIds.length} native agent(s).`,
      );
    } else if (!windowsNode.ok) {
      console.warn(`WARN: failed to start Windows-native agent bridge: ${windowsNode.error}`);
    }

    const staleTickets = archiveStaleFullLocalSmokeTickets(runtime, { cwd });
    if (staleTickets.archived.length > 0) {
      console.log(
        `Archived ${staleTickets.archived.length} stale full-local smoke ticket(s) before readiness proof.`,
      );
    }
    if (staleTickets.failed.length > 0) {
      console.warn(
        `WARN: failed to archive ${staleTickets.failed.length} stale full-local smoke ticket(s).`,
      );
    }

    const artifactPath =
      cleanString(runtime.env.OPENCLAW_FULL_LOCAL_PROOF_PATH) ?? DEFAULT_PROOF_PATH;
    const proof = await waitForProof(runtime, {
      cwd,
      timeoutMs: Math.max(1_000, readyDeadline - Date.now()),
    });
    writeJsonArtifact(cwd, artifactPath, proof);
    printProofSummary(proof, artifactPath);
    return proof.ok ? 0 : 1;
  }

  if (command === "proof" || command === "status") {
    const artifactPath =
      cleanString(runtime.env.OPENCLAW_FULL_LOCAL_PROOF_PATH) ?? DEFAULT_PROOF_PATH;
    const proof = await collectProof(runtime, { cwd });
    writeJsonArtifact(cwd, artifactPath, proof);
    printProofSummary(proof, artifactPath);
    return proof.ok ? 0 : 1;
  }

  if (command === "smoke") {
    const smoke = await runAutonomySmoke(runtime, { cwd });
    console.log(`Autonomy smoke: ${smoke.ok ? "completed" : "not completed"}`);
    console.log(`Artifact: ${smoke.artifactPath}`);
    if (smoke.ticket?.id) {
      console.log(`Ticket: ${smoke.ticket.id} status=${smoke.ticket.status}`);
    }
    return smoke.ok ? 0 : 1;
  }

  if (command === "golden" || command === "golden-e2e") {
    const golden = await runAgentOsGoldenE2E(runtime, { cwd });
    console.log(`Agent OS golden E2E: ${golden.ok ? "passed" : "failed"}`);
    console.log(`Artifact: ${golden.artifactPath}`);
    if (golden.ticketId) {
      console.log(`Ticket: ${golden.ticketId}`);
    }
    for (const check of golden.checks) {
      console.log(`${check.ok ? "OK" : "FAIL"} ${check.name}`);
    }
    return golden.ok ? 0 : 1;
  }

  if (command === "sentinel") {
    const proof = await runSentinelModelProof(runtime, { cwd });
    console.log(`Sentinel model proof: ${proof.ok ? "routed" : "not routed"}`);
    console.log(`Artifact: ${proof.artifactPath}`);
    console.log(`Model: ${proof.model}`);
    return proof.ok ? 0 : 1;
  }

  if (command === "memory") {
    const proof = await runMemoryObsidianProof(runtime, { cwd });
    console.log(`Memory/Obsidian proof: ${proof.ok ? "synced" : "not synced"}`);
    console.log(`Artifact: ${proof.artifactPath}`);
    console.log(`Bridge artifacts: ${proof.bridge.artifactCount ?? "unknown"}`);
    return proof.ok ? 0 : 1;
  }

  if (command === "bench" || command === "benchmark") {
    const benchmark = await runBenchmarkGauntlet(runtime, { cwd });
    console.log(`Benchmark gauntlet: ${benchmark.ok ? "passed" : "failed"}`);
    console.log(`Artifact: ${benchmark.artifactPath}`);
    console.log(
      `Tasks: ${benchmark.completed}/${benchmark.taskCount} ok, latency=${benchmark.totals.latencyMs}ms, toolErrors=${benchmark.totals.toolErrors}`,
    );
    return benchmark.ok ? 0 : 1;
  }

  console.error(`Unknown command: ${command}`);
  showHelp();
  return 1;
}

const entrypointUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypointUrl && import.meta.url === entrypointUrl) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
