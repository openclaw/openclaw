import fsSync from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { resolveAcpxPluginRoot } from "./config.js";
import type { ResolvedAcpxPluginConfig } from "./config.js";

const CODEX_ACP_PACKAGE = "@zed-industries/codex-acp";
const CODEX_ACP_BIN = "codex-acp";
const CLAUDE_ACP_PACKAGE = "@agentclientprotocol/claude-agent-acp";
const CLAUDE_ACP_BIN = "claude-agent-acp";
const RUN_CONFIGURED_COMMAND_SENTINEL = "--openclaw-run-configured";
const requireFromHere = createRequire(import.meta.url);

type PackageManifest = {
  name?: unknown;
  bin?: unknown;
  dependencies?: Record<string, unknown>;
};

function readSelfManifest(): PackageManifest {
  const manifestPath = path.join(resolveAcpxPluginRoot(import.meta.url), "package.json");
  return JSON.parse(fsSync.readFileSync(manifestPath, "utf8")) as PackageManifest;
}

function readManifestDependencyVersion(packageName: string): string {
  const version = readSelfManifest().dependencies?.[packageName];
  if (typeof version !== "string" || version.trim() === "") {
    throw new Error(`Missing ${packageName} dependency version in @openclaw/acpx manifest`);
  }
  return version;
}

const CODEX_ACP_PACKAGE_VERSION = readManifestDependencyVersion(CODEX_ACP_PACKAGE);
const CLAUDE_ACP_PACKAGE_VERSION = readManifestDependencyVersion(CLAUDE_ACP_PACKAGE);

function quoteCommandPart(value: string): string {
  return JSON.stringify(value);
}

function splitCommandParts(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const ch of value) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (escaping) {
    current += "\\";
  }
  if (current) {
    parts.push(current);
  }
  return parts;
}

function basename(value: string): string {
  return value.split(/[\\/]/).pop() ?? value;
}

function resolvePackageBinPath(
  packageJsonPath: string,
  manifest: PackageManifest,
  binName: string,
): string | undefined {
  const { bin } = manifest;
  const relativeBinPath =
    typeof bin === "string"
      ? bin
      : bin && typeof bin === "object"
        ? (bin as Record<string, unknown>)[binName]
        : undefined;
  if (typeof relativeBinPath !== "string" || relativeBinPath.trim() === "") {
    return undefined;
  }
  return path.resolve(path.dirname(packageJsonPath), relativeBinPath);
}

async function resolveInstalledAcpPackageBinPath(
  packageName: string,
  binName: string,
): Promise<string | undefined> {
  try {
    const packageJsonPath = requireFromHere.resolve(`${packageName}/package.json`);
    const manifest = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as PackageManifest;
    if (manifest.name !== packageName) {
      return undefined;
    }
    const binPath = resolvePackageBinPath(packageJsonPath, manifest, binName);
    if (!binPath) {
      return undefined;
    }
    await fs.access(binPath);
    return binPath;
  } catch {
    return undefined;
  }
}

async function resolveInstalledCodexAcpBinPath(): Promise<string | undefined> {
  // Keep OpenClaw's isolated CODEX_HOME wrapper, but launch the plugin-local
  // Codex ACP adapter when the package dependency is available.
  return await resolveInstalledAcpPackageBinPath(CODEX_ACP_PACKAGE, CODEX_ACP_BIN);
}

async function resolveInstalledClaudeAcpBinPath(): Promise<string | undefined> {
  return await resolveInstalledAcpPackageBinPath(CLAUDE_ACP_PACKAGE, CLAUDE_ACP_BIN);
}

