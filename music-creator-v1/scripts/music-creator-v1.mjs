#!/usr/bin/env node
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT = process.cwd();
const BASE = path.join(ROOT, "music-creator-v1");
const PROJECTS_DIR = path.join(BASE, "projects");
const STATE_DIR = path.join(BASE, "state");
const AUTOMATION_DIR = path.join(BASE, "automation");
const CATALOG_PATH = path.join(STATE_DIR, "catalog.json");
const LATEST_HEALTH_PATH = path.join(STATE_DIR, "latest-health.json");
const LATEST_DOCTOR_PATH = path.join(STATE_DIR, "latest-doctor.json");
const LATEST_BRIDGE_STATUS_PATH = path.join(STATE_DIR, "latest-bridge-status.json");
const LATEST_BRIDGE_SYNC_PATH = path.join(STATE_DIR, "latest-bridge-sync.json");
const LATEST_BRIDGE_TRANSFER_PATH = path.join(STATE_DIR, "latest-bridge-transfer-kit.json");
const PROVIDER_SETUP_PATH = path.join(STATE_DIR, "provider-readiness.json");
const PROVIDER_ENV_TEMPLATE_PATH = path.join(AUTOMATION_DIR, "provider-env.template");
const MACBOOK_REMOTE_EXEC_KEY_PATH = path.join(STATE_DIR, "macbook-remote-exec_ed25519");
const BRIDGE_SIGNING_KEY_PATH = path.join(STATE_DIR, "garageband-bridge-signing-key.pem");
const BRIDGE_SIGNING_PUBLIC_KEY_PATH = path.join(
  STATE_DIR,
  "garageband-bridge-signing-key.pub.pem",
);
const BRIDGE_ROOT_NAME = "OpenClaw-GarageBand-Bridge";
const BRIDGE_TRANSFER_KITS_DIR = path.join(STATE_DIR, "bridge-transfer-kits");

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".flac", ".m4a", ".ogg", ".aiff", ".aif"]);
const BRIDGE_AGENT_ACTIONS = new Set([
  "health-check",
  "garageband-status",
  "list-bridge-files",
  "open-latest-bridge-job",
  "open-bridge-job",
]);
const PROVIDER_ENV_KEYS = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "MINIMAX_API_KEY",
  "COMFY_API_KEY",
  "COMFY_CLOUD_API_KEY",
  "KITS_API_KEY",
];

const KITS_API_BASE = "https://arpeggi.io/api/kits/v1";

const STATUSES = {
  DRAFT_CREATED: "draft_created",
  GENERATION_PLANNED: "generation_planned",
  CANDIDATE_INGESTED: "candidate_ingested",
  QA_FAILED: "qa_failed",
  QA_PASSED: "qa_passed",
  SELECTED: "selected",
  PUBLISH_BLOCKED: "publish_blocked",
  PUBLISH_READY: "publish_ready",
};

function nowIso() {
  return new Date().toISOString();
}

function slugify(value) {
  const slug = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "music-request";
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function readJsonOptional(file, fallback) {
  try {
    return await readJson(file);
  } catch {
    return fallback;
  }
}

async function writeText(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text.endsWith("\n") ? text : `${text}\n`, "utf8");
}

async function writeJson(file, value) {
  await writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function commandAvailable(command) {
  try {
    await execFileAsync("zsh", ["-lc", `command -v ${command}`], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function runCommand(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      timeout: options.timeoutMs ?? 30000,
      maxBuffer: options.maxBuffer ?? 1024 * 1024 * 8,
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? error.message ?? String(error),
    };
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  const parsed = text ? tryParseJson(text) : null;
  if (!response.ok) {
    const message = parsed?.message ?? parsed?.error ?? text ?? response.statusText;
    throw new Error(`HTTP ${response.status}: ${message}`);
  }
  return parsed;
}

function kitsHeaders(extra = {}) {
  const apiKey = process.env.KITS_API_KEY;
  if (!apiKey) throw new Error("Missing KITS_API_KEY.");
  return { Authorization: `Bearer ${apiKey}`, ...extra };
}

async function localComputerName() {
  const result = await runCommand("scutil", ["--get", "ComputerName"], { timeoutMs: 5000 });
  return result.ok ? result.stdout.trim() : "unknown";
}

async function detectTailnetIp() {
  const result = await runCommand("ifconfig", [], { timeoutMs: 5000, maxBuffer: 1024 * 1024 });
  if (!result.ok) return null;
  const match = result.stdout.match(/\binet (100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+)\b/);
  return match?.[1] ?? null;
}

async function ensureMacBookRemoteExecPublicKey() {
  const publicKeyPath = `${MACBOOK_REMOTE_EXEC_KEY_PATH}.pub`;
  if (!(await exists(MACBOOK_REMOTE_EXEC_KEY_PATH)) || !(await exists(publicKeyPath))) {
    await fs.mkdir(path.dirname(MACBOOK_REMOTE_EXEC_KEY_PATH), { recursive: true });
    const result = await runCommand(
      "ssh-keygen",
      [
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        "openclaw-garageband-bridge",
        "-f",
        MACBOOK_REMOTE_EXEC_KEY_PATH,
      ],
      { timeoutMs: 15000 },
    );
    if (!result.ok) throw new Error(`ssh-keygen failed: ${result.stderr || result.stdout}`);
    await fs.chmod(MACBOOK_REMOTE_EXEC_KEY_PATH, 0o600);
  }
  return {
    privateKeyPath: MACBOOK_REMOTE_EXEC_KEY_PATH,
    publicKeyPath,
    publicKey: (await fs.readFile(publicKeyPath, "utf8")).trim(),
  };
}

async function ensureBridgeSigningPublicKey() {
  if (!(await exists(BRIDGE_SIGNING_KEY_PATH)) || !(await exists(BRIDGE_SIGNING_PUBLIC_KEY_PATH))) {
    await fs.mkdir(path.dirname(BRIDGE_SIGNING_KEY_PATH), { recursive: true });
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 3072,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    await writeText(BRIDGE_SIGNING_KEY_PATH, privateKey);
    await writeText(BRIDGE_SIGNING_PUBLIC_KEY_PATH, publicKey);
    await fs.chmod(BRIDGE_SIGNING_KEY_PATH, 0o600);
  }
  return {
    privateKeyPath: BRIDGE_SIGNING_KEY_PATH,
    publicKeyPath: BRIDGE_SIGNING_PUBLIC_KEY_PATH,
    publicKey: await fs.readFile(BRIDGE_SIGNING_PUBLIC_KEY_PATH, "utf8"),
  };
}

async function signBridgeRequestFile(file) {
  const privateKey = await fs.readFile(BRIDGE_SIGNING_KEY_PATH, "utf8");
  const payload = await fs.readFile(file);
  return crypto.sign("RSA-SHA256", payload, privateKey);
}

async function defaultBridgeRoot() {
  const home = process.env.HOME;
  if (home) {
    const iCloudRoot = path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs");
    if (await exists(iCloudRoot)) return path.join(iCloudRoot, BRIDGE_ROOT_NAME);
    return path.join(home, "Music", BRIDGE_ROOT_NAME);
  }
  return path.join(BASE, "garageband-bridge");
}

async function resolveBridgeRoot(args = {}) {
  return path.resolve(String(args["bridge-root"] ?? (await defaultBridgeRoot())));
}

async function ensureBridgeDirs(bridgeRoot) {
  await fs.mkdir(path.join(bridgeRoot, "to-macbook"), { recursive: true });
  await fs.mkdir(path.join(bridgeRoot, "to-macbook", "requests"), { recursive: true });
  await fs.mkdir(path.join(bridgeRoot, "to-macbook", "requests", "processed"), {
    recursive: true,
  });
  await fs.mkdir(path.join(bridgeRoot, "to-macbook", "requests", "rejected"), {
    recursive: true,
  });
  await fs.mkdir(path.join(bridgeRoot, "from-macbook"), { recursive: true });
  await fs.mkdir(path.join(bridgeRoot, "from-macbook", "inbox"), { recursive: true });
  await fs.mkdir(path.join(bridgeRoot, "from-macbook", "agent-results"), { recursive: true });
  await fs.mkdir(path.join(bridgeRoot, "sync", "mac-studio"), { recursive: true });
  await fs.mkdir(path.join(bridgeRoot, "sync", "macbook"), { recursive: true });
  await fs.mkdir(path.join(bridgeRoot, "logs"), { recursive: true });
}

async function copyIfExists(source, dest) {
  if (!(await exists(source))) return false;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.cp(source, dest, { force: true, recursive: true });
  return true;
}

function safeBridgeFileName(value, fallback = "bridge-transfer-kit") {
  const safe = String(value)
    .replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return safe || fallback;
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function collectStringValues(value, output = []) {
  if (typeof value === "string") {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, output);
    return output;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStringValues(item, output);
  }
  return output;
}

function collectKeyValues(value, keyName, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeyValues(item, keyName, output);
    return output;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === keyName && typeof item === "string" && item.trim()) output.push(item.trim());
      collectKeyValues(item, keyName, output);
    }
  }
  return output;
}

