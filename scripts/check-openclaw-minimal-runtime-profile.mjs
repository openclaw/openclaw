import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PROFILE_PATH = "config/openclaw-minimal-runtime-profile.json";

const REQUIRED_SURFACES = new Map([
  ["gateway", "src/gateway"],
  ["session", "src/config/sessions"],
  ["diagnostics", "src/infra/diagnostic-events.ts"],
  ["controlled-runner", "scripts/openclaw-controlled-task-runner.mjs"],
]);

const REQUIRED_DISABLED_SURFACES = new Set([
  "browser-control",
  "global-codex-skills",
  "live-model-api",
  "live-trading",
  "message-channels",
]);

const REQUIRED_SKIP_ENV = new Map([
  ["OPENCLAW_DISABLE_BONJOUR", "1"],
  ["OPENCLAW_SKIP_BROWSER_CONTROL_SERVER", "1"],
  ["OPENCLAW_SKIP_CANVAS_HOST", "1"],
  ["OPENCLAW_SKIP_CHANNELS", "1"],
  ["OPENCLAW_SKIP_GMAIL_WATCHER", "1"],
  ["OPENCLAW_SKIP_PROVIDERS", "1"],
]);

const REQUIRED_SAFETY_FALSE_FLAGS = [
  "externalApi",
  "globalSkillDependency",
  "liveTrading",
  "writesOutsideRepo",
];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toRepoPath(filePath) {
  return filePath.split(path.sep).join("/");
}

async function pathExists(repoRoot, relativePath) {
  try {
    await fs.stat(path.join(repoRoot, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function readProfile(repoRoot, profilePath) {
  const absolutePath = path.join(repoRoot, profilePath);
  const text = await fs.readFile(absolutePath, "utf8");
  return JSON.parse(text);
}

function buildCheck(id, status, message, extra = {}) {
  return {
    id,
    status,
    message,
    ...extra,
  };
}

function collectShapeChecks(profile) {
  const checks = [];
  checks.push(
    buildCheck(
      "profile-id",
      profile.profileId === "openclaw-minimal-runtime" ? "pass" : "fail",
      "profileId must be openclaw-minimal-runtime",
    ),
  );
  checks.push(
    buildCheck(
      "schema-version",
      profile.schemaVersion === 1 ? "pass" : "fail",
      "schemaVersion must be 1",
    ),
  );
  checks.push(
    buildCheck(
      "offline-mode",
      profile.mode === "local-offline" ? "pass" : "fail",
      "mode must be local-offline",
    ),
  );
  return checks;
}

async function collectSurfaceChecks(repoRoot, profile) {
  const checks = [];
  const surfaces = Array.isArray(profile.requiredSurfaces) ? profile.requiredSurfaces : [];
  for (const [id, expectedPath] of REQUIRED_SURFACES) {
    const surface = surfaces.find((entry) => isRecord(entry) && entry.id === id);
    const pathMatches = surface?.path === expectedPath;
    const exists = pathMatches ? await pathExists(repoRoot, expectedPath) : false;
    checks.push(
      buildCheck(
        `surface-${id}`,
        pathMatches && exists ? "pass" : "fail",
        pathMatches && exists
          ? `Found ${expectedPath}`
          : `Required surface ${id} must point to ${expectedPath}`,
        { path: expectedPath },
      ),
    );
  }
  return checks;
}

function collectDisabledSurfaceChecks(profile) {
  const disabled = new Set(
    Array.isArray(profile.disabledExternalSurfaces) ? profile.disabledExternalSurfaces : [],
  );
  return [...REQUIRED_DISABLED_SURFACES].map((id) =>
    buildCheck(
      `disabled-${id}`,
      disabled.has(id) ? "pass" : "fail",
      disabled.has(id)
        ? `Disabled external surface: ${id}`
        : `Missing disabled external surface: ${id}`,
    ),
  );
}

function collectRuntimeEnvChecks(profile) {
  const env = isRecord(profile.runtimeEnv) ? profile.runtimeEnv : {};
  return [...REQUIRED_SKIP_ENV].map(([key, expected]) =>
    buildCheck(
      `env-${key}`,
      env[key] === expected ? "pass" : "fail",
      env[key] === expected ? `${key}=${expected}` : `${key} must be ${expected}`,
    ),
  );
}

function collectSafetyChecks(profile) {
  const safety = isRecord(profile.safety) ? profile.safety : {};
  return REQUIRED_SAFETY_FALSE_FLAGS.map((key) =>
    buildCheck(
      `safety-${key}`,
      safety[key] === false ? "pass" : "fail",
      safety[key] === false ? `${key}=false` : `${key} must be false`,
    ),
  );
}

function collectValidationChecks(profile) {
  const validation = Array.isArray(profile.validation) ? profile.validation : [];
  return [
    buildCheck(
      "validation-profile-check",
      validation.includes("node scripts/check-openclaw-minimal-runtime-profile.mjs --check")
        ? "pass"
        : "fail",
      "validation must include the profile check script",
    ),
    buildCheck(
      "validation-autonomous-inventory",
      validation.includes("pnpm autonomous:inventory:check") ? "pass" : "fail",
      "validation must include pnpm autonomous:inventory:check",
    ),
  ];
}

export async function collectMinimalRuntimeProfileReport(options = {}) {
  const repoRoot =
    options.repoRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const profilePath = options.profilePath ?? DEFAULT_PROFILE_PATH;
  const profile = await readProfile(repoRoot, profilePath);
  if (!isRecord(profile)) {
    return {
      profilePath,
      ok: false,
      checks: [buildCheck("profile-json", "fail", "profile JSON must be an object")],
    };
  }
  const checks = [
    buildCheck("profile-json", "pass", "profile JSON is an object"),
    ...collectShapeChecks(profile),
    ...(await collectSurfaceChecks(repoRoot, profile)),
    ...collectDisabledSurfaceChecks(profile),
    ...collectRuntimeEnvChecks(profile),
    ...collectSafetyChecks(profile),
    ...collectValidationChecks(profile),
  ];
  return {
    profilePath: toRepoPath(profilePath),
    ok: checks.every((check) => check.status === "pass"),
    checks,
  };
}

export async function runMinimalRuntimeProfileCheck(options = {}) {
  const io = options.io ?? {
    stdout: process.stdout,
    stderr: process.stderr,
  };
  const report = await collectMinimalRuntimeProfileReport(options);
  io.stdout.write(
    `OpenClaw minimal runtime profile: ${report.ok ? "PASS" : "FAIL"} (${report.profilePath})\n`,
  );
  for (const check of report.checks) {
    io.stdout.write(`[${check.status.toUpperCase()}] ${check.id} - ${check.message}\n`);
  }
  if (!report.ok) {
    io.stderr.write("minimal runtime profile check failed\n");
    return 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode = await runMinimalRuntimeProfileCheck();
  process.exitCode = exitCode;
}