function buildAdapterWrapperScript(params: {
  displayName: string;
  packageSpec: string;
  binName: string;
  installedBinPath?: string;
  envSetup: string;
  beforeLaunch?: string;
  afterLaunch?: string;
}): string {
  return `#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

${params.envSetup}
const configuredArgs = process.argv.slice(2);
${params.beforeLaunch ?? ""}

function resolveNpmCliPath() {
  const candidate = path.resolve(
    path.dirname(process.execPath),
    "..",
    "lib",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  return existsSync(candidate) ? candidate : undefined;
}

const npmCliPath = resolveNpmCliPath();
const installedBinPath = ${params.installedBinPath ? quoteCommandPart(params.installedBinPath) : "undefined"};
let defaultCommand;
let defaultArgs;
if (installedBinPath) {
  defaultCommand = process.execPath;
  defaultArgs = [installedBinPath];
} else if (npmCliPath) {
  defaultCommand = process.execPath;
  defaultArgs = [npmCliPath, "exec", "--yes", "--package", "${params.packageSpec}", "--", "${params.binName}"];
} else {
  defaultCommand = process.platform === "win32" ? "npx.cmd" : "npx";
  defaultArgs = ["--yes", "--package", "${params.packageSpec}", "--", "${params.binName}"];
}
const command =
  configuredArgs[0] === "${RUN_CONFIGURED_COMMAND_SENTINEL}" ? configuredArgs[1] : defaultCommand;
const args =
  configuredArgs[0] === "${RUN_CONFIGURED_COMMAND_SENTINEL}"
    ? configuredArgs.slice(2)
    : [...defaultArgs, ...configuredArgs];

if (!command) {
  console.error("[openclaw] missing configured ${params.displayName} ACP command");
  process.exit(1);
}

const child = spawn(command, args, {
  env,
  stdio: "inherit",
  windowsHide: true,
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    child.kill(signal);
  });
}

child.on("error", (error) => {
  console.error(\`[openclaw] failed to launch ${params.displayName} ACP wrapper: \${error.message}\`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
${params.afterLaunch ?? ""}
  if (code !== null) {
    process.exit(code);
  }
  process.exit(signal ? 1 : 0);
});
`;
}

function buildCodexAcpWrapperScript(installedBinPath?: string): string {
  return buildAdapterWrapperScript({
    displayName: "Codex",
    packageSpec: `${CODEX_ACP_PACKAGE}@${CODEX_ACP_PACKAGE_VERSION}`,
    binName: CODEX_ACP_BIN,
    installedBinPath,
    envSetup: `const codexHome = fileURLToPath(new URL("./codex-home/", import.meta.url));
const env = {
  ...process.env,
  CODEX_HOME: codexHome,
};`,
    beforeLaunch: `const authSyncScript = fileURLToPath(new URL("./sync-codex-auth-from-openclaw.mjs", import.meta.url));
if (existsSync(authSyncScript)) {
  const authSync = spawnSync(process.execPath, [authSyncScript], {
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (authSync.error) {
    console.error(\`[openclaw] failed to sync Docker Codex auth profile: \${authSync.error.message}\`);
    process.exit(1);
  }
  if (authSync.status !== 0) {
    process.exit(authSync.status ?? 1);
  }
}
`,
    afterLaunch: `if (existsSync(authSyncScript)) {
  const authSync = spawnSync(process.execPath, [authSyncScript, "--adopt-codex-auth"], {
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (authSync.error) {
    console.error(\`[openclaw] failed to adopt rotated Docker Codex auth profile: \${authSync.error.message}\`);
  } else if (authSync.status !== 0) {
    console.error("[openclaw] failed to adopt rotated Docker Codex auth profile after Codex ACP exited");
  }
}
`,
  });
}