async function resolveAudioPath(candidate) {
  const raw = candidate.replace(/^MEDIA:/, "").trim();
  const cleaned = raw.replace(/^file:\/\//, "");
  const choices = [cleaned, path.resolve(ROOT, cleaned)];
  for (const choice of choices) {
    if (AUDIO_EXTENSIONS.has(path.extname(choice).toLowerCase()) && (await exists(choice))) {
      return path.resolve(choice);
    }
  }
  return null;
}

async function extractExistingAudioPaths(...values) {
  const strings = values.flatMap((value) =>
    typeof value === "string" ? value.split(/\s+/) : collectStringValues(value),
  );
  const paths = [];
  for (const item of strings) {
    const matches = item.match(/MEDIA:[^\s"'`<>]+/g) ?? [];
    const candidates = matches.length > 0 ? matches : [item];
    for (const candidate of candidates) {
      const audioPath = await resolveAudioPath(candidate);
      if (audioPath && !paths.includes(audioPath)) paths.push(audioPath);
    }
  }
  return paths;
}

async function findAudioFiles(dir, output = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await findAudioFiles(file, output);
    else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      output.push(file);
  }
  return output.sort();
}

function providerEnvChecks() {
  return PROVIDER_ENV_KEYS.map((name) => ({ name, present: Boolean(process.env[name]) }));
}

function providerSetupRows() {
  const env = providerEnvChecks();
  const present = (key) => Boolean(env.find((item) => item.name === key)?.present);
  return [
    {
      provider: "Google Lyria",
      envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
      models: ["google/lyria-3-clip-preview"],
      ready: present("GEMINI_API_KEY") || present("GOOGLE_API_KEY"),
    },
    {
      provider: "MiniMax Music",
      envKeys: ["MINIMAX_API_KEY"],
      models: ["minimax/music-2.6"],
      ready: present("MINIMAX_API_KEY"),
    },
    {
      provider: "ComfyUI Music Workflow",
      envKeys: ["COMFY_API_KEY", "COMFY_CLOUD_API_KEY"],
      models: ["comfy/workflow"],
      ready: present("COMFY_API_KEY") || present("COMFY_CLOUD_API_KEY"),
    },
    {
      provider: "Kits AI Royalty-Free Voices",
      envKeys: ["KITS_API_KEY"],
      models: ["kits/voice-conversion"],
      ready: present("KITS_API_KEY"),
    },
  ].map((provider) => ({
    ...provider,
    env: provider.envKeys.map((name) => ({ name, present: present(name) })),
  }));
}

function providerReadinessRecord() {
  const providers = providerSetupRows();
  return {
    schemaVersion: 1,
    checkedAt: nowIso(),
    providerReady: providers.some((provider) => provider.ready),
    providers,
    secretPolicy: "Music Creator V1 records only key presence. It never writes provider secrets.",
    nextActions: [
      "Export one supported provider key in the shell that runs generate-live.",
      "Optionally configure agents.defaults.musicGenerationModel in OpenClaw.",
      "Run provider-setup, then generate-live.",
    ],
  };
}

function providerEnvTemplate() {
  return `# Music Creator V1 provider environment template
# Put real values in a private file outside git, then source that file.
# Do not commit real provider keys.

export GEMINI_API_KEY=""
export GOOGLE_API_KEY=""
export MINIMAX_API_KEY=""
export COMFY_API_KEY=""
export COMFY_CLOUD_API_KEY=""
export KITS_API_KEY=""
`;
}

function macbookSetupMarkdown(bridgeRoot) {
  return `# OpenClaw GarageBand Bridge

Bridge root:

\`\`\`text
${bridgeRoot}
\`\`\`

## Mac Studio

OpenClaw exports selected Music Creator V1 candidates, vocal layers, and source assets into \`to-macbook/\`.

## MacBook

1. Use a bridge folder that syncs both directions between the Mac Studio and MacBook. Different Apple IDs are fine only if the folder is shared with edit access or synced through another trusted tool.
2. Do not enable Remote Login for this bridge. \`macbook-enable-remote-exec.command\` is deprecated and is removed by default by \`bridge-init\`.
3. Run \`macbook-disable-remote-exec.command\` if you previously tested the Remote Login helper. It removes the old OpenClaw SSH key line from \`authorized_keys\` when present and reminds you to keep Remote Login off.
4. First prove sync: on the Mac Studio run \`bridge-sync-probe\`; after the probe syncs to the MacBook, run \`macbook-sync-check.command\`; then run \`bridge-sync-status\` on the Mac Studio.
5. Easiest safe start: run \`macbook-start-safe-bridge.command\`. It blocks if Remote Login is on, writes the sync reply, then processes one signed request.
6. Advanced/manual mode: run \`macbook-pull-agent.command --once\` to process exactly one signed request, or run \`macbook-pull-agent.command\` to keep polling until you close Terminal.
7. The pull agent verifies \`macstudio-bridge-signing.pub.pem\`, rejects expired or unsigned jobs, accepts only whitelisted actions, and never runs arbitrary shell commands.
8. Optional tokenless enrollment: on the Mac Studio, run \`macstudio-open-node-enrollment.command\`; while that short-lived window is open, run \`macbook-pair-openclaw-node-window.command\` on the MacBook.
9. Token fallback: run \`macbook-pair-openclaw-node.command\` on the MacBook and paste the Mac Studio Gateway token locally when prompted.
10. Run \`macbook-finish-setup.command\` to install/open GarageBand, install Valhalla Supermassive, validate the AU plugin, and write setup status back to \`from-macbook/\`.
11. To process Mac Studio jobs safely, queue a signed request on the Mac Studio with \`bridge-queue-job\`, then let the MacBook pull agent handle it.
12. To send an existing GarageBand bounce, stem, song, or vocal idea to OpenClaw, run \`macbook-send-audio-to-openclaw.command\`.

GarageBand App Store install, admin approval for system AU plugins, OpenClaw node service installation, project creation, and final bounce/export can require local UI action. The bridge keeps those manual points explicit instead of pretending they are fully autonomous.
`;
}

function macbookOpenLatestCommand() {
  return `#!/bin/zsh
set -euo pipefail

BRIDGE_ROOT="\${0:A:h}"
LATEST="\$(ls -td "\${BRIDGE_ROOT}"/to-macbook/*(/N) 2>/dev/null | head -n 1)"

if [[ -z "\${LATEST}" ]]; then
  echo "No GarageBand bridge jobs found in \${BRIDGE_ROOT}/to-macbook"
  exit 1
fi

exec "\${LATEST}/open-in-garageband.command"
`;
}

function macbookSendAudioCommand() {
  return `#!/bin/zsh
set -euo pipefail

BRIDGE_ROOT="\${0:A:h}"
SOURCE_FILE="$(osascript -e 'POSIX path of (choose file with prompt "Choose a GarageBand bounce, stem, source song, or vocal audio file to send to OpenClaw")')"
KIND="$(osascript -e 'set choices to {"song", "stem", "vocal", "reference"}' -e 'set picked to choose from list choices with prompt "What kind of audio is this?" default items {"song"}' -e 'if picked is false then error number -128' -e 'item 1 of picked')"
DIRECTION="$(osascript -e 'text returned of (display dialog "What should OpenClaw add or do with this audio?" default answer "Add original vocals and complementary musical ideas.")')"
INBOX_ID="$(date -u +"%Y%m%dT%H%M%SZ")-\${KIND}"
DEST_DIR="\${BRIDGE_ROOT}/from-macbook/inbox/\${INBOX_ID}"
AUDIO_DIR="\${DEST_DIR}/audio"

mkdir -p "\${AUDIO_DIR}"
cp "\${SOURCE_FILE}" "\${AUDIO_DIR}/\${SOURCE_FILE:t}"
printf "%s\\n" "\${DIRECTION}" > "\${DEST_DIR}/direction.txt"
cat > "\${DEST_DIR}/request.json" <<JSON
{
  "schemaVersion": 1,
  "inboxId": "\${INBOX_ID}",
  "kind": "\${KIND}",
  "audioDirectory": "audio",
  "status": "sent_to_openclaw",
  "createdAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "nextAction": "On Mac Studio, run bridge-import-garageband, then vocal-plan or bridge-export."
}
JSON

open "\${DEST_DIR}"
echo "Sent GarageBand audio to OpenClaw inbox: \${INBOX_ID}"
`;
}

function macbookPairNodeCommand(gatewayHost, gatewayPort, gatewayTls, options = {}) {
  const gatewayTlsJson = gatewayTls ? "true" : "false";
  const privateWsOptIn = !gatewayTls && gatewayHost !== "127.0.0.1" && gatewayHost !== "localhost";
  const tokenMode = options.tokenMode === "window" ? "window" : "prompt";
  const statusFileName =
    tokenMode === "window" ? "macbook-node-window-status.json" : "macbook-node-status.json";
  const blockersFileName =
    tokenMode === "window" ? "macbook-node-window-blockers.txt" : "macbook-node-blockers.txt";
  const logFileName =
    tokenMode === "window"
      ? "macbook-pair-openclaw-node-window.log"
      : "macbook-pair-openclaw-node.log";
  return `#!/bin/zsh
set -euo pipefail

BRIDGE_ROOT="\${0:A:h}"
STATUS_DIR="\${BRIDGE_ROOT}/from-macbook"
LOG_DIR="\${BRIDGE_ROOT}/logs"
STATUS_FILE="\${STATUS_DIR}/${statusFileName}"
BLOCKERS_FILE="\${STATUS_DIR}/${blockersFileName}"
LOG_FILE="\${LOG_DIR}/${logFileName}"
GATEWAY_HOST="${gatewayHost}"
GATEWAY_PORT="${gatewayPort}"
GATEWAY_TLS="${gatewayTlsJson}"
TOKEN_MODE="${tokenMode}"
NODE_DISPLAY_NAME="GarageBand MacBook"

mkdir -p "\${STATUS_DIR}" "\${LOG_DIR}"
: > "\${BLOCKERS_FILE}"
exec > >(tee -a "\${LOG_FILE}") 2>&1

echo "OpenClaw MacBook node pairing started at $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo "Gateway: \${GATEWAY_HOST}:\${GATEWAY_PORT}"

record_blocker() {
  printf "%s\\n" "$1" >> "\${BLOCKERS_FILE}"
}

OPENCLAW_BIN=""
OPENCLAW_REPO=""

if command -v openclaw >/dev/null 2>&1; then
  OPENCLAW_BIN="$(command -v openclaw)"
else
  osascript -e 'display dialog "The openclaw CLI was not found on this MacBook. Choose the local OpenClaw repo folder if it exists; otherwise install OpenClaw on this MacBook first." buttons {"Choose Folder"} default button "Choose Folder"'
  OPENCLAW_REPO="$(osascript -e 'POSIX path of (choose folder with prompt "Choose the OpenClaw repo folder on this MacBook")')"
  if [[ ! -f "\${OPENCLAW_REPO}/package.json" ]]; then
    record_blocker "Selected folder does not look like an OpenClaw repo."
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    record_blocker "pnpm is not installed or not on PATH, and openclaw CLI is unavailable."
  fi
fi

run_openclaw() {
  if [[ -n "\${OPENCLAW_BIN}" ]]; then
    "\${OPENCLAW_BIN}" "$@"
  else
    pnpm --dir "\${OPENCLAW_REPO}" openclaw "$@"
  fi
}

BLOCKER_COUNT="$(wc -l < "\${BLOCKERS_FILE}" | tr -d ' ')"
if [[ "\${BLOCKER_COUNT}" != "0" ]]; then
  cat > "\${STATUS_FILE}" <<JSON
{
  "schemaVersion": 1,
  "status": "blocked",
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "gatewayHost": "\${GATEWAY_HOST}",
  "gatewayPort": \${GATEWAY_PORT},
  "gatewayTls": \${GATEWAY_TLS},
  "nodeDisplayName": "\${NODE_DISPLAY_NAME}",
  "tokenMode": "\${TOKEN_MODE}",
  "blockerCount": \${BLOCKER_COUNT},
  "blockersFile": "from-macbook/${blockersFileName}",
  "setupLog": "logs/${logFileName}"
}
JSON
  open "\${BLOCKERS_FILE}"
  exit 1
fi

GATEWAY_TOKEN=""
if [[ "\${TOKEN_MODE}" == "prompt" ]]; then
  GATEWAY_TOKEN="$(osascript -e 'text returned of (display dialog "Paste the Mac Studio OpenClaw Gateway token. It will be passed directly to openclaw node install and will not be written into the iCloud bridge status files." default answer "" with hidden answer buttons {"Continue"} default button "Continue")')"
  if [[ -z "\${GATEWAY_TOKEN}" ]]; then
    record_blocker "Gateway token was not provided."
  fi
else
  echo "Using tokenless enrollment window mode. Make sure macstudio-open-node-enrollment.command is running on the Mac Studio."
fi

INSTALL_OUTPUT=""
START_OUTPUT=""
STATUS_OUTPUT=""
PAIRING_STATUS="pending_approval"

if [[ -s "\${BLOCKERS_FILE}" ]]; then
  PAIRING_STATUS="blocked"
else
  set +e
  TLS_ARGS=()
  if [[ "\${GATEWAY_TLS}" == "true" ]]; then
    TLS_ARGS=(--tls)
  fi
  if [[ "\${GATEWAY_TLS}" != "true" && "\${GATEWAY_HOST}" != "127.0.0.1" && "\${GATEWAY_HOST}" != "localhost" ]]; then
    export OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1
  fi
  if [[ "\${TOKEN_MODE}" == "prompt" ]]; then
    export OPENCLAW_GATEWAY_TOKEN="\${GATEWAY_TOKEN}"
  else
    unset OPENCLAW_GATEWAY_TOKEN
    unset OPENCLAW_GATEWAY_PASSWORD
  fi
  INSTALL_OUTPUT="$(run_openclaw node install --host "\${GATEWAY_HOST}" --port "\${GATEWAY_PORT}" "\${TLS_ARGS[@]}" --display-name "\${NODE_DISPLAY_NAME}" --force --json 2>&1)"
  INSTALL_CODE=$?
  START_OUTPUT="$(run_openclaw node start --json 2>&1)"
  START_CODE=$?
  STATUS_OUTPUT="$(run_openclaw node status --json 2>&1)"
  STATUS_CODE=$?
  unset OPENCLAW_GATEWAY_TOKEN
  unset OPENCLAW_ALLOW_INSECURE_PRIVATE_WS
  set -e

  printf "%s\\n" "\${INSTALL_OUTPUT}" > "\${LOG_DIR}/macbook-node-install.json"
  printf "%s\\n" "\${START_OUTPUT}" > "\${LOG_DIR}/macbook-node-start.json"
  printf "%s\\n" "\${STATUS_OUTPUT}" > "\${LOG_DIR}/macbook-node-status-raw.json"

  if [[ "\${INSTALL_CODE}" != "0" ]]; then
    record_blocker "openclaw node install failed."
    PAIRING_STATUS="blocked"
  elif [[ "\${START_CODE}" != "0" ]]; then
    record_blocker "openclaw node start failed."
    PAIRING_STATUS="blocked"
  elif [[ "\${STATUS_CODE}" != "0" ]]; then
    record_blocker "openclaw node status failed."
    PAIRING_STATUS="started_status_unknown"
  fi
fi

BLOCKER_COUNT="$(wc -l < "\${BLOCKERS_FILE}" | tr -d ' ')"
if [[ "\${BLOCKER_COUNT}" != "0" ]]; then
  PAIRING_STATUS="blocked"
fi

cat > "\${STATUS_FILE}" <<JSON
{
  "schemaVersion": 1,
  "status": "\${PAIRING_STATUS}",
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "gatewayHost": "\${GATEWAY_HOST}",
  "gatewayPort": \${GATEWAY_PORT},
  "gatewayTls": \${GATEWAY_TLS},
  "nodeDisplayName": "\${NODE_DISPLAY_NAME}",
  "tokenMode": "\${TOKEN_MODE}",
  "privateWsOptIn": ${privateWsOptIn ? "true" : "false"},
  "gatewayTokenWrittenToBridge": false,
  "blockerCount": \${BLOCKER_COUNT},
  "blockersFile": "from-macbook/${blockersFileName}",
  "installLog": "logs/macbook-node-install.json",
  "startLog": "logs/macbook-node-start.json",
  "statusLog": "logs/macbook-node-status-raw.json",
  "setupLog": "logs/${logFileName}",
  "nextAction": "On the Mac Studio, run openclaw nodes pending/list and approve the GarageBand MacBook node request."
}
JSON

open "\${BRIDGE_ROOT}"
if [[ "\${PAIRING_STATUS}" == "blocked" ]]; then
  open "\${BLOCKERS_FILE}"
  osascript -e 'display dialog "OpenClaw node setup is blocked. The blockers file is open." buttons {"OK"} default button "OK"'
else
  osascript -e 'display dialog "OpenClaw node setup ran. Now approve the pending GarageBand MacBook node request on the Mac Studio." buttons {"OK"} default button "OK"'
fi

echo "MacBook node pairing status: \${PAIRING_STATUS}"
echo "Status file: \${STATUS_FILE}"
`;
}

function macstudioOpenNodeEnrollmentCommand(repoRoot) {
  return `#!/bin/zsh
set -euo pipefail

BRIDGE_ROOT="\${0:A:h}"
STATUS_DIR="\${BRIDGE_ROOT}/from-macbook"
LOG_DIR="\${BRIDGE_ROOT}/logs"
STATUS_FILE="\${STATUS_DIR}/node-enrollment-window.json"
LOG_FILE="\${LOG_DIR}/macstudio-open-node-enrollment.log"
OPENCLAW_REPO="${repoRoot}"
DURATION_SECONDS="\${1:-600}"

mkdir -p "\${STATUS_DIR}" "\${LOG_DIR}"
exec > >(tee -a "\${LOG_FILE}") 2>&1

run_openclaw() {
  pnpm --dir "\${OPENCLAW_REPO}" openclaw "$@"
}

json_status() {
  local enrollment_status="$1"
  local next_action="$2"
  cat > "\${STATUS_FILE}" <<JSON
{
  "schemaVersion": 1,
  "status": "\${enrollment_status}",
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "durationSeconds": \${DURATION_SECONDS},
  "gatewayAuthTemporarilyDisabled": true,
  "gatewayTokenWrittenToBridge": false,
  "setupLog": "logs/macstudio-open-node-enrollment.log",
  "nextAction": "\${next_action}"
}
JSON
}

PREVIOUS_AUTH_MODE="$(run_openclaw config get gateway.auth.mode 2>/dev/null | tail -n 1 | tr -d '\\r')"
if [[ -z "\${PREVIOUS_AUTH_MODE}" || "\${PREVIOUS_AUTH_MODE}" == "__OPENCLAW_REDACTED__" ]]; then
  PREVIOUS_AUTH_MODE="token"
fi

RESTORED=false
restore_gateway_auth() {
  if [[ "\${RESTORED}" == true ]]; then
    return
  fi
  RESTORED=true
  echo "Restoring Gateway auth mode to \${PREVIOUS_AUTH_MODE}."
  run_openclaw config set gateway.auth.mode "\${PREVIOUS_AUTH_MODE}"
  run_openclaw gateway restart --json
  json_status "closed" "Enrollment window closed. Run openclaw nodes list and approve any pending GarageBand MacBook node request."
}

trap restore_gateway_auth EXIT INT TERM

echo "Opening short-lived tokenless node enrollment window for \${DURATION_SECONDS}s."
json_status "opening" "Wait for Gateway restart, then run macbook-pair-openclaw-node-window.command on the MacBook."
run_openclaw config set gateway.auth.mode none
run_openclaw gateway restart --json
json_status "open" "Run macbook-pair-openclaw-node-window.command on the MacBook before this window closes."
if [[ "\${OPENCLAW_NODE_ENROLLMENT_NO_DIALOG:-}" != "1" ]]; then
  osascript -e 'display dialog "Node enrollment window is open. On the MacBook, run macbook-pair-openclaw-node-window.command from the synced bridge folder." buttons {"OK"} default button "OK"' || true
fi

END_AT=$(( $(date +%s) + DURATION_SECONDS ))
while [[ "$(date +%s)" -lt "\${END_AT}" ]]; do
  run_openclaw nodes list --json > "\${LOG_DIR}/nodes-list-during-enrollment.json" 2>&1 || true
  sleep 10
done

restore_gateway_auth
`;
}

function macbookEnableRemoteExecCommand() {
  return `#!/bin/zsh
set -euo pipefail

BRIDGE_ROOT="\${0:A:h}"
STATUS_DIR="\${BRIDGE_ROOT}/from-macbook"
LOG_DIR="\${BRIDGE_ROOT}/logs"
STATUS_FILE="\${STATUS_DIR}/macbook-remote-exec-status.json"
BLOCKERS_FILE="\${STATUS_DIR}/macbook-remote-exec-blockers.txt"
LOG_FILE="\${LOG_DIR}/macbook-enable-remote-exec.log"
PUBLIC_KEY_FILE="\${BRIDGE_ROOT}/macstudio-openclaw-bridge.pub"

mkdir -p "\${STATUS_DIR}" "\${LOG_DIR}"
: > "\${BLOCKERS_FILE}"
exec > >(tee -a "\${LOG_FILE}") 2>&1

record_blocker() {
  printf "%s\\n" "$1" >> "\${BLOCKERS_FILE}"
}

bool_for_text() {
  if [[ "$1" == "$2" ]]; then
    echo true
  else
    echo false
  fi
}

if [[ ! -s "\${PUBLIC_KEY_FILE}" ]]; then
  record_blocker "Missing Mac Studio public key file: macstudio-openclaw-bridge.pub"
fi

SSH_USER="$(whoami)"
COMPUTER_NAME="$(scutil --get ComputerName 2>/dev/null || hostname)"
AUTHORIZED_KEYS="\${HOME}/.ssh/authorized_keys"
AUTHORIZED_KEY_INSTALLED=false
REMOTE_LOGIN_ENABLED=false

if [[ ! -s "\${BLOCKERS_FILE}" ]]; then
  mkdir -p "\${HOME}/.ssh"
  chmod 700 "\${HOME}/.ssh"
  touch "\${AUTHORIZED_KEYS}"
  chmod 600 "\${AUTHORIZED_KEYS}"
  PUBLIC_KEY="$(cat "\${PUBLIC_KEY_FILE}")"
  if ! grep -qxF "\${PUBLIC_KEY}" "\${AUTHORIZED_KEYS}"; then
    printf "%s\\n" "\${PUBLIC_KEY}" >> "\${AUTHORIZED_KEYS}"
  fi
  if grep -qxF "\${PUBLIC_KEY}" "\${AUTHORIZED_KEYS}"; then
    AUTHORIZED_KEY_INSTALLED=true
  else
    record_blocker "Could not install Mac Studio public key into authorized_keys."
  fi

  REMOTE_LOGIN_TEXT="$(/usr/sbin/systemsetup -getremotelogin 2>/dev/null || true)"
  if [[ "\${REMOTE_LOGIN_TEXT}" != *"On"* ]]; then
    echo "Remote Login is off. Requesting administrator approval to enable it."
    osascript -e 'do shell script "/usr/sbin/systemsetup -setremotelogin on" with administrator privileges'
  fi
  REMOTE_LOGIN_TEXT="$(/usr/sbin/systemsetup -getremotelogin 2>/dev/null || true)"
  REMOTE_LOGIN_ENABLED="$(bool_for_text "\${REMOTE_LOGIN_TEXT}" "Remote Login: On")"
  if [[ "\${REMOTE_LOGIN_ENABLED}" != true ]]; then
    record_blocker "Remote Login is still not enabled."
  fi
fi

BLOCKER_COUNT="$(wc -l < "\${BLOCKERS_FILE}" | tr -d ' ')"
OVERALL_STATUS="ready"
if [[ "\${BLOCKER_COUNT}" != "0" ]]; then
  OVERALL_STATUS="blocked"
fi

cat > "\${STATUS_FILE}" <<JSON
{
  "schemaVersion": 1,
  "status": "\${OVERALL_STATUS}",
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "computerName": "\${COMPUTER_NAME}",
  "sshUsername": "\${SSH_USER}",
  "remoteLoginEnabled": \${REMOTE_LOGIN_ENABLED},
  "authorizedKeyInstalled": \${AUTHORIZED_KEY_INSTALLED},
  "privateKeyWrittenToBridge": false,
  "blockerCount": \${BLOCKER_COUNT},
  "blockersFile": "from-macbook/macbook-remote-exec-blockers.txt",
  "setupLog": "logs/macbook-enable-remote-exec.log",
  "nextAction": "On the Mac Studio, run ssh with the Music Creator remote-exec key to validate MacBook command execution."
}
JSON

open "\${BRIDGE_ROOT}"
if [[ "\${OVERALL_STATUS}" == "ready" ]]; then
  osascript -e 'display dialog "MacBook Remote Login is ready for Mac Studio OpenClaw validation." buttons {"OK"} default button "OK"'
else
  open "\${BLOCKERS_FILE}"
  osascript -e 'display dialog "MacBook remote execution setup is blocked. The blockers file is open." buttons {"OK"} default button "OK"'
fi

echo "MacBook remote execution status: \${OVERALL_STATUS}"
echo "Status file: \${STATUS_FILE}"
`;
}

function macbookDisableRemoteExecCommand() {
  return `#!/bin/zsh
set -euo pipefail

BRIDGE_ROOT="\${0:A:h}"
STATUS_DIR="\${BRIDGE_ROOT}/from-macbook"
LOG_DIR="\${BRIDGE_ROOT}/logs"
STATUS_FILE="\${STATUS_DIR}/macbook-remote-exec-removed.json"
LOG_FILE="\${LOG_DIR}/macbook-disable-remote-exec.log"
AUTHORIZED_KEYS="\${HOME}/.ssh/authorized_keys"
BACKUP_FILE="\${HOME}/.ssh/authorized_keys.backup-openclaw-disable-\$(date -u +"%Y%m%dT%H%M%SZ")"

mkdir -p "\${STATUS_DIR}" "\${LOG_DIR}"
exec > >(tee -a "\${LOG_FILE}") 2>&1

REMOVED_KEY=false
REMOTE_LOGIN_TEXT="$(/usr/sbin/systemsetup -getremotelogin 2>/dev/null || true)"

if [[ -f "\${AUTHORIZED_KEYS}" ]]; then
  cp "\${AUTHORIZED_KEYS}" "\${BACKUP_FILE}"
  /usr/bin/grep -v "openclaw-garageband-bridge" "\${BACKUP_FILE}" > "\${AUTHORIZED_KEYS}" || true
  chmod 600 "\${AUTHORIZED_KEYS}"
  if ! /usr/bin/cmp -s "\${AUTHORIZED_KEYS}" "\${BACKUP_FILE}"; then
    REMOVED_KEY=true
  fi
fi

cat > "\${STATUS_FILE}" <<JSON
{
  "schemaVersion": 1,
  "status": "remote_exec_removed",
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "removedOpenClawSshKeyLine": \${REMOVED_KEY},
  "remoteLoginState": "\${REMOTE_LOGIN_TEXT}",
  "remoteLoginManagedByThisBridge": false,
  "nextAction": "Keep Remote Login off in System Settings > General > Sharing. Use macbook-pull-agent.command for safer automation."
}
JSON

open "\${BRIDGE_ROOT}"
osascript -e 'display dialog "OpenClaw Remote Login key cleanup is complete. Keep Remote Login off and use the pull agent for safer automation." buttons {"OK"} default button "OK"' || true
echo "OpenClaw Remote Login key cleanup complete."
echo "Status file: \${STATUS_FILE}"
`;
}

function macbookPullAgentCommand() {
  const allowedActions = [...BRIDGE_AGENT_ACTIONS].join(", ");
  return `#!/bin/zsh
set -euo pipefail

BRIDGE_ROOT="\${0:A:h}"
REQUEST_DIR="\${BRIDGE_ROOT}/to-macbook/requests"
PROCESSED_DIR="\${REQUEST_DIR}/processed"
REJECTED_DIR="\${REQUEST_DIR}/rejected"
RESULTS_DIR="\${BRIDGE_ROOT}/from-macbook/agent-results"
STATUS_DIR="\${BRIDGE_ROOT}/from-macbook"
LOG_DIR="\${BRIDGE_ROOT}/logs"
STATUS_FILE="\${STATUS_DIR}/macbook-pull-agent-status.json"
LOG_FILE="\${LOG_DIR}/macbook-pull-agent.log"
PUBLIC_KEY_FILE="\${BRIDGE_ROOT}/macstudio-bridge-signing.pub.pem"
INTERVAL_SECONDS="\${OPENCLAW_BRIDGE_AGENT_INTERVAL:-10}"
MODE="\${1:-loop}"
ALLOWED_ACTIONS="${allowedActions}"

mkdir -p "\${REQUEST_DIR}" "\${PROCESSED_DIR}" "\${REJECTED_DIR}" "\${RESULTS_DIR}" "\${LOG_DIR}"
exec > >(tee -a "\${LOG_FILE}") 2>&1

json_escape() {
  printf "%s" "$1" | /usr/bin/sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g'
}

json_value() {
  /usr/bin/plutil -extract "$2" raw -o - "$1" 2>/dev/null | /usr/bin/tr -d '\\n' || true
}

safe_id() {
  [[ "$1" =~ '^[A-Za-z0-9._:-]+$' ]]
}

allowed_action() {
  case "$1" in
    health-check|garageband-status|list-bridge-files|open-latest-bridge-job|open-bridge-job) return 0 ;;
    *) return 1 ;;
  esac
}

write_agent_status() {
  local agent_status="$1"
  local detail="$2"
  local remote_login
  remote_login="$(/usr/sbin/systemsetup -getremotelogin 2>/dev/null | /usr/bin/tr -d '\\n' || true)"
  cat > "\${STATUS_FILE}" <<JSON
{
  "schemaVersion": 1,
  "status": "\${agent_status}",
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "mode": "\${MODE}",
  "allowedActions": "\${ALLOWED_ACTIONS}",
  "remoteLoginUsed": false,
  "remoteLoginState": "\$(json_escape "\${remote_login}")",
  "detail": "\$(json_escape "\${detail}")",
  "nextAction": "Mac Studio can queue signed jobs with bridge-queue-job. Close this Terminal window to stop the agent."
}
JSON
}

write_result() {
  local request_id="$1"
  local action="$2"
  local result_status="$3"
  local detail="$4"
  local result_file="\${RESULTS_DIR}/\${request_id}.json"
  cat > "\${result_file}" <<JSON
{
  "schemaVersion": 1,
  "requestId": "\$(json_escape "\${request_id}")",
  "action": "\$(json_escape "\${action}")",
  "status": "\$(json_escape "\${result_status}")",
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "remoteLoginUsed": false,
  "arbitraryCommandsAllowed": false,
  "detail": "\$(json_escape "\${detail}")"
}
JSON
}

reject_request() {
  local job_file="$1"
  local reason="$2"
  local base="\${job_file:t}"
  local request_id="\${base:r}"
  write_result "\${request_id}" "unknown" "rejected" "\${reason}"
  mv "\${job_file}" "\${REJECTED_DIR}/\${base}" 2>/dev/null || true
  if [[ -f "\${job_file}.sig" ]]; then
    mv "\${job_file}.sig" "\${REJECTED_DIR}/\${base}.sig" 2>/dev/null || true
  fi
  echo "Rejected \${base}: \${reason}"
}

first_audio_in_job() {
  local job_dir="$1"
  /usr/bin/find "\${job_dir}/audio" -maxdepth 1 -type f \\( -iname "*.wav" -o -iname "*.aif" -o -iname "*.aiff" -o -iname "*.mp3" -o -iname "*.m4a" -o -iname "*.flac" -o -iname "*.ogg" \\) -print -quit 2>/dev/null
}

open_job_audio() {
  local request_id="$1"
  local action="$2"
  local job_id="$3"
  if ! safe_id "\${job_id}"; then
    write_result "\${request_id}" "\${action}" "blocked" "Unsafe or missing bridge job id."
    return 1
  fi
  local job_dir="\${BRIDGE_ROOT}/to-macbook/\${job_id}"
  local audio_file
  audio_file="$(first_audio_in_job "\${job_dir}")"
  if [[ -z "\${audio_file}" || ! -f "\${audio_file}" ]]; then
    write_result "\${request_id}" "\${action}" "blocked" "No audio file found for bridge job \${job_id}."
    return 1
  fi
  /usr/bin/open -a GarageBand || true
  /usr/bin/open -R "\${audio_file}"
  write_result "\${request_id}" "\${action}" "done" "GarageBand open request handled for bridge job \${job_id}; Finder revealed the audio file."
}

handle_action() {
  local job_file="$1"
  local request_id="$2"
  local action="$3"
  case "\${action}" in
    health-check)
      local computer_name
      computer_name="$(scutil --get ComputerName 2>/dev/null | /usr/bin/tr -d '\\n' || hostname)"
      write_result "\${request_id}" "\${action}" "done" "MacBook pull agent healthy on \${computer_name}. Remote Login is not used."
      ;;
    garageband-status)
      local garageband_status="missing"
      if [[ -d "/Applications/GarageBand.app" || -d "/System/Applications/GarageBand.app" ]]; then
        garageband_status="installed"
      fi
      local au_status="not_checked"
      if command -v auval >/dev/null 2>&1; then
        if auval -v aufx sMas oDin > "\${LOG_DIR}/pull-agent-auval.txt" 2>&1; then
          au_status="valhalla_au_passed"
        else
          au_status="valhalla_au_missing_or_failed"
        fi
      fi
      write_result "\${request_id}" "\${action}" "done" "GarageBand: \${garageband_status}; Valhalla AU: \${au_status}."
      ;;
    list-bridge-files)
      /usr/bin/find "\${BRIDGE_ROOT}/to-macbook" -maxdepth 2 -type f 2>/dev/null | /usr/bin/sed "s#\${BRIDGE_ROOT}/##" | /usr/bin/head -n 200 > "\${LOG_DIR}/pull-agent-bridge-files.txt" || true
      write_result "\${request_id}" "\${action}" "done" "Wrote bridge file listing to logs/pull-agent-bridge-files.txt."
      ;;
    open-latest-bridge-job)
      local latest_job
      latest_job="$(ls -td "\${BRIDGE_ROOT}"/to-macbook/*(/N) 2>/dev/null | /usr/bin/grep -v '/requests$' | /usr/bin/head -n 1 || true)"
      if [[ -z "\${latest_job}" ]]; then
        write_result "\${request_id}" "\${action}" "blocked" "No bridge jobs found."
        return 1
      fi
      open_job_audio "\${request_id}" "\${action}" "\${latest_job:t}"
      ;;
    open-bridge-job)
      local job_id
      job_id="$(json_value "\${job_file}" "target.jobId")"
      open_job_audio "\${request_id}" "\${action}" "\${job_id}"
      ;;
  esac
}

process_request() {
  local job_file="$1"
  local sig_file="\${job_file}.sig"
  local base="\${job_file:t}"
  if [[ ! -s "\${PUBLIC_KEY_FILE}" ]]; then
    reject_request "\${job_file}" "Missing Mac Studio signing public key."
    return
  fi
  if [[ ! -s "\${sig_file}" ]]; then
    reject_request "\${job_file}" "Missing request signature."
    return
  fi
  if ! /usr/bin/openssl dgst -sha256 -verify "\${PUBLIC_KEY_FILE}" -signature "\${sig_file}" "\${job_file}" >/dev/null 2>&1; then
    reject_request "\${job_file}" "Request signature did not verify."
    return
  fi

  local request_id action expires_at now
  request_id="$(json_value "\${job_file}" "requestId")"
  action="$(json_value "\${job_file}" "action")"
  expires_at="$(json_value "\${job_file}" "expiresAt")"
  now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  if ! safe_id "\${request_id}"; then
    reject_request "\${job_file}" "Unsafe or missing request id."
    return
  fi
  if ! allowed_action "\${action}"; then
    reject_request "\${job_file}" "Action is not whitelisted."
    return
  fi
  if [[ -n "\${expires_at}" && "\${expires_at}" < "\${now}" ]]; then
    reject_request "\${job_file}" "Request expired."
    return
  fi

  write_agent_status "processing" "\${request_id} \${action}"
  if handle_action "\${job_file}" "\${request_id}" "\${action}"; then
    mv "\${job_file}" "\${PROCESSED_DIR}/\${base}" 2>/dev/null || true
    mv "\${sig_file}" "\${PROCESSED_DIR}/\${base}.sig" 2>/dev/null || true
    echo "Processed \${request_id}: \${action}"
  else
    mv "\${job_file}" "\${REJECTED_DIR}/\${base}" 2>/dev/null || true
    mv "\${sig_file}" "\${REJECTED_DIR}/\${base}.sig" 2>/dev/null || true
    echo "Blocked \${request_id}: \${action}"
  fi
}

process_once() {
  local found=false
  for job_file in "\${REQUEST_DIR}"/*.json(N); do
    found=true
    process_request "\${job_file}"
  done
  if [[ "\${found}" == false ]]; then
    write_agent_status "idle" "No signed requests waiting."
    echo "No signed requests waiting."
  fi
}

write_agent_status "started" "MacBook pull agent started. Remote Login is not used."
if [[ "\${MODE}" == "--once" || "\${MODE}" == "once" ]]; then
  process_once
  write_agent_status "stopped" "One-shot run complete."
else
  echo "MacBook pull agent running. Allowed actions: \${ALLOWED_ACTIONS}"
  echo "Close this Terminal window to stop it."
  while true; do
    process_once
    sleep "\${INTERVAL_SECONDS}"
  done
fi
`;
}

function macbookPullAgentOnceCommand() {
  return `#!/bin/zsh
set -euo pipefail

BRIDGE_ROOT="\${0:A:h}"
exec "\${BRIDGE_ROOT}/macbook-pull-agent.command" --once
`;
}

function macbookSyncCheckCommand() {
  return `#!/bin/zsh
set -euo pipefail

BRIDGE_ROOT="\${0:A:h}"
PROBE_DIR="\${BRIDGE_ROOT}/sync/mac-studio"
REPLY_DIR="\${BRIDGE_ROOT}/sync/macbook"
STATUS_DIR="\${BRIDGE_ROOT}/from-macbook"
LOG_DIR="\${BRIDGE_ROOT}/logs"
STATUS_FILE="\${STATUS_DIR}/macbook-sync-status.json"
LOG_FILE="\${LOG_DIR}/macbook-sync-check.log"

mkdir -p "\${PROBE_DIR}" "\${REPLY_DIR}" "\${STATUS_DIR}" "\${LOG_DIR}"
exec > >(tee -a "\${LOG_FILE}") 2>&1

json_escape() {
  printf "%s" "$1" | /usr/bin/sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g'
}

json_value() {
  /usr/bin/plutil -extract "$2" raw -o - "$1" 2>/dev/null | /usr/bin/tr -d '\\n' || true
}

safe_id() {
  [[ "$1" =~ '^[A-Za-z0-9._:-]+$' ]]
}

LATEST_PROBE="$(ls -t "\${PROBE_DIR}"/*.json(N) 2>/dev/null | /usr/bin/head -n 1 || true)"
if [[ -z "\${LATEST_PROBE}" ]]; then
  cat > "\${STATUS_FILE}" <<JSON
{
  "schemaVersion": 1,
  "status": "blocked_no_probe",
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "remoteLoginUsed": false,
  "nextAction": "On the Mac Studio, run bridge-sync-probe, wait for sync, then run this command again."
}
JSON
  echo "No Mac Studio sync probe found."
  exit 1
fi

PROBE_ID="$(json_value "\${LATEST_PROBE}" "probeId")"
if ! safe_id "\${PROBE_ID}"; then
  echo "Unsafe or missing probe id in \${LATEST_PROBE}"
  exit 1
fi

COMPUTER_NAME="$(scutil --get ComputerName 2>/dev/null | /usr/bin/tr -d '\\n' || hostname)"
REPLY_FILE="\${REPLY_DIR}/\${PROBE_ID}.json"
cat > "\${REPLY_FILE}" <<JSON
{
  "schemaVersion": 1,
  "probeId": "\$(json_escape "\${PROBE_ID}")",
  "status": "macbook_reply_written",
  "seenProbeFile": "sync/mac-studio/\${PROBE_ID}.json",
  "replyFile": "sync/macbook/\${PROBE_ID}.json",
  "computerName": "\$(json_escape "\${COMPUTER_NAME}")",
  "macUser": "\$(whoami)",
  "remoteLoginUsed": false,
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
JSON

cat > "\${STATUS_FILE}" <<JSON
{
  "schemaVersion": 1,
  "status": "reply_written",
  "probeId": "\$(json_escape "\${PROBE_ID}")",
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "remoteLoginUsed": false,
  "replyFile": "sync/macbook/\${PROBE_ID}.json",
  "nextAction": "On the Mac Studio, run bridge-sync-status to verify the reply synced back."
}
JSON

open "\${BRIDGE_ROOT}" >/dev/null 2>&1 || true
echo "MacBook sync reply written for probe: \${PROBE_ID}"
echo "Reply file: \${REPLY_FILE}"
`;
}

function macbookStartSafeBridgeCommand() {
  return `#!/bin/zsh
set -euo pipefail

BRIDGE_ROOT="\${0:A:h}"
STATUS_DIR="\${BRIDGE_ROOT}/from-macbook"
LOG_DIR="\${BRIDGE_ROOT}/logs"
STATUS_FILE="\${STATUS_DIR}/macbook-safe-bridge-status.json"
LOG_FILE="\${LOG_DIR}/macbook-start-safe-bridge.log"

mkdir -p "\${STATUS_DIR}" "\${LOG_DIR}"
exec > >(tee -a "\${LOG_FILE}") 2>&1

json_escape() {
  printf "%s" "$1" | /usr/bin/sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g'
}

write_status() {
  local bridge_status="$1"
  local detail="$2"
  cat > "\${STATUS_FILE}" <<JSON
{
  "schemaVersion": 1,
  "status": "\${bridge_status}",
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "remoteLoginUsed": false,
  "arbitraryCommandsAllowed": false,
  "detail": "\$(json_escape "\${detail}")",
  "nextAction": "On the Mac Studio, run bridge-sync-status and bridge-status."
}
JSON
}

REMOTE_LOGIN_TEXT="$(/usr/sbin/systemsetup -getremotelogin 2>/dev/null || true)"
if [[ "\${REMOTE_LOGIN_TEXT}" == *"On"* ]]; then
  write_status "blocked_remote_login_on" "Remote Login is on. Turn it off in System Settings > General > Sharing, then run this command again."
  if [[ "\${OPENCLAW_BRIDGE_NO_DIALOG:-}" != "1" ]]; then
    osascript -e 'display dialog "Remote Login is ON. For the safe bridge, turn it off in System Settings > General > Sharing, then run this command again." buttons {"OK"} default button "OK"' || true
  fi
  echo "Blocked: Remote Login is on."
  exit 1
fi

echo "Starting safe OpenClaw GarageBand bridge."
echo "Remote Login is not being used."
"\${BRIDGE_ROOT}/macbook-sync-check.command"
"\${BRIDGE_ROOT}/macbook-pull-agent.command" --once
write_status "safe_bridge_ran_once" "Sync check completed and one signed pull-agent cycle ran."
if [[ "\${OPENCLAW_BRIDGE_NO_DIALOG:-}" != "1" ]]; then
  osascript -e 'display dialog "Safe OpenClaw GarageBand bridge ran once. Go back to the Mac Studio and verify bridge status." buttons {"OK"} default button "OK"' || true
fi
echo "Safe OpenClaw GarageBand bridge ran once."
`;
}

function macbookRunMeSafeBridgeCommand() {
  return `#!/bin/zsh
set -euo pipefail

BRIDGE_ROOT="\${0:A:h}"
exec "\${BRIDGE_ROOT}/macbook-start-safe-bridge.command"
`;
}

function macbookRunMeReadme() {
  return `# MacBook Safe Bridge: Run This First

Use this on the MacBook only.

1. Keep Remote Login off: System Settings > General > Sharing > Remote Login.
2. Right-click \`00-RUN-ME-MACBOOK-SAFE-BRIDGE.command\`.
3. Choose Open.
4. Let it finish.
5. Go back to the Mac Studio and run bridge status.

What it does:

- Verifies the bridge sync probe.
- Writes the MacBook reply back into the bridge folder.
- Processes exactly one signed OpenClaw bridge request.
- Does not use SSH or Remote Login.
- Does not allow arbitrary shell commands.
- Does not read outside this bridge folder except for basic GarageBand/status checks.
`;
}

function bridgeTransferKitReadme({ kitId, sourceBridgeRoot, createdAt }) {
  return `# OpenClaw GarageBand Safe Transfer Kit

Kit: ${kitId}
Created: ${createdAt}
Source bridge root on Mac Studio:

\`\`\`text
${sourceBridgeRoot}
\`\`\`

Use this when the Mac Studio and MacBook do not share one editable synced folder.
It keeps the safer pull-agent design: no SSH, no Remote Login, and no arbitrary
shell command execution from OpenClaw.

## On the MacBook

1. Keep this whole \`${BRIDGE_ROOT_NAME}\` folder together.
2. Confirm Remote Login is off: System Settings > General > Sharing > Remote Login.
3. Right-click \`00-RUN-ME-MACBOOK-SAFE-BRIDGE.command\`.
4. Choose Open.
5. Let it finish.
6. Send this same \`${BRIDGE_ROOT_NAME}\` folder back to the Mac Studio.

## Back on the Mac Studio

Run:

\`\`\`bash
node music-creator-v1/scripts/music-creator-v1.mjs bridge-import-transfer-return --return-root <returned-${BRIDGE_ROOT_NAME}-folder>
node music-creator-v1/scripts/music-creator-v1.mjs bridge-sync-status
node music-creator-v1/scripts/music-creator-v1.mjs bridge-status
\`\`\`

Only these returned subfolders are imported: \`from-macbook/\`, \`sync/macbook/\`,
and \`logs/\`. The import command does not execute returned files.
`;
}

function macbookFinishSetupCommand() {
  return `#!/bin/zsh
set -euo pipefail

BRIDGE_ROOT="\${0:A:h}"
STATUS_DIR="\${BRIDGE_ROOT}/from-macbook"
LOG_DIR="\${BRIDGE_ROOT}/logs"
STATUS_FILE="\${STATUS_DIR}/macbook-prereq-status.json"
BLOCKERS_FILE="\${STATUS_DIR}/macbook-prereq-blockers.txt"
LOG_FILE="\${LOG_DIR}/macbook-finish-setup.log"
VALHALLA_DMG_URL="https://valhallaproduction.s3.us-west-2.amazonaws.com/supermassive/ValhallaSupermassiveOSX_5_0_0.dmg"
VALHALLA_DMG="/tmp/ValhallaSupermassiveOSX_5_0_0.dmg"
VALHALLA_AU="/Library/Audio/Plug-Ins/Components/ValhallaSupermassive.component"

mkdir -p "\${STATUS_DIR}" "\${LOG_DIR}"
: > "\${BLOCKERS_FILE}"
exec > >(tee -a "\${LOG_FILE}") 2>&1

echo "OpenClaw GarageBand bridge setup started at $(date -u +"%Y-%m-%dT%H:%M:%SZ")"

bool_for_path() {
  if [[ -e "$1" ]]; then
    echo true
  else
    echo false
  fi
}

record_blocker() {
  printf "%s\\n" "$1" >> "\${BLOCKERS_FILE}"
}

garageband_installed() {
  [[ -d "/Applications/GarageBand.app" || -d "/System/Applications/GarageBand.app" ]]
}

if ! garageband_installed; then
  echo "GarageBand is missing. Opening the Mac App Store page."
  open "macappstore://apps.apple.com/us/app/garageband/id682658836" || true
  osascript -e 'display dialog "GarageBand is not installed yet. The Mac App Store page is open. Install GarageBand, then click OK here to continue validation." buttons {"OK"} default button "OK"'
fi

GARAGEBAND_INSTALLED=false
if garageband_installed; then
  GARAGEBAND_INSTALLED=true
else
  record_blocker "GarageBand is still missing after setup prompt."
fi

VALHALLA_AU_INSTALLED="$(bool_for_path "\${VALHALLA_AU}")"
if [[ "\${VALHALLA_AU_INSTALLED}" != true ]]; then
  echo "Valhalla Supermassive system AU is missing. Downloading official installer."
  if [[ ! -s "\${VALHALLA_DMG}" ]]; then
    curl -L --fail "\${VALHALLA_DMG_URL}" -o "\${VALHALLA_DMG}"
  fi

  MOUNT_POINT=""
  MOUNT_OUTPUT="$(hdiutil attach -nobrowse "\${VALHALLA_DMG}")"
  MOUNT_POINT="$(printf "%s\\n" "\${MOUNT_OUTPUT}" | awk -F '\\t' '/\\/Volumes\\// {print $NF}' | tail -n 1)"
  if [[ -n "\${MOUNT_POINT}" && -d "\${MOUNT_POINT}" ]]; then
    PKG_PATH="$(find "\${MOUNT_POINT}" -maxdepth 2 -name "*.pkg" -print -quit)"
    if [[ -n "\${PKG_PATH}" ]]; then
      echo "Opening Valhalla installer package. Complete the installer with admin approval."
      open "\${PKG_PATH}"
      osascript -e 'display dialog "Complete the Valhalla Supermassive installer with admin approval. When the installer is finished, click OK to validate the Audio Unit." buttons {"OK"} default button "OK"'
    else
      record_blocker "Valhalla installer package was not found inside the mounted DMG."
    fi
    hdiutil detach "\${MOUNT_POINT}" || true
  else
    record_blocker "Valhalla DMG could not be mounted."
  fi
fi

VALHALLA_AU_INSTALLED="$(bool_for_path "\${VALHALLA_AU}")"
if [[ "\${VALHALLA_AU_INSTALLED}" != true ]]; then
  record_blocker "Valhalla Supermassive system AU is still missing."
fi

AUVAL_PASSED=false
AUVAL_OUTPUT="$(auval -v aufx sMas oDin 2>&1 || true)"
printf "%s\\n" "\${AUVAL_OUTPUT}" > "\${LOG_DIR}/valhalla-supermassive-auval.txt"
if printf "%s\\n" "\${AUVAL_OUTPUT}" | grep -qi "validation result: successfully validated"; then
  AUVAL_PASSED=true
else
  record_blocker "Valhalla Supermassive did not pass auval validation."
fi

if [[ "\${GARAGEBAND_INSTALLED}" == true ]]; then
  open -a GarageBand || true
fi

BLOCKER_COUNT="$(wc -l < "\${BLOCKERS_FILE}" | tr -d ' ')"
OVERALL_STATUS="ready"
if [[ "\${BLOCKER_COUNT}" != "0" ]]; then
  OVERALL_STATUS="blocked"
fi

cat > "\${STATUS_FILE}" <<JSON
{
  "schemaVersion": 1,
  "status": "\${OVERALL_STATUS}",
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "garageBandInstalled": \${GARAGEBAND_INSTALLED},
  "valhallaSystemAuInstalled": \${VALHALLA_AU_INSTALLED},
  "valhallaAuvalPassed": \${AUVAL_PASSED},
  "blockerCount": \${BLOCKER_COUNT},
  "blockersFile": "from-macbook/macbook-prereq-blockers.txt",
  "auvalLog": "logs/valhalla-supermassive-auval.txt",
  "setupLog": "logs/macbook-finish-setup.log",
  "nextAction": "If status is ready, run macbook-open-latest.command for OpenClaw jobs or macbook-send-audio-to-openclaw.command for GarageBand-originated audio."
}
JSON

open "\${BRIDGE_ROOT}"
if [[ "\${OVERALL_STATUS}" == "ready" ]]; then
  osascript -e 'display dialog "GarageBand and Valhalla Supermassive are ready for the OpenClaw bridge." buttons {"OK"} default button "OK"'
else
  open "\${BLOCKERS_FILE}"
  osascript -e 'display dialog "Setup is not fully ready yet. The blockers file is open. Fix the listed items, then run macbook-finish-setup.command again." buttons {"OK"} default button "OK"'
fi

echo "MacBook setup status: \${OVERALL_STATUS}"
echo "Status file: \${STATUS_FILE}"
`;
}

function garageBandImportAppleScript(jobId) {
  return `on run argv
  if (count of argv) is 0 then error "Missing audio file"
  set audioPath to item 1 of argv

  try
    tell application "GarageBand" to activate
  on error errMsg
    display dialog "GarageBand is not installed or could not be opened. Install GarageBand from the Mac App Store, then run this helper again." buttons {"OK"} default button "OK"
    error errMsg
  end try

  delay 1

  tell application "Finder"
    reveal POSIX file audioPath
    activate
  end tell

  display dialog "Bridge job ${jobId} is ready. GarageBand is open and Finder is showing the audio file. Drag the file into a GarageBand track, edit/arrange, then bounce or export the finished audio into this job's from-macbook folder." buttons {"Done"} default button "Done"
end run
`;
}

function garageBandOpenCommand(jobId, audioFileName) {
  return `#!/bin/zsh
set -euo pipefail

JOB_DIR="\${0:A:h}"
BRIDGE_ROOT="\${JOB_DIR:h:h}"
AUDIO_FILE="\${JOB_DIR}/audio/${audioFileName}"
STATUS_DIR="\${BRIDGE_ROOT}/from-macbook/${jobId}"
STATUS_FILE="\${STATUS_DIR}/imported.json"

mkdir -p "\${STATUS_DIR}"
osascript "\${JOB_DIR}/import-to-garageband.applescript" "\${AUDIO_FILE}"

cat > "\${STATUS_FILE}" <<JSON
{
  "schemaVersion": 1,
  "jobId": "${jobId}",
  "status": "opened_for_garageband_import",
  "audioFile": "\${AUDIO_FILE}",
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "nextAction": "Edit in GarageBand, then bounce/export WAV/AIFF/MP3 into this folder."
}
JSON

open "\${STATUS_DIR}"
echo "GarageBand bridge status written to \${STATUS_FILE}"
`;
}

function complianceReview(request) {
  const rules = [
    {
      id: "artist_imitation",
      match: /(in the style of|sounds exactly like|make .* like|similar to)\s+\S+/i,
      reason: "Artist imitation language is blocked for draft automation.",
    },
    {
      id: "copyrighted_lyrics_or_samples",
      match: /(use lyrics from|copyrighted lyrics|sample from|rip the beat|use that beat)/i,
      reason: "Copyrighted lyrics, beats, and samples need explicit clearance.",
    },
    {
      id: "real_person_voice_clone",
      match:
        /(sounds? exactly like|clone|copy|impersonate|imitate|voice of|in .* voice|tupac|2pac).*(voice|vocal|rap|rapper|flow)|(?:voice|vocal|rap|rapper|flow).*(sounds? exactly like|clone|copy|impersonate|imitate|tupac|2pac)/i,
      reason:
        "Exact real-person or artist voice cloning is blocked without verified rights and an authorized voice model.",
    },
  ];
  const matchedRules = rules
    .filter((rule) => rule.match.test(request))
    .map(({ match: _match, ...rule }) => ({
      ...rule,
      severity: "blocker",
      blocksDraft: true,
      blocksRelease: true,
      safeRewrite: "Rewrite with genre, mood, instrumentation, tempo, and structure only.",
    }));
  return {
    status: matchedRules.length ? "blocked" : "clear_for_draft",
    blocksDraft: matchedRules.length > 0,
    blocksRelease: true,
    matchedRules,
    releaseGates: [
      "rightsOwnerConfirmed",
      "aiDisclosureReviewed",
      "modelToolRightsEvidenceRecorded",
      "platformMetadataComplete",
      "publicPublishingApproval",
    ],
  };
}

function defaultModelForCandidate(candidateIndex) {
  return ["google/lyria-3-clip-preview", "minimax/music-2.6", "comfy/workflow"][candidateIndex % 3];
}

function buildPrompt(project, candidateId, index = 0) {
  const model = defaultModelForCandidate(index);
  const format = model.startsWith("minimax/") ? "mp3" : "wav";
  return {
    candidateId,
    model,
    prompt: `${project.request}. Original music only. Avoid artist imitation, copyrighted lyrics, uncleared samples, clipping, and misleading real-person voice.`,
    instrumental: project.instrumental,
    durationSeconds: project.durationSeconds,
    format,
    filename: `${project.runId}-${candidateId}`,
  };
}

function openclawToolCall(prompt) {
  const parts = [
    `prompt=${JSON.stringify(prompt.prompt)}`,
    `model=${JSON.stringify(prompt.model)}`,
    prompt.lyrics ? `lyrics=${JSON.stringify(prompt.lyrics)}` : null,
    `instrumental=${prompt.instrumental}`,
    `durationSeconds=${prompt.durationSeconds}`,
    `format=${JSON.stringify(prompt.format)}`,
    `filename=${JSON.stringify(prompt.filename)}`,
  ].filter(Boolean);
  return `/tool music_generate ${parts.join(" ")}`;
}

function releaseGateBlockers(project) {
  return Object.entries(project.releaseGates ?? {})
    .filter(([, value]) => !value)
    .map(([key]) => `Release gate missing: ${key}`);
}

function releaseBlockers(project, selectedCandidate = null) {
  const blockers = [];
  if (project.compliance?.blocksDraft) blockers.push("Compliance gate blocks draft creation.");
  const gateBlockers = releaseGateBlockers(project);
  if (project.compliance?.blocksRelease && gateBlockers.length > 0)
    blockers.push("Compliance policy gates require release review.");
  if (!selectedCandidate) blockers.push("No selected candidate.");
  if (selectedCandidate && !selectedCandidate.qa?.draftReady)
    blockers.push("Selected candidate is not draft-ready.");
  return [...blockers, ...gateBlockers];
}

function nextActionFor(project) {
  const selectedCandidate = project.candidates.find(
    (candidate) => candidate.candidateId === project.selectedCandidateId,
  );
  if (project.status === STATUSES.PUBLISH_READY) return "Ready for explicit platform action.";
  if (project.status === STATUSES.DRAFT_CREATED) return "Run plan-generation.";
  if (project.liveGeneration?.lastStatus === "blocked_missing_credentials")
    return "Configure one provider key, then run generate-live.";
  if (project.liveGeneration?.lastStatus === "task_started")
    return "Run sync-live-output after the OpenClaw task completes.";
  if (project.candidates.length === 0) return "Run generate-live or ingest-candidate.";
  if (project.candidates.some((candidate) => !candidate.qa)) return "Run qa.";
  if (!project.selectedCandidateId) return "Run select.";
  if (releaseBlockers(project, selectedCandidate).length === 0)
    return "Run publish-package or proceed only with explicit platform authority.";
  return "Resolve release blockers.";
}

function normalizeProject(project) {
  project.providerAttempts ??= [];
  project.candidates ??= [];
  project.sources ??= [];
  project.vocalPlans ??= [];
  project.vocals ??= [];
  project.auditLog ??= [];
  project.liveGeneration ??= { schemaVersion: 1, attempts: [], lastStatus: "not_started" };
  project.bridge ??= { schemaVersion: 1, exports: [], imports: [] };
  project.releaseGates ??= {
    humanFinalAudioApproval: false,
    rightsOwnerConfirmed: false,
    aiDisclosureReviewed: false,
    modelToolRightsEvidenceRecorded: false,
    platformMetadataComplete: false,
    publicPublishingApproval: false,
  };
  return project;
}

async function projectDirs() {
  const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(PROJECTS_DIR, entry.name))
    .sort();
}

async function projectFile(runId) {
  return path.join(PROJECTS_DIR, runId, "project.json");
}

async function readProject(runId) {
  return normalizeProject(await readJson(await projectFile(runId)));
}

async function writeProject(project) {
  normalizeProject(project);
  project.updatedAt = nowIso();
  await writeJson(await projectFile(project.runId), project);
  await updateCatalog();
}

async function uniqueRunId(slug) {
  const base = `${nowIso().slice(0, 10)}-${slugify(slug)}`;
  let runId = base;
  let suffix = 2;
  while (await exists(path.join(PROJECTS_DIR, runId))) {
    runId = `${base}-${suffix}`;
    suffix += 1;
  }
  return runId;
}

function catalogEntry(project) {
  const selected = project.candidates.find(
    (candidate) => candidate.candidateId === project.selectedCandidateId,
  );
  const latestBridgeExport = [...(project.bridge?.exports ?? [])].reverse()[0] ?? null;
  return {
    runId: project.runId,
    status: project.status,
    request: project.request,
    artist: project.artist,
    platform: project.platform,
    projectPath: project.projectPath,
    candidateCount: project.candidates.length,
    sourceCount: project.sources.length,
    vocalCount: project.vocals.length,
    selectedCandidateId: project.selectedCandidateId ?? null,
    selectedScore: selected?.qa?.creative?.total ?? null,
    liveGenerationStatus: project.liveGeneration?.lastStatus ?? "not_started",
    latestBridgeJobId: latestBridgeExport?.jobId ?? null,
    blockers: releaseBlockers(project, selected),
    nextAction: nextActionFor(project),
    updatedAt: project.updatedAt,
  };
}

async function updateCatalog() {
  const projects = [];
  for (const dir of await projectDirs()) {
    const file = path.join(dir, "project.json");
    if (await exists(file)) projects.push(catalogEntry(normalizeProject(await readJson(file))));
  }
  const catalog = { schemaVersion: 1, updatedAt: nowIso(), projects };
  await writeJson(CATALOG_PATH, catalog);
  return catalog;
}

function addAudit(project, action, note) {
  project.auditLog.push({ at: nowIso(), action, status: project.status, note });
}

async function createProject(args) {
  const request = String(args.request ?? "").trim();
  if (!request) throw new Error("Missing --request.");
  const runId = await uniqueRunId(args.slug ?? request);
  const projectDir = path.join(PROJECTS_DIR, runId);
  const projectPath = path.relative(ROOT, projectDir);
  const project = normalizeProject({
    schemaVersion: 1,
    runId,
    status: STATUSES.DRAFT_CREATED,
    request,
    artist: String(args.artist ?? "Music Creator V1"),
    platform: String(args.platform ?? "youtube"),
    instrumental: args.vocal ? false : true,
    durationSeconds: Number.parseInt(String(args.duration ?? "60"), 10),
    projectPath,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    selectedCandidateId: null,
    compliance: complianceReview(request),
    prompts: [],
    providerAttempts: [],
    candidates: [],
    auditLog: [],
  });
  addAudit(project, "create", "Created Music Creator V1 project.");
  await fs.mkdir(path.join(projectDir, "prompts"), { recursive: true });
  await fs.mkdir(path.join(projectDir, "candidates"), { recursive: true });
  await fs.mkdir(path.join(projectDir, "selected"), { recursive: true });
  await fs.mkdir(path.join(projectDir, "sources"), { recursive: true });
  await fs.mkdir(path.join(projectDir, "vocals"), { recursive: true });
  await fs.mkdir(path.join(projectDir, "qa"), { recursive: true });
  await fs.mkdir(path.join(projectDir, "logs"), { recursive: true });
  await writeProject(project);
  await writeJson(path.join(STATE_DIR, "latest-run.json"), { runId, projectPath });
  console.log(`Created ${projectPath}`);
}

async function resolveProjectId(args) {
  if (args.project) return String(args.project);
  const latest = await readJsonOptional(path.join(STATE_DIR, "latest-run.json"), null);
  if (latest?.runId) return latest.runId;
  throw new Error("Missing --project and no latest run exists.");
}

async function planGeneration(args) {
  const runId = await resolveProjectId(args);
  const project = await readProject(runId);
  const prompts = Array.from({ length: 3 }, (_item, index) =>
    buildPrompt(project, `candidate-${String(index + 1).padStart(2, "0")}`, index),
  );
  project.prompts = prompts;
  project.status = STATUSES.GENERATION_PLANNED;
  project.providerAttempts.push(
    ...prompts.map((prompt) => ({
      candidateId: prompt.candidateId,
      model: prompt.model,
      status: "planned",
      plannedAt: nowIso(),
    })),
  );
  addAudit(project, "plan-generation", "Generated OpenClaw music_generate call sheet.");
  const projectDir = path.join(ROOT, project.projectPath);
  await writeJson(path.join(projectDir, "prompts", "provider-prompts.json"), prompts);
  await writeText(
    path.join(projectDir, "prompts", "openclaw-music-generate.md"),
    prompts.map((prompt) => `## ${prompt.candidateId}\n\n${openclawToolCall(prompt)}\n`).join("\n"),
  );
  await writeProject(project);
  console.log(`Generation plan written for ${runId}`);
}

async function hashFile(file) {
  const hash = crypto.createHash("sha256");
  hash.update(await fs.readFile(file));
  return hash.digest("hex");
}

async function copyCandidate(project, source, candidateId, sourceKind) {
  if (!AUDIO_EXTENSIONS.has(path.extname(source).toLowerCase()))
    throw new Error(`Unsupported audio extension: ${path.extname(source)}`);
  const projectDir = path.join(ROOT, project.projectPath);
  const dest = path.join(projectDir, "candidates", `${candidateId}${path.extname(source)}`);
  await fs.copyFile(source, dest);
  const record = {
    candidateId,
    sourceKind,
    sourcePath: path.relative(ROOT, source),
    path: path.relative(projectDir, dest),
    sha256: await hashFile(dest),
    ingestedAt: nowIso(),
    status: "ingested",
    qa: null,
  };
  const index = project.candidates.findIndex((candidate) => candidate.candidateId === candidateId);
  if (index >= 0) project.candidates[index] = record;
  else project.candidates.push(record);
  project.status = STATUSES.CANDIDATE_INGESTED;
  return record;
}

async function copySourceAsset(project, source, sourceId, kind, origin, note = "") {
  if (!AUDIO_EXTENSIONS.has(path.extname(source).toLowerCase()))
    throw new Error(`Unsupported audio extension: ${path.extname(source)}`);
  const projectDir = path.join(ROOT, project.projectPath);
  await fs.mkdir(path.join(projectDir, "sources"), { recursive: true });
  const dest = path.join(projectDir, "sources", `${sourceId}${path.extname(source)}`);
  await fs.copyFile(source, dest);
  const record = {
    sourceId,
    kind,
    origin,
    note,
    sourcePath: path.relative(ROOT, source),
    path: path.relative(projectDir, dest),
    sha256: await hashFile(dest),
    importedAt: nowIso(),
    status: "available",
  };
  const index = project.sources.findIndex((item) => item.sourceId === sourceId);
  if (index >= 0) project.sources[index] = record;
  else project.sources.push(record);
  return record;
}

async function copyVocalAudio(project, source, vocalId, sourceKind, planId = null) {
  if (!AUDIO_EXTENSIONS.has(path.extname(source).toLowerCase()))
    throw new Error(`Unsupported audio extension: ${path.extname(source)}`);
  const projectDir = path.join(ROOT, project.projectPath);
  const vocalDir = path.join(projectDir, "vocals", vocalId);
  await fs.mkdir(vocalDir, { recursive: true });
  const dest = path.join(vocalDir, `${vocalId}${path.extname(source)}`);
  await fs.copyFile(source, dest);
  const record = {
    vocalId,
    planId,
    sourceKind,
    sourcePath: path.relative(ROOT, source),
    path: path.relative(projectDir, dest),
    sha256: await hashFile(dest),
    ingestedAt: nowIso(),
    status: "ingested",
  };
  const index = project.vocals.findIndex((item) => item.vocalId === vocalId);
  if (index >= 0) project.vocals[index] = record;
  else project.vocals.push(record);
  return record;
}

async function ingestCandidate(args) {
  const runId = await resolveProjectId(args);
  const project = await readProject(runId);
  const source = path.resolve(String(args.file ?? ""));
  if (!(await exists(source))) throw new Error("Missing readable --file.");
  const candidateId = String(
    args.candidate ?? `candidate-${String(project.candidates.length + 1).padStart(2, "0")}`,
  );
  await copyCandidate(project, source, candidateId, "manual");
  addAudit(project, "ingest-candidate", `Ingested ${candidateId}.`);
  await writeProject(project);
  console.log(`Ingested ${candidateId}`);
}

async function generateLive(args) {
  const runId = await resolveProjectId(args);
  const project = await readProject(runId);
  if (!project.prompts?.length) {
    const prompt = buildPrompt(project, "candidate-01", 0);
    project.prompts = [prompt];
  }
  const candidateId = String(args.candidate ?? project.prompts[0].candidateId);
  const prompt =
    project.prompts.find((item) => item.candidateId === candidateId) ?? project.prompts[0];
  const readiness = providerReadinessRecord();
  const attempt = {
    attemptId: `live-generation-${candidateId}-${Date.now()}`,
    candidateId,
    model: prompt.model,
    createdAt: nowIso(),
    providerReady: readiness.providerReady,
    status: "not_started",
  };
  const projectDir = path.join(ROOT, project.projectPath);
  if (args["dry-run"] || !readiness.providerReady) {
    attempt.status = args["dry-run"] ? "dry_run_ready" : "blocked_missing_credentials";
    attempt.toolCall = openclawToolCall(prompt);
    attempt.missingProviderKeys = providerEnvChecks()
      .filter((item) => !item.present)
      .map((item) => item.name);
    await writeJson(path.join(projectDir, "logs", `${attempt.attemptId}.json`), attempt);
    project.liveGeneration.attempts.push(attempt);
    project.liveGeneration.lastStatus = attempt.status;
    addAudit(project, "generate-live", `Live generation ${attempt.status} for ${candidateId}.`);
    await writeProject(project);
    console.log(`${attempt.status}: ${candidateId}`);
    return;
  }
  const message = `Call this tool exactly once and return all MEDIA paths:\n${openclawToolCall(prompt)}`;
  const result = await runCommand(
    "openclaw",
    [
      "agent",
      "--session-id",
      `music-creator-v1-${project.runId}`,
      "--message",
      message,
      "--json",
      "--local",
      "--timeout",
      "900",
    ],
    { timeoutMs: 900000 },
  );
  const parsed = tryParseJson(result.stdout);
  const audioPaths = await extractExistingAudioPaths(parsed, result.stdout, result.stderr);
  const taskIds = collectKeyValues(parsed, "taskId");
  const runIds = collectKeyValues(parsed, "runId");
  attempt.status = result.ok ? "submitted" : "failed";
  if (taskIds.length > 0) attempt.status = "task_started";
  if (audioPaths.length > 0) {
    await copyCandidate(project, audioPaths[0], candidateId, "openclaw_music_generate");
    attempt.status = "ingested";
  }
  attempt.stdout = result.stdout;
  attempt.stderr = result.stderr;
  attempt.parsed = parsed;
  attempt.taskIds = taskIds;
  attempt.runIds = runIds;
  attempt.audioPaths = audioPaths.map((item) => path.relative(ROOT, item));
  await writeJson(path.join(projectDir, "logs", `${attempt.attemptId}.json`), attempt);
  project.liveGeneration.attempts.push(attempt);
  project.liveGeneration.lastStatus = attempt.status;
  addAudit(project, "generate-live", `Live generation ${attempt.status} for ${candidateId}.`);
  await writeProject(project);
  console.log(`${attempt.status}: ${candidateId}`);
}

async function syncLiveOutput(args) {
  const runId = await resolveProjectId(args);
  const project = await readProject(runId);
  const latestAttempt = [...(project.liveGeneration?.attempts ?? [])]
    .reverse()
    .find((attempt) => attempt.taskIds?.length || attempt.runIds?.length);
  const lookup = String(
    args.task ?? latestAttempt?.taskIds?.[0] ?? latestAttempt?.runIds?.[0] ?? "",
  );
  if (!lookup && !args["task-output-file"]) {
    throw new Error("Missing --task and no task id/run id is recorded.");
  }
  const candidateId = String(
    args.candidate ??
      latestAttempt?.candidateId ??
      project.prompts?.[0]?.candidateId ??
      "candidate-01",
  );
  let result = { ok: true, stdout: "", stderr: "" };
  let parsed = null;
  if (args["task-output-file"]) {
    const taskOutputFile = path.resolve(String(args["task-output-file"]));
    if (!(await exists(taskOutputFile))) throw new Error("Missing readable --task-output-file.");
    result.stdout = await fs.readFile(taskOutputFile, "utf8");
    parsed = tryParseJson(result.stdout);
  } else {
    result = await runCommand("openclaw", ["tasks", "show", lookup, "--json"], {
      timeoutMs: 30000,
      maxBuffer: 1024 * 1024 * 8,
    });
    parsed = tryParseJson(result.stdout);
  }
  const audioPaths = await extractExistingAudioPaths(parsed, result.stdout, result.stderr);
  const attempt = {
    attemptId: `live-sync-${candidateId}-${Date.now()}`,
    candidateId,
    taskLookup: lookup || null,
    taskOutputFile: args["task-output-file"]
      ? path.resolve(String(args["task-output-file"]))
      : null,
    createdAt: nowIso(),
    status: result.ok ? "synced_no_audio" : "sync_failed",
    stdout: result.stdout,
    stderr: result.stderr,
    parsed,
    audioPaths: audioPaths.map((item) => path.relative(ROOT, item)),
  };
  if (audioPaths.length > 0) {
    await copyCandidate(project, audioPaths[0], candidateId, "openclaw_task_sync");
    attempt.status = "ingested";
  }
  const projectDir = path.join(ROOT, project.projectPath);
  await writeJson(path.join(projectDir, "logs", `${attempt.attemptId}.json`), attempt);
  project.liveGeneration.attempts.push(attempt);
  project.liveGeneration.lastStatus = attempt.status;
  addAudit(project, "sync-live-output", `Live output sync ${attempt.status} for ${candidateId}.`);
  await writeProject(project);
  console.log(`${attempt.status}: ${candidateId}`);
}

async function runQa(args) {
  const runId = await resolveProjectId(args);
  const project = await readProject(runId);
  const candidateId = String(args.candidate ?? project.candidates[0]?.candidateId ?? "");
  const candidate = project.candidates.find((item) => item.candidateId === candidateId);
  if (!candidate) throw new Error("No matching candidate to QA.");
  const ffprobe = await commandAvailable("ffprobe");
  const creativeTotal = Number.parseInt(String(args["creative-total"] ?? "0"), 10);
  const technicalPassed = ffprobe || Boolean(args["manual-technical-pass"]);
  candidate.qa = {
    schemaVersion: 1,
    candidateId,
    checkedAt: nowIso(),
    technical: {
      passed: technicalPassed,
      ffprobeAvailable: ffprobe,
      manualOverride: Boolean(args["manual-technical-pass"]),
    },
    creative: {
      total: Number.isFinite(creativeTotal) ? Math.max(0, Math.min(100, creativeTotal)) : 0,
    },
    draftReady: technicalPassed && creativeTotal >= 75 && !project.compliance?.blocksDraft,
  };
  candidate.status = candidate.qa.draftReady ? "qa_passed" : "qa_failed";
  project.status = candidate.qa.draftReady ? STATUSES.QA_PASSED : STATUSES.QA_FAILED;
  await writeJson(
    path.join(ROOT, project.projectPath, "qa", `${candidateId}-qa.json`),
    candidate.qa,
  );
  addAudit(project, "qa", `QA completed for ${candidateId}.`);
  await writeProject(project);
  console.log(`QA completed for ${candidateId}: ${project.status}`);
}

async function selectCandidate(args) {
  const runId = await resolveProjectId(args);
  const project = await readProject(runId);
  const candidateId = String(args.candidate ?? "");
  const candidate = project.candidates.find((item) => item.candidateId === candidateId);
  if (!candidate?.qa?.draftReady) throw new Error(`Candidate ${candidateId} is not draft-ready.`);
  const projectDir = path.join(ROOT, project.projectPath);
  const source = path.join(projectDir, candidate.path);
  if (!(await exists(source))) throw new Error(`Candidate audio is missing: ${candidate.path}`);
  await fs.mkdir(path.join(projectDir, "selected"), { recursive: true });
  const dest = path.join(projectDir, "selected", path.basename(candidate.path));
  await fs.copyFile(source, dest);
  candidate.selectedPath = path.relative(projectDir, dest);
  candidate.selectedAt = nowIso();
  candidate.selectedSha256 = await hashFile(dest);
  project.selectedCandidateId = candidateId;
  project.status = STATUSES.SELECTED;
  addAudit(project, "select", `Selected ${candidateId}.`);
  await writeProject(project);
  console.log(`Selected ${candidateId}`);
}

async function setReleaseGate(args) {
  const runId = await resolveProjectId(args);
  const project = await readProject(runId);
  const gate = String(args.gate ?? "");
  if (!gate) throw new Error("Missing --gate.");
  if (!Object.hasOwn(project.releaseGates, gate)) throw new Error(`Unknown release gate: ${gate}`);
  const rawValue = String(args.value ?? "true").toLowerCase();
  const value = ["1", "true", "yes", "y", "on"].includes(rawValue);
  project.releaseGates[gate] = value;
  addAudit(project, "set-release-gate", `${gate}=${value}`);
  await writeProject(project);
  console.log(`${gate}: ${value}`);
}

function publishPackageMarkdown(project, selected, blockers) {
  return `# Publish Package

Run id: ${project.runId}

Status: ${blockers.length === 0 ? "publish_ready" : "publish_blocked"}

Selected audio: ${selected?.selectedPath ?? "none"}
Selected sha256: ${selected?.selectedSha256 ?? selected?.sha256 ?? "none"}

## Release Gates

${Object.entries(project.releaseGates ?? {})
  .map(([key, value]) => `- ${key}: ${value ? "approved" : "missing"}`)
  .join("\n")}

## Blockers

${blockers.length === 0 ? "- None" : blockers.map((blocker) => `- ${blocker}`).join("\n")}

## Policy

Public publishing, distribution, monetization, Content ID, and copyright claims remain prohibited unless this package is publish_ready and the operator has explicit authority for the target platform.
`;
}

async function publishPackage(args) {
  const runId = await resolveProjectId(args);
  const project = await readProject(runId);
  const selected = project.candidates.find(
    (candidate) => candidate.candidateId === project.selectedCandidateId,
  );
  const blockers = releaseBlockers(project, selected);
  project.status = blockers.length ? STATUSES.PUBLISH_BLOCKED : STATUSES.PUBLISH_READY;
  const projectDir = path.join(ROOT, project.projectPath);
  await fs.mkdir(path.join(projectDir, "publish-package"), { recursive: true });
  await writeJson(path.join(projectDir, "publish-package", "release-readiness.json"), {
    schemaVersion: 1,
    runId,
    selectedCandidateId: selected?.candidateId ?? null,
    selectedPath: selected?.selectedPath ?? null,
    selectedSha256: selected?.selectedSha256 ?? selected?.sha256 ?? null,
    status: project.status,
    releaseReady: blockers.length === 0,
    releaseGates: project.releaseGates,
    blockers,
    checkedAt: nowIso(),
  });
  await writeText(
    path.join(projectDir, "publish-package", "publish-package.md"),
    publishPackageMarkdown(project, selected, blockers),
  );
  addAudit(project, "publish-package", project.status);
  await writeProject(project);
  console.log(project.status);
}

function candidateAudioRelativePath(candidate) {
  return candidate.selectedPath ?? candidate.path ?? null;
}

async function newestDirectory(parent) {
  const entries = await fs.readdir(parent, { withFileTypes: true }).catch(() => []);
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const file = path.join(parent, entry.name);
    const stat = await fs.stat(file);
    dirs.push({ file, name: entry.name, mtimeMs: stat.mtimeMs });
  }
  dirs.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return dirs[0] ?? null;
}

async function newestJsonFile(parent) {
  const entries = await fs.readdir(parent, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name.startsWith(".")) continue;
    const file = path.join(parent, entry.name);
    const stat = await fs.stat(file);
    files.push({ file, name: entry.name, mtimeMs: stat.mtimeMs });
  }
  files.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return files[0] ?? null;
}

function resolveSource(project, sourceId) {
  if (!sourceId) return project.sources.at(-1) ?? null;
  return (
    project.sources.find((item) => item.sourceId === sourceId) ??
    project.candidates.find((item) => item.candidateId === sourceId) ??
    null
  );
}

async function readLyrics(args) {
  if (args["lyrics-file"]) {
    const lyricsFile = path.resolve(String(args["lyrics-file"]));
    if (!(await exists(lyricsFile))) throw new Error("Missing readable --lyrics-file.");
    return fs.readFile(lyricsFile, "utf8");
  }
  return String(args.lyrics ?? "").trim();
}

function vocalPromptFor(project, source, lyrics, direction, mode) {
  const sourceLabel = source?.sourceId ?? source?.candidateId ?? "current track";
  const lyricLine = lyrics
    ? "Use the supplied original lyrics exactly unless the request asks for refinement."
    : "Create original lyrics if needed.";
  return [
    `Create an original vocal layer for ${project.request}.`,
    `Source audio reference: ${sourceLabel}.`,
    `Vocal direction: ${direction || "tasteful lead vocal with optional harmonies"}.`,
    `Mode: ${mode}.`,
    lyricLine,
    "Avoid artist imitation, celebrity voice cloning, copyrighted lyrics, uncleared samples, and misleading real-person voice.",
    "Return a clean vocal-forward result suitable for importing into GarageBand.",
  ].join(" ");
}