function buildCodexAuthSyncScript(): string {
  return `#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const baseDir = path.dirname(fileURLToPath(import.meta.url));
const openclawStateDir = path.resolve(baseDir, "..");
const authProfilesPath = path.join(
  openclawStateDir,
  "agents",
  "main",
  "agent",
  "auth-profiles.json",
);
const authStatePath = path.join(
  openclawStateDir,
  "agents",
  "main",
  "agent",
  "auth-state.json",
);
const codexHome = path.join(baseDir, "codex-home");
const codexAuthPath = path.join(codexHome, "auth.json");
const codexConfigPath = path.join(codexHome, "config.toml");
const adoptCodexAuth = process.argv.includes("--adopt-codex-auth");
const authStoreLockOptions = {
  retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 10_000, randomize: true },
  stale: 30_000,
};
const oauthRefreshLockOptions = {
  retries: { retries: 20, factor: 2, minTimeout: 100, maxTimeout: 10_000, randomize: true },
  stale: 180_000,
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function decodeJwtPayload(token) {
  if (typeof token !== "string") return undefined;
  const parts = token.split(".");
  if (parts.length < 3 || !parts[1]) return undefined;
  try {
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

function tokenExpirationSeconds(token) {
  const payload = decodeJwtPayload(token);
  return typeof payload?.exp === "number" ? payload.exp : 0;
}

function tokenExpirationMillis(token, fallback) {
  const seconds = tokenExpirationSeconds(token);
  return seconds > 0 ? seconds * 1000 : fallback;
}

function readExistingCodexAuth() {
  if (!fs.existsSync(codexAuthPath)) return undefined;
  try {
    return readJson(codexAuthPath);
  } catch {
    return undefined;
  }
}

function readOptionalJson(filePath, unreadableMessage) {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    return readJson(filePath);
  } catch {
    if (unreadableMessage) {
      console.error("[openclaw] " + unreadableMessage);
    }
    return undefined;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = path.join(
    path.dirname(filePath),
    "." + path.basename(filePath) + "." + process.pid + "." + Date.now() + ".tmp",
  );
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2) + "\\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tmpPath, filePath);
  } finally {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function computeLockDelayMs(retries, attempt) {
  const base = Math.min(
    retries.maxTimeout,
    Math.max(retries.minTimeout, retries.minTimeout * retries.factor ** attempt),
  );
  const jitter = retries.randomize ? 1 + Math.random() : 1;
  return Math.min(retries.maxTimeout, Math.round(base * jitter));
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function readLockPayload(lockPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (typeof parsed?.pid !== "number" || typeof parsed?.createdAt !== "string") {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function isStaleLock(lockPath, staleMs) {
  const payload = readLockPayload(lockPath);
  if (payload?.pid && !isPidAlive(payload.pid)) return true;
  if (payload?.createdAt) {
    const createdAt = Date.parse(payload.createdAt);
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > staleMs) return true;
  }
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs > staleMs;
  } catch {
    return true;
  }
}

function normalizeLockTargetPath(filePath) {
  const resolved = path.resolve(filePath);
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });
  try {
    return path.join(fs.realpathSync(dir), path.basename(resolved));
  } catch {
    return resolved;
  }
}

function acquireFileLockSync(filePath, options) {
  const normalizedFile = normalizeLockTargetPath(filePath);
  const lockPath = normalizedFile + ".lock";
  for (let attempt = 0; attempt <= options.retries.retries; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeFileSync(
          fd,
          JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2),
          "utf8",
        );
      } catch (writeError) {
        fs.closeSync(fd);
        fs.rmSync(lockPath, { force: true });
        throw writeError;
      }
      return {
        release: () => {
          try {
            fs.closeSync(fd);
          } catch {
            // Best-effort cleanup only.
          }
          try {
            fs.rmSync(lockPath, { force: true });
          } catch {
            // Best-effort cleanup only.
          }
        },
      };
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      if (isStaleLock(lockPath, options.stale)) {
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          // Another process may have removed it first.
        }
        continue;
      }
      if (attempt >= options.retries.retries) break;
      sleepSync(computeLockDelayMs(options.retries, attempt));
    }
  }
  throw new Error("file lock timeout for " + normalizedFile);
}

function withFileLockSync(filePath, options, run) {
  const lock = acquireFileLockSync(filePath, options);
  try {
    return run();
  } finally {
    lock.release();
  }
}

function resolveOAuthRefreshLockPath(provider, profileId) {
  const hash = createHash("sha256");
  hash.update(provider, "utf8");
  hash.update("\\u0000", "utf8");
  hash.update(profileId, "utf8");
  return path.join(openclawStateDir, "locks", "oauth-refresh", "sha256-" + hash.digest("hex"));
}

function selectOpenAiCodexProfile(profilesJson, stateJson) {
  const profiles = profilesJson?.profiles ?? {};
  const preferredId = stateJson?.lastGood?.["openai-codex"];
  if (
    preferredId &&
    profiles[preferredId]?.provider === "openai-codex" &&
    profiles[preferredId]?.type === "oauth"
  ) {
    return [preferredId, profiles[preferredId]];
  }
  return Object.entries(profiles).find(
    ([, profile]) => profile?.provider === "openai-codex" && profile?.type === "oauth",
  );
}

function normalizeEmail(value) {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

function extractOpenAiCodexIdentity(accessToken) {
  const claims = decodeJwtPayload(accessToken);
  const authClaims = claims?.["https://api.openai.com/auth"];
  const profileClaims = claims?.["https://api.openai.com/profile"];
  const accountId =
    typeof authClaims?.chatgpt_account_id === "string" ? authClaims.chatgpt_account_id : undefined;
  if (!accountId) return undefined;
  return {
    accountId,
    email: typeof profileClaims?.email === "string" ? profileClaims.email : undefined,
    chatgptPlanType:
      typeof authClaims?.chatgpt_plan_type === "string"
        ? authClaims.chatgpt_plan_type
        : undefined,
  };
}

function codexAuthToCredential(codexAuth, existingProfile) {
  const tokens = codexAuth?.tokens;
  const access = tokens?.access_token;
  const refresh = tokens?.refresh_token;
  const tokenAccountId = tokens?.account_id;
  if (
    codexAuth?.auth_mode !== "chatgpt" ||
    typeof access !== "string" ||
    !access ||
    typeof refresh !== "string" ||
    !refresh ||
    typeof tokenAccountId !== "string" ||
    !tokenAccountId
  ) {
    return undefined;
  }
  const identity = extractOpenAiCodexIdentity(access);
  if (!identity || identity.accountId !== tokenAccountId) return undefined;
  const idToken = typeof tokens?.id_token === "string" && tokens.id_token ? tokens.id_token : undefined;
  return {
    ...existingProfile,
    type: "oauth",
    provider: "openai-codex",
    access,
    refresh,
    expires: tokenExpirationMillis(access, Date.now() + 60 * 60 * 1000),
    email: identity.email ?? existingProfile?.email,
    accountId: identity.accountId,
    chatgptPlanType: identity.chatgptPlanType ?? existingProfile?.chatgptPlanType,
    ...(idToken ? { idToken } : {}),
  };
}

function findProfileForCodexCredential(profilesJson, stateJson, credential) {
  const preferred = selectOpenAiCodexProfile(profilesJson, stateJson);
  if (preferred?.[1]?.accountId === credential.accountId) {
    return preferred;
  }
  return Object.entries(profilesJson?.profiles ?? {}).find(
    ([, profile]) =>
      profile?.type === "oauth" &&
      profile?.provider === "openai-codex" &&
      profile?.accountId === credential.accountId,
  );
}

function hasCompatibleProfileIdentity(profile, credential) {
  if (profile?.provider !== "openai-codex" || profile?.type !== "oauth") return false;
  if (profile.accountId && profile.accountId !== credential.accountId) return false;
  const profileEmail = normalizeEmail(profile.email);
  const credentialEmail = normalizeEmail(credential.email);
  return !(profileEmail && credentialEmail && profileEmail !== credentialEmail);
}

function shouldAdoptCodexCredential(profile, credential, options = {}) {
  if (!hasCompatibleProfileIdentity(profile, credential)) return false;
  if (profile.access === credential.access && profile.refresh === credential.refresh) return false;
  const profileExpires = tokenExpirationMillis(
    profile.access,
    Number.isFinite(profile.expires) ? profile.expires : 0,
  );
  if (credential.expires < profileExpires && !options.allowRefreshRotation) return false;
  return true;
}

function adoptCodexAuthIntoOpenClaw(profilesJson, stateJson, options = {}) {
  const codexAuth = readExistingCodexAuth();
  const credential = codexAuthToCredential(codexAuth);
  if (!credential) {
    if (!options.quiet) {
      keepExisting("no complete isolated Codex ACP web-login OAuth auth found to adopt");
    }
    return false;
  }
  const selected = findProfileForCodexCredential(profilesJson, stateJson, credential);
  if (!selected) {
    if (!options.quiet) {
      keepExisting("no matching Docker OpenClaw openai-codex profile found for isolated Codex ACP auth");
    }
    return false;
  }
  const [profileId] = selected;
  const refreshLockPath = resolveOAuthRefreshLockPath("openai-codex", profileId);
  return withFileLockSync(refreshLockPath, oauthRefreshLockOptions, () =>
    withFileLockSync(authProfilesPath, authStoreLockOptions, () => {
      const lockedProfilesJson = readOptionalJson(
        authProfilesPath,
        "could not reread Docker OpenClaw auth profiles while adopting isolated Codex ACP auth",
      );
      const lockedStateJson = readOptionalJson(
        authStatePath,
        "ignored unreadable Docker OpenClaw auth state while adopting isolated Codex ACP auth",
      );
      const lockedSelected = findProfileForCodexCredential(
        lockedProfilesJson,
        lockedStateJson,
        credential,
      );
      if (!lockedSelected || lockedSelected[0] !== profileId) return false;
      const lockedProfile = lockedSelected[1];
      const updatedCredential = codexAuthToCredential(codexAuth, lockedProfile);
      if (
        !updatedCredential ||
        !shouldAdoptCodexCredential(lockedProfile, updatedCredential, {
          allowRefreshRotation: options.allowRefreshRotation === true,
        })
      ) {
        return false;
      }
      lockedProfilesJson.profiles[profileId] = updatedCredential;
      writeJsonAtomic(authProfilesPath, lockedProfilesJson);
      console.error(
        "[openclaw] adopted rotated isolated Codex ACP auth into Docker OpenClaw profile " +
          profileId,
      );
      return true;
    }),
  );
}

function ensureConfigUsesFileAuth() {
  const existing = fs.existsSync(codexConfigPath)
    ? fs.readFileSync(codexConfigPath, "utf8")
    : "# Generated by OpenClaw for Codex ACP sessions.\\n";
  if (/^\\s*cli_auth_credentials_store\\s*=\\s*"file"\\s*$/m.test(existing)) return;
  const withoutOtherSetting = existing.replace(
    /^\\s*cli_auth_credentials_store\\s*=.*(?:\\r?\\n)?/gm,
    "",
  );
  fs.writeFileSync(
    codexConfigPath,
    withoutOtherSetting.trimEnd() + '\\ncli_auth_credentials_store = "file"\\n',
    { encoding: "utf8", mode: 0o600 },
  );
}

function keepExisting(message, profileId) {
  ensureConfigUsesFileAuth();
  const suffix = profileId ? " for Docker profile " + profileId : "";
  console.error("[openclaw] " + message + suffix);
  process.exit(0);
}

fs.mkdirSync(codexHome, { recursive: true });
ensureConfigUsesFileAuth();

if (!fs.existsSync(authProfilesPath)) {
  keepExisting("no Docker OpenClaw openai-codex auth profile found; using existing Codex ACP auth if present");
}

let profilesJson;
try {
  profilesJson = readJson(authProfilesPath);
} catch {
  keepExisting("could not read Docker OpenClaw auth profiles; using existing Codex ACP auth if present");
}
let stateJson = readOptionalJson(
  authStatePath,
  "ignored unreadable Docker OpenClaw auth state; selecting first openai-codex profile",
);

if (adoptCodexAuth) {
  adoptCodexAuthIntoOpenClaw(profilesJson, stateJson, { allowRefreshRotation: true });
  process.exit(0);
}

try {
  if (adoptCodexAuthIntoOpenClaw(profilesJson, stateJson, { quiet: true })) {
    profilesJson = readJson(authProfilesPath);
    stateJson = readOptionalJson(
      authStatePath,
      "ignored unreadable Docker OpenClaw auth state; selecting first openai-codex profile",
    );
  }
} catch (err) {
  console.error(
    "[openclaw] could not adopt existing isolated Codex ACP auth before launch: " +
      (err?.message ?? String(err)),
  );
}

const selected = selectOpenAiCodexProfile(profilesJson, stateJson);

if (!selected) {
  keepExisting("no Docker OpenClaw openai-codex auth profile found; using existing Codex ACP auth if present");
}

const [profileId, profile] = selected;
if (!profile.access || !profile.refresh || !profile.accountId) {
  keepExisting("Docker OpenClaw openai-codex profile is incomplete; using existing Codex ACP auth if present", profileId);
}

const accessClaims = decodeJwtPayload(profile.access);
if (!accessClaims?.["https://api.openai.com/auth"]?.chatgpt_account_id) {
  keepExisting("Docker OpenClaw openai-codex access token is not a ChatGPT JWT; using existing Codex ACP auth if present", profileId);
}

const existingAuth = readExistingCodexAuth();
const existingAccountId = existingAuth?.tokens?.account_id;
const existingAccess = existingAuth?.tokens?.access_token;
const existingRefresh = existingAuth?.tokens?.refresh_token;
const existingAccessExp = tokenExpirationSeconds(existingAccess);
const profileAccessExp = tokenExpirationSeconds(profile.access);

if (
  existingAuth?.auth_mode === "chatgpt" &&
  existingAccountId === profile.accountId &&
  typeof existingRefresh === "string" &&
  existingRefresh &&
  existingAccessExp >= profileAccessExp
) {
  keepExisting("kept existing isolated Codex ACP auth", profileId);
}

const authJson = {
  auth_mode: "chatgpt",
  tokens: {
    id_token: profile.access,
    access_token: profile.access,
    refresh_token: profile.refresh,
    account_id: profile.accountId,
  },
  last_refresh: new Date().toISOString(),
};

fs.writeFileSync(codexAuthPath, JSON.stringify(authJson, null, 2) + "\\n", {
  encoding: "utf8",
  mode: 0o600,
});

console.error(
  "[openclaw] synced Docker OpenClaw auth profile " +
    profileId +
    " to isolated Codex ACP home",
);
`;
}