function cloudVocalBrief(project, source, plan) {
  return `# Cloud Vocal Brief

Project: ${project.runId}
Source: ${source?.sourceId ?? source?.candidateId ?? "none"}
Vocal plan: ${plan.vocalPlanId}

## Direction

${plan.direction}

## Rights and Safety

- Use original lyrics and original vocal identity only.
- Do not imitate a living artist or clone a real person without written permission.
- Do not use copyrighted lyrics, uncleared samples, or protected melodies.
- Keep model/tool rights evidence for any cloud service used.

## Lyrics

${plan.lyrics || "(No lyrics supplied. Create original lyrics.)"}

## Delivery

Export the vocal or vocal-forward result as WAV, AIFF, MP3, or M4A. Then run:

\`\`\`bash
node music-creator-v1/scripts/music-creator-v1.mjs vocal-ingest --project ${project.runId} --plan ${plan.vocalPlanId} --file <vocal-audio>
node music-creator-v1/scripts/music-creator-v1.mjs bridge-export --project ${project.runId} --vocal <vocal-id>
\`\`\`
`;
}

async function kitsListVoices(args = {}) {
  const page = Number.parseInt(String(args.page ?? "1"), 10);
  const perPage = Number.parseInt(String(args["per-page"] ?? args.perPage ?? "20"), 10);
  const params = new URLSearchParams({
    page: String(Number.isFinite(page) ? page : 1),
    perPage: String(Number.isFinite(perPage) ? perPage : 20),
    order: String(args.order ?? "asc"),
  });
  if (args["my-models"] ?? args.myModels) params.set("myModels", "true");
  if (args.instruments) params.set("instruments", "true");
  const result = await fetchJson(`${KITS_API_BASE}/voice-models?${params.toString()}`, {
    headers: kitsHeaders(),
  });
  await writeJson(path.join(STATE_DIR, "kits-voices.json"), {
    schemaVersion: 1,
    checkedAt: nowIso(),
    source: "Kits AI voice-models API",
    result,
  });
  for (const voice of result?.data ?? []) {
    const tags = Array.isArray(voice.tags) ? voice.tags.join(", ") : "";
    console.log(`${voice.id}\t${voice.title}${tags ? `\t${tags}` : ""}`);
  }
  if (result?.meta) {
    console.log(
      `Page ${result.meta.currentPage ?? page}/${result.meta.lastPage ?? "?"}, total ${result.meta.total ?? "?"}`,
    );
  }
}

async function kitsConvert(args) {
  const runId = await resolveProjectId(args);
  const project = await readProject(runId);
  const voiceModelId = String(args.voice ?? args["voice-model-id"] ?? "");
  if (!voiceModelId) throw new Error("Missing --voice <Kits voiceModelId>.");
  const planId = args.plan ? String(args.plan) : (project.vocalPlans.at(-1)?.vocalPlanId ?? null);
  const plan = planId ? project.vocalPlans.find((item) => item.vocalPlanId === planId) : null;
  if (plan?.compliance?.blocksDraft) {
    throw new Error(
      `Vocal plan ${planId} is blocked by compliance: ${plan.compliance.matchedRules
        .map((rule) => rule.id)
        .join(", ")}`,
    );
  }
  const source = args.file ? path.resolve(String(args.file)) : null;
  if (!source || !(await exists(source))) throw new Error("Missing readable --file vocal audio.");
  const form = new FormData();
  form.set("voiceModelId", voiceModelId);
  const audio = await fs.readFile(source);
  form.set("soundFile", new Blob([audio]), path.basename(source));
  for (const [argName, fieldName] of [
    ["conversion-strength", "conversionStrength"],
    ["model-volume-mix", "modelVolumeMix"],
    ["pitch-shift", "pitchShift"],
  ]) {
    if (args[argName] !== undefined) form.set(fieldName, String(args[argName]));
  }
  const job = await fetchJson(`${KITS_API_BASE}/voice-conversions`, {
    method: "POST",
    headers: kitsHeaders(),
    body: form,
  });
  const record = {
    schemaVersion: 1,
    provider: "kits",
    type: "voice-conversion",
    project: runId,
    planId,
    voiceModelId,
    inputAudio: path.relative(ROOT, source),
    job,
    submittedAt: nowIso(),
    status: job?.status ?? "submitted",
    secretPolicy: "KITS_API_KEY was used from the environment and was not written.",
  };
  const projectDir = path.join(ROOT, project.projectPath);
  await writeJson(
    path.join(projectDir, "logs", `kits-conversion-${job?.id ?? Date.now()}.json`),
    record,
  );
  project.vocals.push({
    vocalId: `kits-job-${job?.id ?? Date.now()}`,
    planId,
    sourceKind: "kits_voice_conversion",
    sourcePath: path.relative(ROOT, source),
    voiceModelId,
    kitsJobId: job?.id ?? null,
    status: job?.status ?? "submitted",
    submittedAt: nowIso(),
  });
  addAudit(project, "kits-convert", `Submitted Kits voice conversion job ${job?.id ?? "unknown"}.`);
  await writeProject(project);
  console.log(`Kits conversion submitted: ${job?.id ?? "unknown"}`);
}