function buildClaudeAcpWrapperScript(installedBinPath?: string): string {
  return buildAdapterWrapperScript({
    displayName: "Claude",
    // This package is patched in OpenClaw; fallback must not float to an unpatched newer release.
    packageSpec: `${CLAUDE_ACP_PACKAGE}@${CLAUDE_ACP_PACKAGE_VERSION}`,
    binName: CLAUDE_ACP_BIN,
    installedBinPath,
    envSetup: `const env = {
  ...process.env,
};`,
  });
}

async function prepareIsolatedCodexHome(baseDir: string): Promise<string> {
  const codexHome = path.join(baseDir, "codex-home");
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(
    path.join(codexHome, "config.toml"),
    '# Generated by OpenClaw for Codex ACP sessions.\ncli_auth_credentials_store = "file"\n',
    "utf8",
  );
  return codexHome;
}

async function makeGeneratedWrapperExecutableIfPossible(wrapperPath: string): Promise<void> {
  try {
    await fs.chmod(wrapperPath, 0o755);
  } catch {
    // The wrapper is invoked via `node wrapper.mjs`; executable mode is only a convenience.
  }
}

async function writeCodexAcpWrapper(baseDir: string, installedBinPath?: string): Promise<string> {
  await fs.mkdir(baseDir, { recursive: true });
  const wrapperPath = path.join(baseDir, "codex-acp-wrapper.mjs");
  await fs.writeFile(wrapperPath, buildCodexAcpWrapperScript(installedBinPath), {
    encoding: "utf8",
  });
  await makeGeneratedWrapperExecutableIfPossible(wrapperPath);
  return wrapperPath;
}

async function writeCodexAuthSyncScript(baseDir: string): Promise<string> {
  await fs.mkdir(baseDir, { recursive: true });
  const syncPath = path.join(baseDir, "sync-codex-auth-from-openclaw.mjs");
  await fs.writeFile(syncPath, buildCodexAuthSyncScript(), { encoding: "utf8" });
  await makeGeneratedWrapperExecutableIfPossible(syncPath);
  return syncPath;
}

async function writeClaudeAcpWrapper(baseDir: string, installedBinPath?: string): Promise<string> {
  await fs.mkdir(baseDir, { recursive: true });
  const wrapperPath = path.join(baseDir, "claude-agent-acp-wrapper.mjs");
  await fs.writeFile(wrapperPath, buildClaudeAcpWrapperScript(installedBinPath), {
    encoding: "utf8",
  });
  await makeGeneratedWrapperExecutableIfPossible(wrapperPath);
  return wrapperPath;
}

function buildWrapperCommand(wrapperPath: string, args: string[] = []): string {
  return [process.execPath, wrapperPath, ...args].map(quoteCommandPart).join(" ");
}

function isAcpPackageSpec(value: string, packageName: string): boolean {
  const escapedPackageName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escapedPackageName}(?:@.+)?$`, "i").test(value.trim());
}

function isAcpBinName(value: string, binName: string): boolean {
  const commandName = basename(value);
  const escapedBinName = binName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escapedBinName}(?:\\.exe|\\.[cm]?js)?$`, "i").test(commandName);
}