function jobOutputUrl(job) {
  return job?.outputFileUrl ?? job?.lossyOutputFileUrl ?? job?.recombinedAudioFileUrl ?? null;
}

function audioExtensionFromUrl(url) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    return AUDIO_EXTENSIONS.has(ext) ? ext : ".wav";
  } catch {
    return ".wav";
  }
}

async function downloadUrlToFile(url, file) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed ${response.status}: ${response.statusText}`);
  const arrayBuffer = await response.arrayBuffer();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.from(arrayBuffer));
}

async function kitsSync(args) {
  const runId = await resolveProjectId(args);
  const project = await readProject(runId);
  const jobId = String(args.job ?? args["job-id"] ?? "");
  if (!jobId) throw new Error("Missing --job <Kits job id>.");
  const job = await fetchJson(`${KITS_API_BASE}/voice-conversions/${jobId}`, {
    headers: kitsHeaders(),
  });
  const projectDir = path.join(ROOT, project.projectPath);
  await writeJson(path.join(projectDir, "logs", `kits-sync-${jobId}.json`), {
    schemaVersion: 1,
    provider: "kits",
    syncedAt: nowIso(),
    job,
  });
  const outputUrl = jobOutputUrl(job);
  if (job?.status !== "success" || !outputUrl) {
    for (const vocal of project.vocals) {
      if (String(vocal.kitsJobId) === jobId) vocal.status = job?.status ?? "unknown";
    }
    addAudit(project, "kits-sync", `Kits job ${jobId} status ${job?.status ?? "unknown"}.`);
    await writeProject(project);
    console.log(`Kits job ${jobId}: ${job?.status ?? "unknown"}`);
    return;
  }
  const vocalId = String(args.vocal ?? `kits-vocal-${jobId}`);
  const outputFile = path.join(
    projectDir,
    "logs",
    `kits-download-${jobId}${audioExtensionFromUrl(outputUrl)}`,
  );
  await downloadUrlToFile(outputUrl, outputFile);
  const record = await copyVocalAudio(
    project,
    outputFile,
    vocalId,
    "kits_voice_conversion",
    args.plan ? String(args.plan) : null,
  );
  record.kitsJobId = jobId;
  record.voiceModelId = job.voiceModelId ?? null;
  for (const vocal of project.vocals) {
    if (String(vocal.kitsJobId) === jobId) {
      vocal.status = "ingested";
      vocal.path = record.path;
      vocal.sha256 = record.sha256;
    }
  }
  addAudit(project, "kits-sync", `Downloaded and ingested Kits job ${jobId} as ${vocalId}.`);
  await writeProject(project);
  console.log(`Kits vocal ingested: ${vocalId}`);
}

async function bridgeInit(args = {}) {
  const bridgeRoot = await resolveBridgeRoot(args);
  await ensureBridgeDirs(bridgeRoot);
  const signingKey = await ensureBridgeSigningPublicKey();
  const gatewayHost = String(args["gateway-host"] ?? (await detectTailnetIp()) ?? "127.0.0.1");
  const gatewayPort = String(args["gateway-port"] ?? process.env.OPENCLAW_GATEWAY_PORT ?? "18789");
  const gatewayTls =
    args["gateway-tls"] === true ||
    String(args["gateway-tls"]).toLowerCase() === "true" ||
    gatewayPort === "443" ||
    gatewayHost.endsWith(".ts.net");
  const config = {
    schemaVersion: 1,
    bridgeRoot,
    createdAt: nowIso(),
    studioMachine: await localComputerName(),
    transport: "shared-folder",
    nodePairing: {
      gatewayHost,
      gatewayPort: Number(gatewayPort),
      gatewayTls,
      displayName: "GarageBand MacBook",
      privateWsOptInRequired:
        !gatewayTls && gatewayHost !== "127.0.0.1" && gatewayHost !== "localhost",
      secretPolicy: "Gateway tokens are never written into the iCloud bridge.",
    },
    remoteExecution: {
      enabledByDefault: false,
      status: "deprecated_for_safety",
      replacement: "macbook-pull-agent.command",
      note: "Remote Login/SSH is not required for the safer pull-agent bridge.",
    },
    pullAgent: {
      mode: "macbook_polls_signed_jobs",
      publicKeyFile: "macstudio-bridge-signing.pub.pem",
      privateKeyLocation: "music-creator-v1/state/garageband-bridge-signing-key.pem",
      privateKeyWrittenToBridge: false,
      allowedActions: [...BRIDGE_AGENT_ACTIONS],
      requestFolder: "to-macbook/requests",
      resultFolder: "from-macbook/agent-results",
    },
    folders: {
      toMacBook: path.join(bridgeRoot, "to-macbook"),
      fromMacBook: path.join(bridgeRoot, "from-macbook"),
      logs: path.join(bridgeRoot, "logs"),
    },
    defaults: {
      garageBandPlugin: "Valhalla Supermassive AU",
      openClawHost: "Mac Studio",
      garageBandHost: "MacBook",
    },
  };
  await writeJson(path.join(bridgeRoot, "bridge-config.json"), config);
  await writeText(path.join(bridgeRoot, "macstudio-bridge-signing.pub.pem"), signingKey.publicKey);
  await writeText(path.join(bridgeRoot, "MACBOOK_SETUP.md"), macbookSetupMarkdown(bridgeRoot));
  const disableRemoteExecCommand = path.join(bridgeRoot, "macbook-disable-remote-exec.command");
  await writeText(disableRemoteExecCommand, macbookDisableRemoteExecCommand());
  await fs.chmod(disableRemoteExecCommand, 0o755);
  const pullAgentCommand = path.join(bridgeRoot, "macbook-pull-agent.command");
  await writeText(pullAgentCommand, macbookPullAgentCommand());
  await fs.chmod(pullAgentCommand, 0o755);
  const pullAgentOnceCommand = path.join(bridgeRoot, "macbook-pull-agent-once.command");
  await writeText(pullAgentOnceCommand, macbookPullAgentOnceCommand());
  await fs.chmod(pullAgentOnceCommand, 0o755);
  const syncCheckCommand = path.join(bridgeRoot, "macbook-sync-check.command");
  await writeText(syncCheckCommand, macbookSyncCheckCommand());
  await fs.chmod(syncCheckCommand, 0o755);
  const safeStartCommand = path.join(bridgeRoot, "macbook-start-safe-bridge.command");
  await writeText(safeStartCommand, macbookStartSafeBridgeCommand());
  await fs.chmod(safeStartCommand, 0o755);
  const runMeCommand = path.join(bridgeRoot, "00-RUN-ME-MACBOOK-SAFE-BRIDGE.command");
  await writeText(runMeCommand, macbookRunMeSafeBridgeCommand());
  await fs.chmod(runMeCommand, 0o755);
  await writeText(
    path.join(bridgeRoot, "00-RUN-ME-MACBOOK-SAFE-BRIDGE-README.md"),
    macbookRunMeReadme(),
  );
  const enrollmentCommand = path.join(bridgeRoot, "macstudio-open-node-enrollment.command");
  await writeText(enrollmentCommand, macstudioOpenNodeEnrollmentCommand(ROOT));
  await fs.chmod(enrollmentCommand, 0o755);
  const pairNodeCommand = path.join(bridgeRoot, "macbook-pair-openclaw-node.command");
  await writeText(pairNodeCommand, macbookPairNodeCommand(gatewayHost, gatewayPort, gatewayTls));
  await fs.chmod(pairNodeCommand, 0o755);
  const pairNodeWindowCommand = path.join(bridgeRoot, "macbook-pair-openclaw-node-window.command");
  await writeText(
    pairNodeWindowCommand,
    macbookPairNodeCommand(gatewayHost, gatewayPort, gatewayTls, { tokenMode: "window" }),
  );
  await fs.chmod(pairNodeWindowCommand, 0o755);
  const enableRemoteExecCommand = path.join(bridgeRoot, "macbook-enable-remote-exec.command");
  const remoteExecPublicKey = path.join(bridgeRoot, "macstudio-openclaw-bridge.pub");
  if (args["include-remote-exec"]) {
    const remoteExecKey = await ensureMacBookRemoteExecPublicKey();
    await writeText(remoteExecPublicKey, remoteExecKey.publicKey);
    await writeText(enableRemoteExecCommand, macbookEnableRemoteExecCommand());
    await fs.chmod(enableRemoteExecCommand, 0o755);
  } else {
    await fs.rm(enableRemoteExecCommand, { force: true });
    await fs.rm(remoteExecPublicKey, { force: true });
  }
  const setupCommand = path.join(bridgeRoot, "macbook-finish-setup.command");
  await writeText(setupCommand, macbookFinishSetupCommand());
  await fs.chmod(setupCommand, 0o755);
  const latestCommand = path.join(bridgeRoot, "macbook-open-latest.command");
  await writeText(latestCommand, macbookOpenLatestCommand());
  await fs.chmod(latestCommand, 0o755);
  const sendCommand = path.join(bridgeRoot, "macbook-send-audio-to-openclaw.command");
  await writeText(sendCommand, macbookSendAudioCommand());
  await fs.chmod(sendCommand, 0o755);
  console.log(`Bridge initialized: ${bridgeRoot}`);
}

function resolveBridgeExportItem(project, args) {
  const projectDir = path.join(ROOT, project.projectPath);
  if (args.file) {
    const file = path.resolve(String(args.file));
    return {
      id: String(args.label ?? path.basename(file, path.extname(file))),
      kind: "file",
      source: file,
      details: { sourcePath: path.relative(ROOT, file) },
    };
  }
  if (args.vocal) {
    const vocal = project.vocals.find((item) => item.vocalId === String(args.vocal));
    if (!vocal) throw new Error(`Unknown vocal: ${args.vocal}`);
    return {
      id: vocal.vocalId,
      kind: "vocal",
      source: path.join(projectDir, vocal.path),
      details: vocal,
    };
  }
  if (args.source) {
    const sourceAsset = project.sources.find((item) => item.sourceId === String(args.source));
    if (!sourceAsset) throw new Error(`Unknown source: ${args.source}`);
    return {
      id: sourceAsset.sourceId,
      kind: "source",
      source: path.join(projectDir, sourceAsset.path),
      details: sourceAsset,
    };
  }
  const candidateId = String(
    args.candidate ?? project.selectedCandidateId ?? project.candidates[0]?.candidateId ?? "",
  );
  const candidate = project.candidates.find((item) => item.candidateId === candidateId);
  if (!candidate)
    throw new Error("No candidate found to export. Run generate-live or ingest-candidate first.");
  const relativeAudioPath = candidateAudioRelativePath(candidate);
  if (!relativeAudioPath) throw new Error(`Candidate ${candidateId} has no audio path.`);
  return {
    id: candidateId,
    kind: "candidate",
    source: path.join(projectDir, relativeAudioPath),
    details: candidate,
  };
}

async function bridgeExport(args) {
  const runId = await resolveProjectId(args);
  const project = await readProject(runId);
  const bridgeRoot = await resolveBridgeRoot(args);
  await ensureBridgeDirs(bridgeRoot);
  const exportItem = resolveBridgeExportItem(project, args);
  const source = exportItem.source;
  if (!(await exists(source))) throw new Error(`Export audio is missing: ${source}`);

  const jobId = `${project.runId}-${exportItem.kind}-${exportItem.id}-${Date.now()}`;
  const jobDir = path.join(bridgeRoot, "to-macbook", jobId);
  const audioDir = path.join(jobDir, "audio");
  await fs.mkdir(audioDir, { recursive: true });
  const audioFileName = path.basename(source);
  const dest = path.join(audioDir, audioFileName);
  await fs.copyFile(source, dest);
  const sha256 = await hashFile(dest);
  const prompt =
    exportItem.kind === "candidate"
      ? (project.prompts?.find((item) => item.candidateId === exportItem.id) ?? null)
      : null;
  const job = {
    schemaVersion: 1,
    jobId,
    status: "exported_to_macbook",
    createdAt: nowIso(),
    studioMachine: await localComputerName(),
    project: {
      runId: project.runId,
      request: project.request,
      artist: project.artist,
      platform: project.platform,
      durationSeconds: project.durationSeconds,
      instrumental: project.instrumental,
    },
    exportItem: {
      id: exportItem.id,
      kind: exportItem.kind,
      sourcePath: path.relative(ROOT, source),
      bridgeAudioPath: path.relative(bridgeRoot, dest),
      sha256,
      details: exportItem.details,
    },
    prompt,
    macBookInstructions: [
      "Open open-in-garageband.command on the MacBook.",
      "GarageBand will open and Finder will reveal the audio file.",
      "Drag the file into GarageBand, edit/arrange with local AU plugins, then bounce/export audio into from-macbook/<job-id>/.",
      "Run bridge-ingest on the Mac Studio to pull the returned audio back into Music Creator V1.",
    ],
  };
  await writeJson(path.join(jobDir, "job.json"), job);
  await writeText(
    path.join(jobDir, "README.md"),
    `# GarageBand Bridge Job\n\nJob: ${jobId}\nProject: ${project.runId}\nType: ${exportItem.kind}\nItem: ${exportItem.id}\n\nRun \`open-in-garageband.command\` on the MacBook.\n\nAfter GarageBand editing, export the bounced WAV/AIFF/MP3 into:\n\n\`\`\`text\n${path.join(bridgeRoot, "from-macbook", jobId)}\n\`\`\`\n`,
  );
  await writeText(
    path.join(jobDir, "import-to-garageband.applescript"),
    garageBandImportAppleScript(jobId),
  );
  const openCommand = path.join(jobDir, "open-in-garageband.command");
  await writeText(openCommand, garageBandOpenCommand(jobId, audioFileName));
  await fs.chmod(openCommand, 0o755);
  project.bridge.exports.push({
    jobId,
    itemId: exportItem.id,
    itemKind: exportItem.kind,
    bridgeRoot,
    jobPath: path.relative(bridgeRoot, jobDir),
    audioPath: path.relative(bridgeRoot, dest),
    sha256,
    exportedAt: nowIso(),
    status: "exported_to_macbook",
  });
  addAudit(
    project,
    "bridge-export",
    `Exported ${exportItem.kind} ${exportItem.id} to GarageBand bridge job ${jobId}.`,
  );
  await writeProject(project);
  console.log(`Bridge job exported: ${jobId}`);
  console.log(path.join(bridgeRoot, "to-macbook", jobId));
}

async function queueBridgeRequest(bridgeRoot, action, options = {}) {
  if (!BRIDGE_AGENT_ACTIONS.has(action)) {
    throw new Error(
      `Unsupported bridge action: ${action}. Allowed: ${[...BRIDGE_AGENT_ACTIONS].join(", ")}`,
    );
  }
  await ensureBridgeDirs(bridgeRoot);
  await ensureBridgeSigningPublicKey();
  const ttlSeconds = Math.max(30, Number.parseInt(String(options.ttlSeconds ?? "600"), 10));
  const requestId = String(
    options.requestId ?? `bridge-${action}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
  );
  if (!/^[A-Za-z0-9._:-]+$/.test(requestId)) throw new Error("Unsafe --request id.");
  const targetJobId = String(options.targetJobId ?? "");
  if (targetJobId && !/^[A-Za-z0-9._:-]+$/.test(targetJobId)) {
    throw new Error("Unsafe --job id. Use the bridge job id only, not a path.");
  }
  if (action === "open-bridge-job" && !targetJobId) {
    throw new Error("open-bridge-job requires --job <bridge-job-id>.");
  }
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const request = {
    schemaVersion: 1,
    requestId,
    action,
    status: "queued",
    createdAt,
    expiresAt,
    studioMachine: await localComputerName(),
    target: targetJobId ? { jobId: targetJobId } : {},
    safety: {
      remoteLoginUsed: false,
      arbitraryCommandsAllowed: false,
      arbitraryPathsAllowed: false,
      allowedActions: [...BRIDGE_AGENT_ACTIONS],
      operatorNote:
        "The MacBook pull agent validates this signature and action whitelist before doing anything.",
    },
  };
  const requestFile = path.join(bridgeRoot, "to-macbook", "requests", `${requestId}.json`);
  await writeJson(requestFile, request);
  await fs.writeFile(`${requestFile}.sig`, await signBridgeRequestFile(requestFile));
  return { requestId, requestFile, action, expiresAt };
}

async function bridgeQueueJob(args) {
  const bridgeRoot = await resolveBridgeRoot(args);
  const queued = await queueBridgeRequest(bridgeRoot, String(args.action ?? "health-check"), {
    requestId: args.request,
    ttlSeconds: args["ttl-seconds"],
    targetJobId: args.job ?? args["bridge-job"],
  });
  console.log(`Queued signed MacBook bridge request: ${queued.requestId}`);
  console.log(`Action: ${queued.action}`);
  console.log(`Expires: ${queued.expiresAt}`);
}

async function writeBridgeSyncProbe(bridgeRoot, probeId) {
  if (!/^[A-Za-z0-9._:-]+$/.test(probeId)) throw new Error("Unsafe --probe id.");
  const probe = {
    schemaVersion: 1,
    probeId,
    status: "mac_studio_probe_written",
    createdAt: nowIso(),
    studioMachine: await localComputerName(),
    remoteLoginUsed: false,
    expectedReply: `sync/macbook/${probeId}.json`,
    nextAction:
      "On the MacBook, run macbook-sync-check.command from the same bridge folder. Then run bridge-sync-status on the Mac Studio.",
  };
  await writeJson(path.join(bridgeRoot, "sync", "mac-studio", `${probeId}.json`), probe);
  await writeJson(LATEST_BRIDGE_SYNC_PATH, {
    schemaVersion: 1,
    status: "probe_written_waiting_for_macbook",
    checkedAt: nowIso(),
    bridgeRoot,
    probeId,
    replySeen: false,
    nextAction: probe.nextAction,
  });
  return probe;
}

async function bridgeSyncProbe(args = {}) {
  const bridgeRoot = await resolveBridgeRoot(args);
  await ensureBridgeDirs(bridgeRoot);
  const probeId = String(
    args.probe ?? `sync-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
  );
  await writeBridgeSyncProbe(bridgeRoot, probeId);
  console.log(`Bridge sync probe written: ${probeId}`);
  console.log("Next: run macbook-sync-check.command on the MacBook after the probe syncs there.");
}

async function bridgeSyncStatus(args = {}) {
  const bridgeRoot = await resolveBridgeRoot(args);
  await ensureBridgeDirs(bridgeRoot);
  const probeDir = path.join(bridgeRoot, "sync", "mac-studio");
  const probeRecord = args.probe
    ? { file: path.join(probeDir, `${args.probe}.json`), name: `${args.probe}.json` }
    : await newestJsonFile(probeDir);
  const probe = probeRecord?.file ? await readJsonOptional(probeRecord.file, null) : null;
  const probeId = String(args.probe ?? probe?.probeId ?? "");
  const replyPath = probeId ? path.join(bridgeRoot, "sync", "macbook", `${probeId}.json`) : "";
  const reply = replyPath ? await readJsonOptional(replyPath, null) : null;
  const status = {
    schemaVersion: 1,
    checkedAt: nowIso(),
    bridgeRoot,
    probeId: probeId || null,
    probeSeen: Boolean(probe),
    replySeen: Boolean(reply),
    verifiedBidirectionalSync:
      Boolean(probe?.probeId) && Boolean(reply?.probeId) && probe.probeId === reply.probeId,
    probeCreatedAt: probe?.createdAt ?? null,
    replyUpdatedAt: reply?.updatedAt ?? null,
    macBookComputerName: reply?.computerName ?? null,
    remoteLoginUsed: Boolean(reply?.remoteLoginUsed),
    nextAction: reply
      ? "Sync is verified. Run bridge-queue-job and macbook-pull-agent.command for safe automation."
      : "Waiting for MacBook reply. Make sure both machines use the same editable bridge folder, then run macbook-sync-check.command on the MacBook.",
  };
  await writeJson(LATEST_BRIDGE_SYNC_PATH, status);
  console.log(`Bridge sync probe: ${status.probeId ?? "none"}`);
  console.log(`Probe seen on Mac Studio: ${status.probeSeen ? "yes" : "no"}`);
  console.log(`MacBook reply seen: ${status.replySeen ? "yes" : "no"}`);
  console.log(
    `Bidirectional sync: ${status.verifiedBidirectionalSync ? "verified" : "not verified"}`,
  );
  console.log(`Remote Login used: ${status.remoteLoginUsed ? "yes" : "no"}`);
  console.log(`Next action: ${status.nextAction}`);
}

async function chmodCommandFiles(parent) {
  const entries = await fs.readdir(parent, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const file = path.join(parent, entry.name);
    if (entry.isDirectory()) await chmodCommandFiles(file);
    else if (entry.isFile() && entry.name.endsWith(".command")) await fs.chmod(file, 0o755);
  }
}

async function copyToMacBookJobsWithoutRequestQueue(sourceBridgeRoot, kitRoot) {
  const sourceToMacBook = path.join(sourceBridgeRoot, "to-macbook");
  const destToMacBook = path.join(kitRoot, "to-macbook");
  await fs.mkdir(destToMacBook, { recursive: true });
  const entries = await fs.readdir(sourceToMacBook, { withFileTypes: true }).catch(() => []);
  const copied = [];
  for (const entry of entries) {
    if (entry.name === "requests" || entry.name.startsWith(".")) continue;
    const source = path.join(sourceToMacBook, entry.name);
    const dest = path.join(destToMacBook, entry.name);
    await fs.cp(source, dest, { force: true, recursive: true });
    copied.push(entry.name);
  }
  return copied.sort();
}

async function bridgeMakeTransferKit(args = {}) {
  const sourceBridgeRoot = await resolveBridgeRoot(args);
  const initArgs = { ...args };
  delete initArgs["include-remote-exec"];
  await bridgeInit(initArgs);

  const createdAt = nowIso();
  const kitId = safeBridgeFileName(
    args.kit ?? `safe-transfer-${createdAt.replace(/[:.]/g, "-")}`,
    "safe-transfer-kit",
  );
  const kitBase = path.resolve(String(args["output-root"] ?? BRIDGE_TRANSFER_KITS_DIR));
  const kitParent = path.join(kitBase, kitId);
  const kitRoot = path.join(kitParent, BRIDGE_ROOT_NAME);
  await fs.rm(kitParent, { force: true, recursive: true });
  await ensureBridgeDirs(kitRoot);

  const probeId = safeBridgeFileName(
    args.probe ?? `transfer-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
    "transfer-probe",
  );
  await writeBridgeSyncProbe(sourceBridgeRoot, probeId);
  const queued = args["no-health-job"]
    ? null
    : await queueBridgeRequest(sourceBridgeRoot, "health-check", {
        requestId: `transfer-health-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
        ttlSeconds: args["ttl-seconds"] ?? "86400",
      });

  const rootFiles = [
    "00-RUN-ME-MACBOOK-SAFE-BRIDGE-README.md",
    "00-RUN-ME-MACBOOK-SAFE-BRIDGE.command",
    "MACBOOK_SETUP.md",
    "bridge-config.json",
    "macbook-disable-remote-exec.command",
    "macbook-finish-setup.command",
    "macbook-open-latest.command",
    "macbook-pull-agent-once.command",
    "macbook-pull-agent.command",
    "macbook-send-audio-to-openclaw.command",
    "macbook-start-safe-bridge.command",
    "macbook-sync-check.command",
    "macstudio-bridge-signing.pub.pem",
  ];
  const copiedRootFiles = [];
  for (const file of rootFiles) {
    if (await copyIfExists(path.join(sourceBridgeRoot, file), path.join(kitRoot, file))) {
      copiedRootFiles.push(file);
    }
  }
  const copiedBridgeJobs = await copyToMacBookJobsWithoutRequestQueue(sourceBridgeRoot, kitRoot);
  if (queued) {
    await copyIfExists(
      queued.requestFile,
      path.join(kitRoot, "to-macbook", "requests", path.basename(queued.requestFile)),
    );
    await copyIfExists(
      `${queued.requestFile}.sig`,
      path.join(kitRoot, "to-macbook", "requests", `${path.basename(queued.requestFile)}.sig`),
    );
  }
  await copyIfExists(
    path.join(sourceBridgeRoot, "sync", "mac-studio", `${probeId}.json`),
    path.join(kitRoot, "sync", "mac-studio", `${probeId}.json`),
  );
  await fs.rm(path.join(kitRoot, "macbook-enable-remote-exec.command"), { force: true });
  await fs.rm(path.join(kitRoot, "macstudio-openclaw-bridge.pub"), { force: true });
  await writeText(
    path.join(kitRoot, "RETURN-TO-MAC-STUDIO-README.md"),
    bridgeTransferKitReadme({ kitId, sourceBridgeRoot, createdAt }),
  );
  await chmodCommandFiles(kitRoot);

  const status = {
    schemaVersion: 1,
    status: "transfer_kit_created",
    createdAt,
    kitId,
    sourceBridgeRoot,
    kitRoot,
    copiedRootFiles,
    copiedBridgeJobs,
    copiedSubtrees: [
      "to-macbook jobs without existing request queue",
      "fresh sync/mac-studio probe",
    ],
    freshProbeId: probeId,
    queuedHealthRequestId: queued?.requestId ?? null,
    safety: {
      remoteLoginUsed: false,
      sshIncluded: false,
      privateSigningKeyIncluded: false,
      arbitraryCommandsAllowed: false,
      importExecutesReturnedFiles: false,
    },
    nextAction:
      "AirDrop or copy the kit folder to the MacBook, run 00-RUN-ME-MACBOOK-SAFE-BRIDGE.command there, then return the folder and run bridge-import-transfer-return.",
  };
  await writeJson(LATEST_BRIDGE_TRANSFER_PATH, status);
  console.log(`Safe transfer kit created: ${kitRoot}`);
  console.log(`Fresh sync probe: ${probeId}`);
  console.log(`Queued health-check request: ${queued?.requestId ?? "skipped"}`);
  console.log(
    "Next: transfer the kit folder to the MacBook and run 00-RUN-ME-MACBOOK-SAFE-BRIDGE.command.",
  );
}

async function resolveReturnedBridgeRoot(rawRoot) {
  const root = path.resolve(String(rawRoot));
  const nested = path.join(root, BRIDGE_ROOT_NAME);
  if (await exists(path.join(nested, "bridge-config.json"))) return nested;
  return root;
}

async function bridgeImportTransferReturn(args = {}) {
  const rawReturnRoot = args["return-root"] ?? args["kit-root"] ?? args.folder;
  if (!rawReturnRoot) {
    throw new Error(
      "Missing --return-root <returned OpenClaw-GarageBand-Bridge folder or its parent>.",
    );
  }
  const bridgeRoot = await resolveBridgeRoot(args);
  const returnRoot = await resolveReturnedBridgeRoot(rawReturnRoot);
  if (!(await exists(returnRoot)))
    throw new Error(`Returned bridge folder is missing: ${returnRoot}`);
  await ensureBridgeDirs(bridgeRoot);

  const importedSubtrees = [];
  for (const relative of ["from-macbook", "sync/macbook", "logs"]) {
    const source = path.join(returnRoot, relative);
    if (await copyIfExists(source, path.join(bridgeRoot, relative))) {
      importedSubtrees.push(relative);
    }
  }
  const latestReply = await newestJsonFile(path.join(bridgeRoot, "sync", "macbook"));
  const latestReplyJson = latestReply?.file ? await readJsonOptional(latestReply.file, null) : null;
  const status = {
    schemaVersion: 1,
    status: "transfer_return_imported",
    importedAt: nowIso(),
    bridgeRoot,
    returnRoot,
    importedSubtrees,
    latestReplyProbeId: latestReplyJson?.probeId ?? null,
    safety: {
      executedReturnedFiles: false,
      importedToMacBookRequests: false,
      remoteLoginUsed: false,
    },
    nextAction: "Run bridge-sync-status and bridge-status to verify the MacBook reply/result.",
  };
  await writeJson(LATEST_BRIDGE_TRANSFER_PATH, status);
  console.log(`Imported returned bridge data from: ${returnRoot}`);
  console.log(
    `Imported subtrees: ${importedSubtrees.length > 0 ? importedSubtrees.join(", ") : "none"}`,
  );
  console.log(`Latest returned probe id: ${status.latestReplyProbeId ?? "none"}`);
  console.log("Returned files were copied only; no returned file was executed.");
}

async function bridgeIngest(args) {
  const runId = await resolveProjectId(args);
  const project = await readProject(runId);
  const bridgeRoot = await resolveBridgeRoot(args);
  const jobId = String(args.job ?? project.bridge?.exports?.at(-1)?.jobId ?? "");
  if (!jobId && !args.file) throw new Error("Missing --job or --file.");
  let source = args.file ? path.resolve(String(args.file)) : null;
  if (!source) {
    const returnDir = path.join(bridgeRoot, "from-macbook", jobId);
    const audioFiles = await findAudioFiles(returnDir);
    if (audioFiles.length === 0) throw new Error(`No returned audio found in ${returnDir}`);
    source = audioFiles[0];
  }
  if (!(await exists(source))) throw new Error(`Returned audio is missing: ${source}`);
  const candidateId = String(args.candidate ?? `garageband-${Date.now()}`);
  const record = await copyCandidate(project, source, candidateId, "garageband_bridge");
  project.bridge.imports.push({
    jobId: jobId || null,
    candidateId,
    sourcePath: path.relative(ROOT, source),
    ingestedPath: record.path,
    sha256: record.sha256,
    ingestedAt: nowIso(),
  });
  addAudit(project, "bridge-ingest", `Ingested GarageBand return ${candidateId}.`);
  await writeProject(project);
  console.log(`GarageBand return ingested: ${candidateId}`);
}

async function bridgeImportGarageBand(args) {
  const runId = await resolveProjectId(args);
  const project = await readProject(runId);
  const bridgeRoot = await resolveBridgeRoot(args);
  await ensureBridgeDirs(bridgeRoot);
  let source = args.file ? path.resolve(String(args.file)) : null;
  let inboxId = String(args.inbox ?? "");
  let inboxManifest = {};
  let direction = String(args.note ?? args.direction ?? "").trim();
  if (!source) {
    const inboxRoot = path.join(bridgeRoot, "from-macbook", "inbox");
    const inboxDir = inboxId
      ? { file: path.join(inboxRoot, inboxId), name: inboxId }
      : await newestDirectory(inboxRoot);
    if (!inboxDir) throw new Error(`No GarageBand inbox folders found in ${inboxRoot}`);
    inboxId = inboxDir.name;
    inboxManifest = await readJsonOptional(path.join(inboxDir.file, "request.json"), {});
    const directionFile = path.join(inboxDir.file, "direction.txt");
    if (!direction && (await exists(directionFile))) {
      direction = (await fs.readFile(directionFile, "utf8")).trim();
    }
    const audioFiles = await findAudioFiles(inboxDir.file);
    if (audioFiles.length === 0) throw new Error(`No audio files found in ${inboxDir.file}`);
    source = audioFiles[0];
  }
  if (!(await exists(source))) throw new Error(`GarageBand source audio is missing: ${source}`);
  const kind = String(args.kind ?? inboxManifest.kind ?? "song");
  const sourceId = String(args.source ?? `garageband-${kind}-${Date.now()}`);
  const record = await copySourceAsset(
    project,
    source,
    sourceId,
    kind,
    "garageband_bridge",
    direction,
  );
  record.inboxId = inboxId || null;
  addAudit(project, "bridge-import-garageband", `Imported GarageBand ${kind} ${sourceId}.`);
  await writeProject(project);
  console.log(`GarageBand source imported: ${sourceId}`);
}

async function vocalPlan(args) {
  const runId = await resolveProjectId(args);
  const project = await readProject(runId);
  const source = resolveSource(project, String(args.source ?? ""));
  if (!source) throw new Error("No source or candidate found. Import GarageBand audio first.");
  const lyrics = await readLyrics(args);
  const direction = String(
    args["vocal-direction"] ??
      args.direction ??
      "Create original lead vocals with optional harmonies.",
  ).trim();
  const compliance = complianceReview(`${project.request}\n${direction}\n${lyrics}`);
  const mode = String(args.mode ?? "openclaw_or_cloud");
  const vocalPlanId = String(args.plan ?? `vocal-plan-${Date.now()}`);
  const prompt = {
    candidateId: vocalPlanId,
    model: String(args.model ?? "minimax/music-2.6"),
    prompt: vocalPromptFor(project, source, lyrics, direction, mode),
    lyrics,
    instrumental: false,
    durationSeconds: project.durationSeconds,
    format: "mp3",
    filename: `${project.runId}-${vocalPlanId}`,
  };
  const plan = {
    schemaVersion: 1,
    vocalPlanId,
    sourceRef: source.sourceId ?? source.candidateId,
    sourceKind: source.kind ?? source.sourceKind ?? "candidate",
    mode,
    direction,
    lyrics,
    compliance,
    prompt,
    status: compliance.blocksDraft ? "blocked" : "planned",
    createdAt: nowIso(),
    manualBoundaries: [
      "OpenClaw music_generate can create vocal-forward audio when provider credentials exist.",
      "Precise vocal alignment to an existing GarageBand session may require a cloud vocal/stem tool or manual GarageBand arrangement.",
      "Voice cloning or artist imitation remains blocked unless explicit rights evidence is recorded.",
    ],
  };
  const projectDir = path.join(ROOT, project.projectPath);
  const planDir = path.join(projectDir, "vocals", vocalPlanId);
  await fs.mkdir(planDir, { recursive: true });
  await writeJson(path.join(planDir, "vocal-plan.json"), plan);
  await writeText(path.join(planDir, "lyrics.txt"), lyrics || "");
  await writeText(path.join(planDir, "openclaw-vocal-generate.md"), openclawToolCall(prompt));
  await writeText(
    path.join(planDir, "cloud-vocal-brief.md"),
    cloudVocalBrief(project, source, plan),
  );
  const index = project.vocalPlans.findIndex((item) => item.vocalPlanId === vocalPlanId);
  if (index >= 0) project.vocalPlans[index] = plan;
  else project.vocalPlans.push(plan);
  addAudit(project, "vocal-plan", `Created vocal plan ${vocalPlanId}.`);
  await writeProject(project);
  console.log(
    `${plan.status === "blocked" ? "Vocal plan blocked" : "Vocal plan written"}: ${vocalPlanId}`,
  );
}

async function vocalGenerateLive(args) {
  const runId = await resolveProjectId(args);
  const project = await readProject(runId);
  const planId = String(args.plan ?? project.vocalPlans.at(-1)?.vocalPlanId ?? "");
  const plan = project.vocalPlans.find((item) => item.vocalPlanId === planId);
  if (!plan) throw new Error("No vocal plan found. Run vocal-plan first.");
  if (plan.compliance?.blocksDraft) {
    throw new Error(
      `Vocal plan ${planId} is blocked by compliance: ${plan.compliance.matchedRules
        .map((rule) => rule.id)
        .join(", ")}`,
    );
  }
  const readiness = providerReadinessRecord();
  const attempt = {
    attemptId: `vocal-generation-${planId}-${Date.now()}`,
    planId,
    model: plan.prompt.model,
    createdAt: nowIso(),
    providerReady: readiness.providerReady,
    status: "not_started",
    toolCall: openclawToolCall(plan.prompt),
  };
  const projectDir = path.join(ROOT, project.projectPath);
  if (args["dry-run"] || !readiness.providerReady) {
    attempt.status = args["dry-run"] ? "dry_run_ready" : "blocked_missing_credentials";
    attempt.missingProviderKeys = providerEnvChecks()
      .filter((item) => !item.present)
      .map((item) => item.name);
    await writeJson(path.join(projectDir, "logs", `${attempt.attemptId}.json`), attempt);
    plan.status = attempt.status;
    addAudit(project, "vocal-generate-live", `Vocal generation ${attempt.status} for ${planId}.`);
    await writeProject(project);
    console.log(`${attempt.status}: ${planId}`);
    return;
  }
  const message = `Call this tool exactly once and return all MEDIA paths:\n${attempt.toolCall}`;
  const result = await runCommand(
    "openclaw",
    [
      "agent",
      "--session-id",
      `music-creator-v1-vocals-${project.runId}`,
      "--message",
      message,
      "--json",
      "--local",
      "--timeout",
      "900",
    ],
    { timeoutMs: 900000 },
  );
  const parsed = tryParseJson(result.stdout);
  const audioPaths = await extractExistingAudioPaths(parsed, result.stdout, result.stderr);
  attempt.status = result.ok ? "submitted" : "failed";
  if (audioPaths.length > 0) {
    await copyVocalAudio(
      project,
      audioPaths[0],
      `vocal-${Date.now()}`,
      "openclaw_music_generate",
      planId,
    );
    attempt.status = "ingested";
  }
  attempt.stdout = result.stdout;
  attempt.stderr = result.stderr;
  attempt.parsed = parsed;
  attempt.audioPaths = audioPaths.map((item) => path.relative(ROOT, item));
  await writeJson(path.join(projectDir, "logs", `${attempt.attemptId}.json`), attempt);
  plan.status = attempt.status;
  addAudit(project, "vocal-generate-live", `Vocal generation ${attempt.status} for ${planId}.`);
  await writeProject(project);
  console.log(`${attempt.status}: ${planId}`);
}

async function vocalIngest(args) {
  const runId = await resolveProjectId(args);
  const project = await readProject(runId);
  const source = path.resolve(String(args.file ?? ""));
  if (!(await exists(source))) throw new Error("Missing readable --file.");
  const planId = args.plan ? String(args.plan) : (project.vocalPlans.at(-1)?.vocalPlanId ?? null);
  const vocalId = String(args.vocal ?? `vocal-${Date.now()}`);
  const record = await copyVocalAudio(
    project,
    source,
    vocalId,
    String(args.source ?? "cloud_or_manual_vocal"),
    planId,
  );
  addAudit(project, "vocal-ingest", `Ingested vocal ${vocalId}.`);
  await writeProject(project);
  console.log(`Vocal ingested: ${record.vocalId}`);
}