function isPackageRunnerCommand(value: string): boolean {
  return /^(?:npx|npm|pnpm|bunx)(?:\.cmd|\.exe)?$/i.test(basename(value));
}

function extractConfiguredAdapterArgs(params: {
  configuredCommand?: string;
  packageName: string;
  binName: string;
}): string[] | undefined {
  const trimmedConfiguredCommand = params.configuredCommand?.trim();
  if (!trimmedConfiguredCommand) {
    return [];
  }
  const parts = splitCommandParts(trimmedConfiguredCommand);
  if (!parts.length) {
    return [];
  }

  const packageIndex = parts.findIndex((part) => isAcpPackageSpec(part, params.packageName));
  if (packageIndex >= 0) {
    if (!isPackageRunnerCommand(parts[0] ?? "")) {
      return undefined;
    }
    const afterPackage = parts.slice(packageIndex + 1);
    if (afterPackage[0] === "--" && isAcpBinName(afterPackage[1] ?? "", params.binName)) {
      return afterPackage.slice(2);
    }
    if (isAcpBinName(afterPackage[0] ?? "", params.binName)) {
      return afterPackage.slice(1);
    }
    return afterPackage[0] === "--" ? afterPackage.slice(1) : afterPackage;
  }

  if (isAcpBinName(parts[0] ?? "", params.binName)) {
    return parts.slice(1);
  }
  if (basename(parts[0] ?? "") === "node" && isAcpBinName(parts[1] ?? "", params.binName)) {
    return parts.slice(2);
  }

  return undefined;
}