async function bridgeStatus(args = {}) {
  const bridgeRoot = await resolveBridgeRoot(args);
  const toMacBook = path.join(bridgeRoot, "to-macbook");
  const requestDir = path.join(toMacBook, "requests");
  const fromMacBook = path.join(bridgeRoot, "from-macbook");
  const inbox = path.join(fromMacBook, "inbox");
  const garageBandPaths = ["/Applications/GarageBand.app", "/System/Applications/GarageBand.app"];
  const garageBandInstalled = (await Promise.all(garageBandPaths.map((item) => exists(item)))).some(
    Boolean,
  );
  const home = process.env.HOME ?? "";
  const userAu = home
    ? path.join(
        home,
        "Library",
        "Audio",
        "Plug-Ins",
        "Components",
        "ValhallaSupermassive.component",
      )
    : "";
  const systemAu = "/Library/Audio/Plug-Ins/Components/ValhallaSupermassive.component";
  const auval = await runCommand("auval", ["-v", "aufx", "sMas", "oDin"], {
    timeoutMs: 30000,
    maxBuffer: 1024 * 1024,
  });
  const toJobs = (await fs.readdir(toMacBook).catch(() => [])).filter(
    (item) => !item.startsWith(".") && item !== "requests",
  );
  const fromJobs = (await fs.readdir(fromMacBook).catch(() => [])).filter(
    (item) => !item.startsWith(".") && item !== "inbox" && item !== "agent-results",
  );
  const inboxJobs = (await fs.readdir(inbox).catch(() => [])).filter(
    (item) => !item.startsWith("."),
  );
  const queuedPullRequests = (await fs.readdir(requestDir).catch(() => [])).filter((item) =>
    item.endsWith(".json"),
  );
  const processedPullRequests = (
    await fs.readdir(path.join(requestDir, "processed")).catch(() => [])
  ).filter((item) => item.endsWith(".json"));
  const rejectedPullRequests = (
    await fs.readdir(path.join(requestDir, "rejected")).catch(() => [])
  ).filter((item) => item.endsWith(".json"));
  const macBookPrereqStatus = await readJsonOptional(
    path.join(fromMacBook, "macbook-prereq-status.json"),
    null,
  );
  const macBookNodeStatus = await readJsonOptional(
    path.join(fromMacBook, "macbook-node-status.json"),
    null,
  );
  const macBookNodeWindowStatus = await readJsonOptional(
    path.join(fromMacBook, "macbook-node-window-status.json"),
    null,
  );
  const macBookRemoteExecStatus = await readJsonOptional(
    path.join(fromMacBook, "macbook-remote-exec-status.json"),
    null,
  );
  const macBookPullAgentStatus = await readJsonOptional(
    path.join(fromMacBook, "macbook-pull-agent-status.json"),
    null,
  );
  const macBookSyncStatus = await readJsonOptional(
    path.join(fromMacBook, "macbook-sync-status.json"),
    null,
  );
  const latestSyncProbe = await newestJsonFile(path.join(bridgeRoot, "sync", "mac-studio"));
  const latestSyncProbeJson = latestSyncProbe?.file
    ? await readJsonOptional(latestSyncProbe.file, null)
    : null;
  const latestSyncReply = latestSyncProbeJson?.probeId
    ? await readJsonOptional(
        path.join(bridgeRoot, "sync", "macbook", `${latestSyncProbeJson.probeId}.json`),
        null,
      )
    : null;
  const nodeEnrollmentWindow = await readJsonOptional(
    path.join(fromMacBook, "node-enrollment-window.json"),
    null,
  );
  const status = {
    schemaVersion: 1,
    checkedAt: nowIso(),
    bridgeRoot,
    bridgeRootExists: await exists(bridgeRoot),
    toMacBookJobs: toJobs.length,
    fromMacBookEntries: fromJobs.length,
    garageBandInboxEntries: inboxJobs.length,
    pullAgentRequests: {
      queued: queuedPullRequests.length,
      processed: processedPullRequests.length,
      rejected: rejectedPullRequests.length,
    },
    syncHandshake: {
      latestProbeId: latestSyncProbeJson?.probeId ?? null,
      replySeen: Boolean(latestSyncReply),
      verified:
        Boolean(latestSyncProbeJson?.probeId) &&
        Boolean(latestSyncReply?.probeId) &&
        latestSyncProbeJson.probeId === latestSyncReply.probeId,
      macBookStatus: macBookSyncStatus?.status ?? null,
      macBookUpdatedAt: macBookSyncStatus?.updatedAt ?? null,
    },
    currentMachine: await localComputerName(),
    garageBandInstalled,
    valhallaSupermassive: {
      userAuInstalled: userAu ? await exists(userAu) : false,
      systemAuInstalled: await exists(systemAu),
      auvalPassed: auval.ok,
      auvalSummary: auval.ok
        ? "passed"
        : (auval.stderr || auval.stdout).trim().split("\n").slice(-4).join(" "),
    },
    macBookPrereqStatus: macBookPrereqStatus
      ? {
          status: macBookPrereqStatus.status ?? "unknown",
          updatedAt: macBookPrereqStatus.updatedAt ?? null,
          garageBandInstalled: Boolean(macBookPrereqStatus.garageBandInstalled),
          valhallaSystemAuInstalled: Boolean(macBookPrereqStatus.valhallaSystemAuInstalled),
          valhallaAuvalPassed: Boolean(macBookPrereqStatus.valhallaAuvalPassed),
          blockerCount: Number(macBookPrereqStatus.blockerCount ?? 0),
        }
      : null,
    macBookNodeStatus: macBookNodeStatus
      ? {
          status: macBookNodeStatus.status ?? "unknown",
          updatedAt: macBookNodeStatus.updatedAt ?? null,
          gatewayHost: macBookNodeStatus.gatewayHost ?? null,
          gatewayPort: macBookNodeStatus.gatewayPort ?? null,
          nodeDisplayName: macBookNodeStatus.nodeDisplayName ?? null,
          blockerCount: Number(macBookNodeStatus.blockerCount ?? 0),
        }
      : null,
    macBookNodeWindowStatus: macBookNodeWindowStatus
      ? {
          status: macBookNodeWindowStatus.status ?? "unknown",
          updatedAt: macBookNodeWindowStatus.updatedAt ?? null,
          gatewayHost: macBookNodeWindowStatus.gatewayHost ?? null,
          gatewayPort: macBookNodeWindowStatus.gatewayPort ?? null,
          nodeDisplayName: macBookNodeWindowStatus.nodeDisplayName ?? null,
          blockerCount: Number(macBookNodeWindowStatus.blockerCount ?? 0),
        }
      : null,
    macBookRemoteExecStatus: macBookRemoteExecStatus
      ? {
          status: macBookRemoteExecStatus.status ?? "unknown",
          updatedAt: macBookRemoteExecStatus.updatedAt ?? null,
          sshUsername: macBookRemoteExecStatus.sshUsername ?? null,
          computerName: macBookRemoteExecStatus.computerName ?? null,
          remoteLoginEnabled: Boolean(macBookRemoteExecStatus.remoteLoginEnabled),
          authorizedKeyInstalled: Boolean(macBookRemoteExecStatus.authorizedKeyInstalled),
          blockerCount: Number(macBookRemoteExecStatus.blockerCount ?? 0),
        }
      : null,
    macBookPullAgentStatus: macBookPullAgentStatus
      ? {
          status: macBookPullAgentStatus.status ?? "unknown",
          updatedAt: macBookPullAgentStatus.updatedAt ?? null,
          mode: macBookPullAgentStatus.mode ?? null,
          remoteLoginUsed: Boolean(macBookPullAgentStatus.remoteLoginUsed),
          detail: macBookPullAgentStatus.detail ?? null,
        }
      : null,
    nodeEnrollmentWindow: nodeEnrollmentWindow
      ? {
          status: nodeEnrollmentWindow.status ?? "unknown",
          updatedAt: nodeEnrollmentWindow.updatedAt ?? null,
          durationSeconds: Number(nodeEnrollmentWindow.durationSeconds ?? 0),
        }
      : null,
  };
  await writeJson(LATEST_BRIDGE_STATUS_PATH, status);
  console.log(`Bridge root: ${bridgeRoot}`);
  console.log(`Bridge root exists: ${status.bridgeRootExists ? "yes" : "no"}`);
  console.log(`To MacBook jobs: ${status.toMacBookJobs}`);
  console.log(`From MacBook entries: ${status.fromMacBookEntries}`);
  console.log(`GarageBand inbox entries: ${status.garageBandInboxEntries}`);
  console.log(`Pull-agent queued requests: ${status.pullAgentRequests.queued}`);
  console.log(`Pull-agent processed requests: ${status.pullAgentRequests.processed}`);
  console.log(`Pull-agent rejected requests: ${status.pullAgentRequests.rejected}`);
  console.log(
    `Bridge sync verified: ${status.syncHandshake.verified ? "yes" : "no"}${
      status.syncHandshake.latestProbeId ? ` (${status.syncHandshake.latestProbeId})` : ""
    }`,
  );
  console.log(`GarageBand installed here: ${garageBandInstalled ? "yes" : "no"}`);
  console.log(
    `Valhalla user AU: ${status.valhallaSupermassive.userAuInstalled ? "installed" : "missing"}`,
  );
  console.log(
    `Valhalla system AU: ${status.valhallaSupermassive.systemAuInstalled ? "installed" : "missing"}`,
  );
  console.log(`auval: ${status.valhallaSupermassive.auvalPassed ? "passed" : "not passed"}`);
  console.log(
    `MacBook setup status: ${
      status.macBookPrereqStatus
        ? `${status.macBookPrereqStatus.status} (${status.macBookPrereqStatus.blockerCount} blockers)`
        : "not reported"
    }`,
  );
  console.log(
    `MacBook node status: ${
      status.macBookNodeStatus
        ? `${status.macBookNodeStatus.status} (${status.macBookNodeStatus.blockerCount} blockers)`
        : "not reported"
    }`,
  );
  console.log(
    `MacBook tokenless node status: ${
      status.macBookNodeWindowStatus
        ? `${status.macBookNodeWindowStatus.status} (${status.macBookNodeWindowStatus.blockerCount} blockers)`
        : "not reported"
    }`,
  );
  console.log(
    `MacBook remote exec status: ${
      status.macBookRemoteExecStatus
        ? `${status.macBookRemoteExecStatus.status} (${status.macBookRemoteExecStatus.blockerCount} blockers)`
        : "not reported"
    }`,
  );
  console.log(
    `MacBook pull-agent status: ${
      status.macBookPullAgentStatus
        ? `${status.macBookPullAgentStatus.status} (${status.macBookPullAgentStatus.remoteLoginUsed ? "remote login used" : "no remote login"})`
        : "not reported"
    }`,
  );
  console.log(
    `Node enrollment window: ${
      status.nodeEnrollmentWindow
        ? `${status.nodeEnrollmentWindow.status} (${status.nodeEnrollmentWindow.durationSeconds}s)`
        : "not reported"
    }`,
  );
}

async function validateAll(args = {}) {
  const catalog = args["rebuild-catalog"] ? await updateCatalog() : await updateCatalog();
  const results = [];
  for (const dir of await projectDirs()) {
    const manifestPath = path.join(dir, "project.json");
    if (!(await exists(manifestPath))) continue;
    const manifest = await readJsonOptional(manifestPath, null);
    const missing = [];
    if (!manifest) missing.push("project.json");
    results.push({
      project: path.relative(ROOT, dir),
      ok: missing.length === 0,
      missing,
      status: manifest?.status ?? "missing_manifest",
      candidateCount: manifest?.candidates?.length ?? 0,
      selectedCandidateId: manifest?.selectedCandidateId ?? null,
    });
  }
  await writeJson(path.join(STATE_DIR, "latest-validation.json"), {
    schemaVersion: 1,
    checkedAt: nowIso(),
    catalogProjectCount: catalog.projects.length,
    results,
  });
  for (const result of results) {
    console.log(`${result.ok ? "OK" : "MISSING"} ${result.project}`);
    console.log(
      `  status: ${result.status}, candidates: ${result.candidateCount}, selected: ${result.selectedCandidateId ?? "none"}`,
    );
  }
}

async function providerSetup() {
  const readiness = providerReadinessRecord();
  await writeJson(PROVIDER_SETUP_PATH, readiness);
  if (!(await exists(PROVIDER_ENV_TEMPLATE_PATH))) {
    await writeText(PROVIDER_ENV_TEMPLATE_PATH, providerEnvTemplate());
  } else {
    const existing = await fs.readFile(PROVIDER_ENV_TEMPLATE_PATH, "utf8");
    const missingKeys = PROVIDER_ENV_KEYS.filter((key) => !existing.includes(`export ${key}=`));
    if (missingKeys.length > 0) {
      await writeText(
        PROVIDER_ENV_TEMPLATE_PATH,
        `${existing.trimEnd()}\n${missingKeys.map((key) => `export ${key}=""`).join("\n")}\n`,
      );
    }
  }
  console.log(`Provider ready: ${readiness.providerReady ? "yes" : "no"}`);
  for (const provider of readiness.providers) {
    const keys = provider.env.map((item) => `${item.name}:${item.present ? "present" : "missing"}`);
    console.log(
      `${provider.ready ? "ready" : "missing"} ${provider.provider} (${keys.join(", ")})`,
    );
  }
}

async function health() {
  const readiness = providerReadinessRecord();
  const summary = {
    schemaVersion: 1,
    checkedAt: nowIso(),
    providerReady: readiness.providerReady,
    providers: readiness.providers.flatMap((provider) => provider.env),
    ffprobeAvailable: await commandAvailable("ffprobe"),
    ffmpegAvailable: await commandAvailable("ffmpeg"),
    publicPublishingAllowed: false,
  };
  await writeJson(LATEST_HEALTH_PATH, summary);
  console.log(`Provider ready: ${summary.providerReady ? "yes" : "no"}`);
  for (const item of summary.providers)
    console.log(`${item.name}: ${item.present ? "present" : "missing"}`);
  console.log(`ffprobe: ${summary.ffprobeAvailable ? "available" : "missing"}`);
  console.log(`ffmpeg: ${summary.ffmpegAvailable ? "available" : "missing"}`);
  console.log("Public publishing: blocked by default");
}

async function doctor() {
  const checks = [
    ["music-creator-v1 directory", await exists(BASE), "package root"],
    ["projects directory", await exists(PROJECTS_DIR), "project manifests"],
    ["openclaw CLI", await commandAvailable("openclaw"), "live music_generate orchestration"],
    ["ffprobe", await commandAvailable("ffprobe"), "technical audio QA"],
    ["ffmpeg", await commandAvailable("ffmpeg"), "loudness and silence checks"],
  ];
  for (const key of PROVIDER_ENV_KEYS) {
    checks.push([`${key} configured`, Boolean(process.env[key]), "Secret value redacted."]);
  }
  await writeJson(LATEST_DOCTOR_PATH, {
    schemaVersion: 1,
    checkedAt: nowIso(),
    checks: checks.map(([name, ok, detail]) => ({ name, ok, detail })),
  });
  for (const [name, ok, detail] of checks) console.log(`${ok ? "OK" : "WARN"} ${name}: ${detail}`);
}

async function main() {
  const [command = "help", ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (command === "create") await createProject(args);
  else if (command === "plan-generation" || command === "generate-plan") await planGeneration(args);
  else if (command === "generate-live") await generateLive(args);
  else if (command === "sync-live-output") await syncLiveOutput(args);
  else if (command === "ingest-candidate") await ingestCandidate(args);
  else if (command === "qa") await runQa(args);
  else if (command === "select") await selectCandidate(args);
  else if (command === "set-release-gate") await setReleaseGate(args);
  else if (command === "publish-package") await publishPackage(args);
  else if (command === "bridge-init") await bridgeInit(args);
  else if (command === "bridge-sync-probe") await bridgeSyncProbe(args);
  else if (command === "bridge-sync-status") await bridgeSyncStatus(args);
  else if (command === "bridge-queue-job") await bridgeQueueJob(args);
  else if (command === "bridge-transfer-kit") await bridgeMakeTransferKit(args);
  else if (command === "bridge-import-transfer-return") await bridgeImportTransferReturn(args);
  else if (command === "bridge-export") await bridgeExport(args);
  else if (command === "bridge-ingest") await bridgeIngest(args);
  else if (command === "bridge-import-garageband") await bridgeImportGarageBand(args);
  else if (command === "vocal-plan") await vocalPlan(args);
  else if (command === "vocal-generate-live") await vocalGenerateLive(args);
  else if (command === "vocal-ingest") await vocalIngest(args);
  else if (command === "kits-list-voices") await kitsListVoices(args);
  else if (command === "kits-convert") await kitsConvert(args);
  else if (command === "kits-sync") await kitsSync(args);
  else if (command === "bridge-status") await bridgeStatus(args);
  else if (command === "validate") await validateAll(args);
  else if (command === "provider-setup") await providerSetup();
  else if (command === "health") await health();
  else if (command === "doctor") await doctor();
  else {
    console.log(`Music Creator V1

Commands:
  create --request <text> [--artist <name>] [--duration <seconds>] [--platform <name>] [--vocal]
  plan-generation --project <runId>
  generate-live --project <runId> [--candidate <id>] [--dry-run]
  sync-live-output --project <runId> [--task <taskId-or-runId>] [--task-output-file <json>] [--candidate <id>]
  ingest-candidate --project <runId> --file <audio> [--candidate <id>]
  qa --project <runId> --candidate <id> --creative-total <0-100> [--manual-technical-pass]
  select --project <runId> --candidate <id>
  set-release-gate --project <runId> --gate <name> [--value true|false]
  publish-package --project <runId>
  bridge-init [--bridge-root <shared-folder>]
  bridge-sync-probe [--bridge-root <shared-folder>] [--probe <id>]
  bridge-sync-status [--bridge-root <shared-folder>] [--probe <id>]
  bridge-queue-job --action health-check|garageband-status|list-bridge-files|open-latest-bridge-job|open-bridge-job [--job <bridge-job-id>] [--bridge-root <shared-folder>]
  bridge-transfer-kit [--bridge-root <shared-folder>] [--output-root <folder>] [--kit <id>]
  bridge-import-transfer-return --return-root <returned-folder> [--bridge-root <shared-folder>]
  bridge-export --project <runId> [--candidate <id> | --source <id> | --vocal <id> | --file <audio>] [--bridge-root <shared-folder>]
  bridge-ingest --project <runId> [--job <jobId>] [--file <audio>] [--candidate <id>] [--bridge-root <shared-folder>]
  bridge-import-garageband --project <runId> [--inbox <id> | --file <audio>] [--kind song|stem|vocal|reference] [--source <id>]
  vocal-plan --project <runId> [--source <id>] [--lyrics <text> | --lyrics-file <file>] [--vocal-direction <text>]
  vocal-generate-live --project <runId> [--plan <id>] [--dry-run]
  vocal-ingest --project <runId> --file <audio> [--plan <id>] [--vocal <id>] [--source <label>]
  kits-list-voices [--page <n>] [--per-page <n>] [--my-models] [--instruments]
  kits-convert --project <runId> --file <vocal-audio> --voice <voiceModelId> [--plan <id>]
  kits-sync --project <runId> --job <kitsJobId> [--vocal <id>] [--plan <id>]
  bridge-status [--bridge-root <shared-folder>]
  validate [--rebuild-catalog]
  provider-setup
  health
  doctor
`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