function buildCodexAcpWrapperCommand(wrapperPath: string, configuredCommand?: string): string {
  const configuredAdapterArgs = extractConfiguredAdapterArgs({
    configuredCommand,
    packageName: CODEX_ACP_PACKAGE,
    binName: CODEX_ACP_BIN,
  });
  if (configuredAdapterArgs) {
    return buildWrapperCommand(wrapperPath, configuredAdapterArgs);
  }
  return buildWrapperCommand(wrapperPath, [
    RUN_CONFIGURED_COMMAND_SENTINEL,
    ...splitCommandParts(configuredCommand?.trim() ?? ""),
  ]);
}

function buildClaudeAcpWrapperCommand(wrapperPath: string, configuredCommand?: string): string {
  const configuredAdapterArgs = extractConfiguredAdapterArgs({
    configuredCommand,
    packageName: CLAUDE_ACP_PACKAGE,
    binName: CLAUDE_ACP_BIN,
  });
  if (configuredAdapterArgs) {
    return buildWrapperCommand(wrapperPath, configuredAdapterArgs);
  }
  return configuredCommand?.trim() || buildWrapperCommand(wrapperPath);
}

export async function prepareAcpxCodexAuthConfig(params: {
  pluginConfig: ResolvedAcpxPluginConfig;
  stateDir: string;
  logger?: unknown;
  resolveInstalledCodexAcpBinPath?: () => Promise<string | undefined>;
  resolveInstalledClaudeAcpBinPath?: () => Promise<string | undefined>;
}): Promise<ResolvedAcpxPluginConfig> {
  void params.logger;
  const codexBaseDir = path.join(params.stateDir, "acpx");
  await prepareIsolatedCodexHome(codexBaseDir);
  await writeCodexAuthSyncScript(codexBaseDir);
  const installedCodexBinPath = await (
    params.resolveInstalledCodexAcpBinPath ?? resolveInstalledCodexAcpBinPath
  )();
  const installedClaudeBinPath = await (
    params.resolveInstalledClaudeAcpBinPath ?? resolveInstalledClaudeAcpBinPath
  )();
  const wrapperPath = await writeCodexAcpWrapper(codexBaseDir, installedCodexBinPath);
  const claudeWrapperPath = await writeClaudeAcpWrapper(codexBaseDir, installedClaudeBinPath);
  const configuredCodexCommand = params.pluginConfig.agents.codex;
  const configuredClaudeCommand = params.pluginConfig.agents.claude;

  return {
    ...params.pluginConfig,
    agents: {
      ...params.pluginConfig.agents,
      codex: buildCodexAcpWrapperCommand(wrapperPath, configuredCodexCommand),
      claude: buildClaudeAcpWrapperCommand(claudeWrapperPath, configuredClaudeCommand),
    },
  };
}
