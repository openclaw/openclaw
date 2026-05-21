#!/usr/bin/env -S node --import tsx

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type CommandResult = { stderr: string; stdout: string };
type JsonObject = Record<string, unknown>;
type PreviewCrop = "discord-window";
type CrabboxInspect = {
  host?: string;
  id?: string;
  slug?: string;
  sshKey?: string;
  sshPort?: string;
  sshUser?: string;
  state?: string;
};
type Options = {
  command: "finish" | "publish" | "run" | "screenshot" | "send" | "start" | "status" | "view";
  crabboxBin: string;
  crabboxClass: string;
  dryRun: boolean;
  envFile?: string;
  gatewayPort: number;
  idleTimeout: string;
  keepBox: boolean;
  leaseId?: string;
  mockPort: number;
  messageId?: string;
  mockResponseText: string;
  outputDir: string;
  previewCrop?: PreviewCrop;
  previewCropWidth: number;
  previewFps: number;
  previewWidth: number;
  provider: string;
  publishFullArtifacts: boolean;
  publishPr?: number;
  publishRepo: string;
  publishSummary?: string;
  recordFps: number;
  remoteCommand: string[];
  target: string;
  text: string;
  ttl: string;
};
type DiscordCredential = {
  channelId: string;
  driverBotToken: string;
  guildId: string;
  sutApplicationId: string;
  sutBotToken: string;
};
type LocalSut = {
  configPath: string;
  gatewayLog: string;
  gatewayPid: number;
  mockLog: string;
  mockPid: number;
  requestLog: string;
  stateDir: string;
  tempRoot: string;
  workspace: string;
};
type SessionFile = {
  command: "discord-web-crabbox-session";
  createdAt: string;
  crabbox: {
    class: string;
    createdLease: boolean;
    id: string;
    inspect: CrabboxInspect;
    provider: string;
    target: string;
  };
  credential: { channelId: string; guildId: string; leaseFile: string; sutApplicationId: string };
  localRoot: string;
  localSut: LocalSut;
  outputDir: string;
  recorder: { log: string; pidFile: string; remoteVideo: string };
  remoteRoot: string;
};

const DEFAULT_CONVEX_ENV_FILE = "~/.codex/skills/custom/telegram-e2e-bot-to-bot/convex.local.env";
const DEFAULT_OUTPUT_ROOT = ".artifacts/qa-e2e/discord-web-crabbox";
const REMOTE_ROOT = "/tmp/openclaw-discord-web-crabbox";
const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_PROOF_VIEW = { cropWidth: 720, height: 760, width: 900, x: 300, y: 90 };

function usage(): never {
  throw new Error(
    [
      "Usage:",
      "  node --import tsx scripts/e2e/discord-web-crabbox-proof.ts start",
      "  node --import tsx scripts/e2e/discord-web-crabbox-proof.ts send --session <session.json> --text <text>",
      "  node --import tsx scripts/e2e/discord-web-crabbox-proof.ts view --session <session.json> --message-id <id>",
      "  node --import tsx scripts/e2e/discord-web-crabbox-proof.ts run --session <session.json> -- <remote command>",
      "  node --import tsx scripts/e2e/discord-web-crabbox-proof.ts screenshot --session <session.json>",
      "  node --import tsx scripts/e2e/discord-web-crabbox-proof.ts finish --session <session.json> --preview-crop discord-window",
    ].join("\n"),
  );
}

function trimToValue(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
function expandHome(value: string) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}
function parsePositiveInteger(value: string, label: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${label} must be a positive integer.`);
  return parsed;
}
function parseArgs(argv: string[]): Options {
  argv = argv[0] === "--" ? argv.slice(1) : argv;
  const commands = new Set([
    "finish",
    "publish",
    "run",
    "screenshot",
    "send",
    "start",
    "status",
    "view",
  ]);
  const command = commands.has(argv[0] ?? "") ? (argv.shift() as Options["command"]) : "start";
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const opts: Options = {
    command,
    crabboxBin: trimToValue(process.env.OPENCLAW_DISCORD_WEB_CRABBOX_BIN) ?? "crabbox",
    crabboxClass: "standard",
    dryRun: false,
    gatewayPort: 19_979,
    idleTimeout: "60m",
    keepBox: false,
    mockPort: 19_982,
    mockResponseText: "OPENCLAW_DISCORD_E2E_OK",
    outputDir: path.join(DEFAULT_OUTPUT_ROOT, stamp),
    previewCropWidth: DISCORD_PROOF_VIEW.cropWidth,
    previewFps: 24,
    previewWidth: 1920,
    provider: process.env.OPENCLAW_DISCORD_WEB_CRABBOX_PROVIDER?.trim() || "aws",
    publishFullArtifacts: false,
    publishRepo: "openclaw/openclaw",
    recordFps: 24,
    remoteCommand: [],
    target: "linux",
    text: "Reply exactly: OPENCLAW_DISCORD_E2E_OK",
    ttl: "120m",
  };
  const commandSeparator = argv.indexOf("--");
  if (command === "run" && commandSeparator >= 0) {
    opts.remoteCommand = argv.slice(commandSeparator + 1);
    argv = argv.slice(0, commandSeparator);
  }
  let sessionFile: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) usage();
      index += 1;
      return value;
    };
    if (arg === "--class") opts.crabboxClass = readValue();
    else if (arg === "--crabbox-bin") opts.crabboxBin = readValue();
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--env-file") opts.envFile = readValue();
    else if (arg === "--gateway-port")
      opts.gatewayPort = parsePositiveInteger(readValue(), "--gateway-port");
    else if (arg === "--id") opts.leaseId = readValue();
    else if (arg === "--idle-timeout") opts.idleTimeout = readValue();
    else if (arg === "--keep-box") opts.keepBox = true;
    else if (arg === "--mock-port")
      opts.mockPort = parsePositiveInteger(readValue(), "--mock-port");
    else if (arg === "--message-id") opts.messageId = readValue();
    else if (arg === "--mock-response-file")
      opts.mockResponseText = fs.readFileSync(resolveRepoPath(process.cwd(), readValue()), "utf8");
    else if (arg === "--output-dir") opts.outputDir = readValue();
    else if (arg === "--preview-crop") {
      const value = readValue();
      if (value !== "discord-window") throw new Error("--preview-crop must be discord-window.");
      opts.previewCrop = value;
    } else if (arg === "--preview-crop-width")
      opts.previewCropWidth = parsePositiveInteger(readValue(), "--preview-crop-width");
    else if (arg === "--preview-fps")
      opts.previewFps = parsePositiveInteger(readValue(), "--preview-fps");
    else if (arg === "--preview-width")
      opts.previewWidth = parsePositiveInteger(readValue(), "--preview-width");
    else if (arg === "--provider") opts.provider = readValue();
    else if (arg === "--pr") opts.publishPr = parsePositiveInteger(readValue(), "--pr");
    else if (arg === "--repo") opts.publishRepo = readValue();
    else if (arg === "--session") sessionFile = readValue();
    else if (arg === "--summary") opts.publishSummary = readValue();
    else if (arg === "--text") opts.text = readValue();
    else if (arg === "--ttl") opts.ttl = readValue();
    else if (arg === "--full-artifacts") opts.publishFullArtifacts = true;
    else usage();
  }
  if (sessionFile) opts.outputDir = path.dirname(resolveRepoPath(process.cwd(), sessionFile));
  return opts;
}
function repoRoot() {
  let current = process.cwd();
  while (current !== path.dirname(current)) {
    if (
      fs.existsSync(path.join(current, "package.json")) &&
      fs.existsSync(path.join(current, ".git"))
    )
      return current;
    current = path.dirname(current);
  }
  return process.cwd();
}
function resolveRepoPath(root: string, value: string) {
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}
function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function requireString(source: JsonObject, key: string) {
  const value = source[key];
  if (typeof value === "number") return String(value);
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new Error(`Missing ${key}.`);
}
function readJson(file: string) {
  return JSON.parse(fs.readFileSync(file, "utf8")) as JsonObject;
}
async function readEnvFile(file: string) {
  const env: Record<string, string> = {};
  if (!fs.existsSync(expandHome(file))) return env;
  for (const line of fs.readFileSync(expandHome(file), "utf8").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf("=");
    if (at < 1) continue;
    env[trimmed.slice(0, at).trim()] = trimmed
      .slice(at + 1)
      .trim()
      .replace(/^['"]|['"]$/gu, "");
  }
  return env;
}
function runCommand(params: {
  args: string[];
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdio?: "inherit" | "pipe";
  stdin?: string;
}) {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(params.command, params.args, {
      cwd: params.cwd,
      env: params.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (params.stdio === "inherit") process.stdout.write(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (params.stdio === "inherit") process.stderr.write(text);
    });
    child.on("error", reject);
    child.on("close", (code, signal) =>
      code === 0
        ? resolve({ stdout, stderr })
        : reject(
            new Error(
              `${params.command} ${params.args.join(" ")} failed with ${signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`}\n${stdout}${stderr}`,
            ),
          ),
    );
    params.stdin ? child.stdin.end(params.stdin) : child.stdin.end();
  });
}
function childProcessBaseEnv() {
  const keys = [
    "CI",
    "COREPACK_HOME",
    "FORCE_COLOR",
    "HOME",
    "LANG",
    "LC_ALL",
    "NODE_OPTIONS",
    "OPENCLAW_BUILD_PRIVATE_QA",
    "OPENCLAW_ENABLE_PRIVATE_QA_CLI",
    "PATH",
    "PNPM_HOME",
    "SHELL",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USER",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keys) if (process.env[key]) env[key] = process.env[key];
  return env;
}
function spawnDaemon(params: {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
}) {
  const log = fs.openSync(params.logPath, "a");
  const child = spawn(params.command, params.args, {
    cwd: params.cwd,
    detached: true,
    env: params.env,
    stdio: ["ignore", log, log],
  });
  child.unref();
  fs.closeSync(log);
  return child.pid;
}
function killPidTree(pid: number | undefined) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
}
async function waitForLog(logPath: string, pattern: RegExp, label: string, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const text = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
    if (pattern.test(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const text = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
  throw new Error(`${label} did not become ready within ${timeoutMs}ms\n${text.slice(-4000)}`);
}
async function discord<T>(token: string, method: string, route: string, body?: unknown) {
  const response = await fetch(`${DISCORD_API}${route}`, {
    method,
    headers: {
      authorization: `Bot ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const payload = text.trim() ? JSON.parse(text) : undefined;
  if (!response.ok)
    throw new Error(`Discord ${method} ${route} failed: ${response.status} ${text}`);
  return payload as T;
}
async function currentDiscordUser(token: string) {
  const payload = await discord<JsonObject>(token, "GET", "/users/@me");
  return {
    id: requireString(payload, "id"),
    username: typeof payload.username === "string" ? payload.username : undefined,
  };
}
function messageUrl(
  credential: Pick<DiscordCredential, "channelId" | "guildId">,
  messageId?: string,
) {
  return `https://discord.com/channels/${credential.guildId}/${credential.channelId}${messageId ? `/${messageId}` : ""}`;
}
async function postBroker(params: {
  action: string;
  body: JsonObject;
  siteUrl: string;
  token: string;
}) {
  const response = await fetch(
    `${params.siteUrl.replace(/\/+$/u, "")}/qa-credentials/v1/${params.action}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${params.token}`, "content-type": "application/json" },
      body: JSON.stringify(params.body),
    },
  );
  const payload = (await response.json()) as JsonObject;
  if (!response.ok || payload.status !== "ok")
    throw new Error(`${params.action} failed: ${JSON.stringify(payload)}`);
  return payload;
}
async function resolveLeaseConfig(opts: Options) {
  const fileEnv = await readEnvFile(opts.envFile ?? DEFAULT_CONVEX_ENV_FILE);
  const siteUrl =
    process.env.OPENCLAW_QA_CONVEX_SITE_URL?.trim() || fileEnv.OPENCLAW_QA_CONVEX_SITE_URL;
  const token =
    process.env.OPENCLAW_QA_CONVEX_SECRET_CI?.trim() || fileEnv.OPENCLAW_QA_CONVEX_SECRET_CI;
  if (!siteUrl) throw new Error("Missing OPENCLAW_QA_CONVEX_SITE_URL.");
  if (!token) throw new Error("Missing OPENCLAW_QA_CONVEX_SECRET_CI.");
  return {
    siteUrl,
    token,
    ownerId: `discord-web-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
  };
}
function parseDiscordCredential(payload: unknown): DiscordCredential {
  if (!payload || typeof payload !== "object")
    throw new Error("Discord credential payload must be an object.");
  const source = payload as JsonObject;
  return {
    channelId: requireString(source, "channelId"),
    driverBotToken: requireString(source, "driverBotToken"),
    guildId: requireString(source, "guildId"),
    sutApplicationId: requireString(source, "sutApplicationId"),
    sutBotToken: requireString(source, "sutBotToken"),
  };
}
async function leaseCredential(root: string, opts: Options, localRoot: string) {
  const config = await resolveLeaseConfig(opts);
  const acquired = await postBroker({
    action: "acquire",
    siteUrl: config.siteUrl,
    token: config.token,
    body: { kind: "discord", ownerId: config.ownerId, actorRole: "ci", leaseTtlMs: 20 * 60 * 1000 },
  });
  const leaseFile = path.join(localRoot, "credential-lease.json");
  const payloadFile = path.join(localRoot, "credential-payload.json");
  const payload = parseDiscordCredential(acquired.payload);
  fs.writeFileSync(
    leaseFile,
    `${JSON.stringify({ ...config, credentialId: requireString(acquired, "credentialId"), leaseToken: requireString(acquired, "leaseToken") }, null, 2)}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(payloadFile, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return { ...payload, leaseFile: path.relative(root, leaseFile) };
}
async function releaseCredential(root: string, leaseFile: string) {
  const lease = readJson(path.resolve(root, leaseFile));
  await postBroker({
    action: "release",
    siteUrl: requireString(lease, "siteUrl"),
    token: requireString(lease, "token"),
    body: {
      kind: "discord",
      ownerId: requireString(lease, "ownerId"),
      credentialId: requireString(lease, "credentialId"),
      leaseToken: requireString(lease, "leaseToken"),
    },
  });
}
function writeSutConfig(params: {
  channelId: string;
  driverBotId: string;
  gatewayPort: number;
  guildId: string;
  mockPort: number;
  outputDir: string;
  sutToken: string;
}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-discord-crabbox-sut-"));
  const stateDir = path.join(tempRoot, "state");
  const workspace = path.join(tempRoot, "workspace");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const configPath = path.join(tempRoot, "openclaw.json");
  const config = {
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.5" },
        models: { "openai/gpt-5.5": { params: { openaiWsWarmup: false, transport: "sse" } } },
      },
      list: [
        {
          default: true,
          id: "main",
          model: { primary: "openai/gpt-5.5" },
          name: "Main",
          workspace,
        },
      ],
    },
    channels: {
      discord: {
        enabled: true,
        defaultAccount: "sut",
        accounts: {
          sut: {
            enabled: true,
            token: params.sutToken,
            allowBots: true,
            groupPolicy: "allowlist",
            guilds: {
              [params.guildId]: {
                requireMention: false,
                users: [params.driverBotId],
                channels: {
                  [params.channelId]: {
                    enabled: true,
                    requireMention: false,
                    users: [params.driverBotId],
                  },
                },
              },
            },
          },
        },
      },
    },
    gateway: { auth: { mode: "none" }, bind: "loopback", mode: "local", port: params.gatewayPort },
    messages: {
      ackReaction: "👀",
      ackReactionScope: "all",
      groupChat: { visibleReplies: "automatic" },
      statusReactions: { enabled: true, timing: { debounceMs: 0 } },
    },
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          apiKey: { id: "OPENAI_API_KEY", provider: "default", source: "env" },
          baseUrl: `http://127.0.0.1:${params.mockPort}/v1`,
          models: [
            { api: "openai-responses", contextWindow: 128000, id: "gpt-5.5", name: "gpt-5.5" },
          ],
          request: { allowPrivateNetwork: true },
        },
      },
    },
    plugins: {
      allow: ["discord", "openai"],
      enabled: true,
      entries: { discord: { enabled: true }, openai: { enabled: true } },
    },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { configPath, stateDir, tempRoot, workspace };
}
function mockServerEnv(params: { mockPort: number; mockResponseText: string; requestLog: string }) {
  return {
    ...childProcessBaseEnv(),
    MOCK_PORT: String(params.mockPort),
    MOCK_REQUEST_LOG: params.requestLog,
    SUCCESS_MARKER: params.mockResponseText,
  };
}
function gatewayEnv(params: { configPath: string; stateDir: string; sutToken: string }) {
  return {
    ...childProcessBaseEnv(),
    OPENAI_API_KEY: "sk-openclaw-e2e-mock",
    OPENCLAW_CONFIG_PATH: params.configPath,
    OPENCLAW_STATE_DIR: params.stateDir,
  };
}
async function startLocalSutDaemon(params: {
  credential: DiscordCredential;
  driverBotId: string;
  mockResponseText: string;
  outputDir: string;
  repoRoot: string;
  opts: Options;
}) {
  const config = writeSutConfig({
    ...params.credential,
    driverBotId: params.driverBotId,
    gatewayPort: params.opts.gatewayPort,
    mockPort: params.opts.mockPort,
    outputDir: params.outputDir,
  });
  const requestLog = path.join(params.outputDir, "mock-openai-requests.ndjson");
  const mockLog = path.join(params.outputDir, "mock-openai.log");
  const gatewayLog = path.join(params.outputDir, "gateway.log");
  const mockPid = spawnDaemon({
    command: "node",
    args: ["scripts/e2e/mock-openai-server.mjs"],
    cwd: params.repoRoot,
    env: mockServerEnv({
      mockPort: params.opts.mockPort,
      mockResponseText: params.mockResponseText,
      requestLog,
    }),
    logPath: mockLog,
  });
  await waitForLog(mockLog, /mock-openai listening/u, "mock-openai", 10_000);
  const gatewayPid = spawnDaemon({
    command: "pnpm",
    args: ["openclaw", "gateway", "--port", String(params.opts.gatewayPort)],
    cwd: params.repoRoot,
    env: gatewayEnv({ ...config, sutToken: params.credential.sutBotToken }),
    logPath: gatewayLog,
  });
  await waitForLog(gatewayLog, /\[gateway\] ready/u, "gateway", 60_000);
  return { ...config, gatewayLog, gatewayPid, mockLog, mockPid, requestLog } satisfies LocalSut;
}
function extractLeaseId(output: string) {
  return output.match(/\b(?:cbx_[a-f0-9]+|tbx_[A-Za-z0-9_-]+)\b/u)?.[0];
}
async function warmupCrabbox(opts: Options, root: string) {
  const result = await runCommand({
    command: opts.crabboxBin,
    args: [
      "warmup",
      "--provider",
      opts.provider,
      "--target",
      opts.target,
      "--desktop",
      "--browser",
      "--class",
      opts.crabboxClass,
      "--idle-timeout",
      opts.idleTimeout,
      "--ttl",
      opts.ttl,
    ],
    cwd: root,
    stdio: "inherit",
  });
  const leaseId = extractLeaseId(`${result.stdout}\n${result.stderr}`);
  if (!leaseId) throw new Error("Crabbox warmup did not print a lease id.");
  return leaseId;
}
async function inspectCrabbox(opts: Options, root: string, leaseId: string) {
  const result = await runCommand({
    command: opts.crabboxBin,
    args: [
      "inspect",
      "--provider",
      opts.provider,
      "--target",
      opts.target,
      "--id",
      leaseId,
      "--json",
    ],
    cwd: root,
  });
  return JSON.parse(result.stdout) as CrabboxInspect;
}
function sshArgs(inspect: CrabboxInspect) {
  if (!inspect.host || !inspect.sshKey || !inspect.sshUser)
    throw new Error("Crabbox inspect output is missing SSH details.");
  return [
    "-i",
    inspect.sshKey,
    "-p",
    inspect.sshPort ?? "22",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=no",
    `${inspect.sshUser}@${inspect.host}`,
  ];
}
async function sshRun(root: string, inspect: CrabboxInspect, command: string) {
  return await runCommand({ command: "ssh", args: [...sshArgs(inspect), command], cwd: root });
}
async function scpFromRemote(root: string, inspect: CrabboxInspect, remote: string, local: string) {
  fs.mkdirSync(path.dirname(local), { recursive: true });
  await runCommand({
    command: "scp",
    args: [
      "-i",
      inspect.sshKey!,
      "-P",
      inspect.sshPort ?? "22",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=no",
      `${inspect.sshUser}@${inspect.host}:${remote}`,
      local,
    ],
    cwd: root,
  });
}
async function stopCrabbox(root: string, opts: Options, leaseId: string) {
  await runCommand({
    command: opts.crabboxBin,
    args: ["stop", "--provider", opts.provider, "--target", opts.target, leaseId],
    cwd: root,
    stdio: "inherit",
  });
}
function remoteBrowserScript(params: {
  profileArchiveEnv: string;
  profileDir: string;
  url: string;
}) {
  return `set -euo pipefail
root=${REMOTE_ROOT}
mkdir -p "$root" ${shellQuote(params.profileDir)}
export DISPLAY="\${DISPLAY:-:99}"
if ! command -v wmctrl >/dev/null 2>&1 || ! command -v xdotool >/dev/null 2>&1; then sudo apt-get update -y >/tmp/openclaw-discord-apt.log 2>&1; sudo DEBIAN_FRONTEND=noninteractive apt-get install -y wmctrl xdotool x11-utils ffmpeg scrot >>/tmp/openclaw-discord-apt.log 2>&1; fi
archive="\${${params.profileArchiveEnv}:-}"
if [ -n "$archive" ]; then printf '%s' "$archive" | base64 -d >"$root/profile.tgz"; tar -xzf "$root/profile.tgz" -C ${shellQuote(params.profileDir)}; rm -f "$root/profile.tgz"; fi
browser=""
for candidate in "\${BROWSER:-}" "\${CHROME_BIN:-}" google-chrome chromium chromium-browser; do if [ -n "$candidate" ] && command -v "$candidate" >/dev/null 2>&1; then browser="$(command -v "$candidate")"; break; fi; done
[ -n "$browser" ]
"$browser" --user-data-dir=${shellQuote(params.profileDir)} --no-first-run --no-default-browser-check --disable-dev-shm-usage --window-size=1280,900 --window-position=0,0 --class=mantis-discord-web-proof ${shellQuote(params.url)} >"$root/chrome.log" 2>&1 &
echo $! >"$root/chrome.pid"
sleep 8
wmctrl -r mantis-discord-web-proof -e 0,0,0,1280,900 || true`;
}
async function startRemoteRecording(root: string, inspect: CrabboxInspect, opts: Options) {
  await sshRun(
    root,
    inspect,
    `set -euo pipefail
export DISPLAY="\${DISPLAY:-:99}"
root=${REMOTE_ROOT}
mkdir -p "$root"
video="$root/session.mp4"
log="$root/ffmpeg.log"
pid_file="$root/ffmpeg.pid"
rm -f "$video" "$log" "$pid_file"
size="$(xdpyinfo | awk '/dimensions:/ {size=$2} END {if (!size) exit 1; print size}')"
nohup ffmpeg -y -hide_banner -loglevel warning -f x11grab -framerate ${opts.recordFps} -video_size "$size" -i "$DISPLAY" -pix_fmt yuv420p "$video" >"$log" 2>&1 &
echo $! >"$pid_file"`,
  );
  return {
    log: `${REMOTE_ROOT}/ffmpeg.log`,
    pidFile: `${REMOTE_ROOT}/ffmpeg.pid`,
    remoteVideo: `${REMOTE_ROOT}/session.mp4`,
  };
}
async function stopRemoteRecording(root: string, inspect: CrabboxInspect, session: SessionFile) {
  await sshRun(
    root,
    inspect,
    `pid_file=${shellQuote(session.recorder.pidFile)}; if [ -s "$pid_file" ]; then pid="$(cat "$pid_file")"; kill -INT "$pid" >/dev/null 2>&1 || true; sleep 2; kill -TERM "$pid" >/dev/null 2>&1 || true; fi`,
  );
}
function sessionPath(root: string, opts: Options, outputDir: string) {
  return path.join(outputDir, "session.json");
}
function writeSession(file: string, session: SessionFile) {
  fs.writeFileSync(file, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
}
function readSession(root: string, opts: Options, outputDir: string) {
  const file = sessionPath(root, opts, outputDir);
  return { path: file, session: JSON.parse(fs.readFileSync(file, "utf8")) as SessionFile };
}
async function createMotionPreview(params: {
  motionGifPath: string;
  motionVideoPath: string;
  opts: Options;
  root: string;
  videoPath: string;
}) {
  const preview = await runCommand({
    command: params.opts.crabboxBin,
    args: [
      "media",
      "preview",
      "--input",
      params.videoPath,
      "--output",
      params.motionGifPath,
      "--fps",
      String(params.opts.previewFps),
      "--width",
      String(params.opts.previewWidth),
      "--trimmed-video-output",
      params.motionVideoPath,
      "--json",
    ],
    cwd: params.root,
    stdio: "inherit",
  });
  return JSON.parse(preview.stdout) as JsonObject;
}
async function createCroppedMotionPreview(params: {
  croppedGifPath: string;
  croppedVideoPath: string;
  opts: Options;
  root: string;
  videoPath: string;
}) {
  const crop = `crop=${DISCORD_PROOF_VIEW.width}:${DISCORD_PROOF_VIEW.height}:${DISCORD_PROOF_VIEW.x}:${DISCORD_PROOF_VIEW.y}`;
  const scale = `scale=${params.opts.previewCropWidth}:-2:flags=lanczos`;
  await runCommand({
    command: "ffmpeg",
    args: [
      "-y",
      "-hide_banner",
      "-loglevel",
      "warning",
      "-i",
      params.videoPath,
      "-vf",
      `${crop},${scale}`,
      "-pix_fmt",
      "yuv420p",
      params.croppedVideoPath,
    ],
    cwd: params.root,
    stdio: "inherit",
  });
  await runCommand({
    command: "ffmpeg",
    args: [
      "-y",
      "-hide_banner",
      "-loglevel",
      "warning",
      "-i",
      params.videoPath,
      "-filter_complex",
      `${crop},fps=${params.opts.previewFps},${scale},split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`,
      params.croppedGifPath,
    ],
    cwd: params.root,
    stdio: "inherit",
  });
  return { crop, fps: params.opts.previewFps, outputWidth: params.opts.previewCropWidth };
}
async function startSession(root: string, opts: Options, outputDir: string) {
  const localRoot = path.join(outputDir, ".session");
  fs.rmSync(localRoot, { force: true, recursive: true });
  fs.mkdirSync(localRoot, { mode: 0o700, recursive: true });
  const profileArchiveEnv = "MANTIS_DISCORD_VIEWER_CHROME_PROFILE_TGZ_B64";
  const profileDir =
    process.env.MANTIS_DISCORD_VIEWER_CHROME_PROFILE_DIR?.trim() || `${REMOTE_ROOT}/chrome-profile`;
  if (
    !process.env[profileArchiveEnv]?.trim() &&
    !process.env.MANTIS_DISCORD_VIEWER_CHROME_PROFILE_DIR?.trim()
  )
    throw new Error(`Missing ${profileArchiveEnv} or MANTIS_DISCORD_VIEWER_CHROME_PROFILE_DIR.`);
  await runCommand({ command: opts.crabboxBin, args: ["--version"], cwd: root });
  if (opts.dryRun) return { outputDir, status: "pass" };
  const credential = await leaseCredential(root, opts, localRoot);
  const driver = await currentDiscordUser(credential.driverBotToken);
  const sut = await currentDiscordUser(credential.sutBotToken);
  if (sut.id !== credential.sutApplicationId)
    throw new Error("Discord SUT application id does not match SUT bot user id.");
  let leaseId = opts.leaseId;
  let createdLease = false;
  if (!leaseId) {
    leaseId = await warmupCrabbox(opts, root);
    createdLease = true;
  }
  const inspect = await inspectCrabbox(opts, root, leaseId);
  let localSut: LocalSut | undefined;
  try {
    await sshRun(
      root,
      inspect,
      remoteBrowserScript({ profileArchiveEnv, profileDir, url: messageUrl(credential) }),
    );
    localSut = await startLocalSutDaemon({
      credential,
      driverBotId: driver.id,
      mockResponseText: opts.mockResponseText,
      outputDir,
      repoRoot: root,
      opts,
    });
    const recorder = await startRemoteRecording(root, inspect, opts);
    const session: SessionFile = {
      command: "discord-web-crabbox-session",
      createdAt: new Date().toISOString(),
      crabbox: {
        class: opts.crabboxClass,
        createdLease,
        id: leaseId,
        inspect,
        provider: opts.provider,
        target: opts.target,
      },
      credential: {
        channelId: credential.channelId,
        guildId: credential.guildId,
        leaseFile: credential.leaseFile,
        sutApplicationId: credential.sutApplicationId,
      },
      localRoot,
      localSut,
      outputDir,
      recorder,
      remoteRoot: REMOTE_ROOT,
    };
    const file = sessionPath(root, opts, outputDir);
    writeSession(file, session);
    return {
      session: path.relative(root, file),
      status: "pass",
      discord: {
        channelId: credential.channelId,
        guildId: credential.guildId,
        sutApplicationId: credential.sutApplicationId,
      },
      webvnc: `${opts.crabboxBin} webvnc --provider ${opts.provider} --target ${opts.target} --id ${leaseId} --open`,
      commands: {
        send: `pnpm qa:discord-web:crabbox -- send --session ${path.relative(root, file)} --text '${opts.text}'`,
        view: `pnpm qa:discord-web:crabbox -- view --session ${path.relative(root, file)} --message-id <message-id>`,
        finish: `pnpm qa:discord-web:crabbox -- finish --session ${path.relative(root, file)} --preview-crop discord-window`,
      },
    };
  } catch (error) {
    killPidTree(localSut?.gatewayPid);
    killPidTree(localSut?.mockPid);
    await releaseCredential(root, credential.leaseFile).catch(() => {});
    if (createdLease && leaseId) await stopCrabbox(root, opts, leaseId).catch(() => {});
    throw error;
  }
}
async function sendSessionMessage(root: string, opts: Options, outputDir: string) {
  const { session } = readSession(root, opts, outputDir);
  const credential = parseDiscordCredential(
    readJson(path.join(session.localRoot, "credential-payload.json")),
  );
  const message = await discord<JsonObject>(
    credential.driverBotToken,
    "POST",
    `/channels/${credential.channelId}/messages`,
    { content: opts.text },
  );
  return {
    discordWebUrl: messageUrl(credential, requireString(message, "id")),
    messageId: requireString(message, "id"),
    status: "pass",
    text: opts.text,
  };
}
async function viewSession(root: string, opts: Options, outputDir: string) {
  const { session } = readSession(root, opts, outputDir);
  const url = messageUrl(session.credential, opts.messageId);
  const result = await sshRun(
    root,
    session.crabbox.inspect,
    `set -euo pipefail
export DISPLAY="\${DISPLAY:-:99}"
url=${shellQuote(url)}
xdg-open "$url" >/tmp/openclaw-discord-web-crabbox/view.log 2>&1 || true
sleep 5
wmctrl -r mantis-discord-web-proof -e 0,0,0,1280,900 || true`,
  );
  const logPath = path.join(
    session.outputDir,
    `proof-view-${new Date().toISOString().replace(/[:.]/gu, "-")}.log`,
  );
  fs.writeFileSync(logPath, `${result.stdout}${result.stderr}`);
  return { geometry: DISCORD_PROOF_VIEW, log: path.relative(root, logPath), status: "pass", url };
}
async function screenshotSession(root: string, opts: Options, outputDir: string) {
  const { session } = readSession(root, opts, outputDir);
  const screenshotPath = path.join(
    session.outputDir,
    `discord-web-crabbox-${new Date().toISOString().replace(/[:.]/gu, "-")}.png`,
  );
  await runCommand({
    command: opts.crabboxBin,
    args: [
      "screenshot",
      "--provider",
      session.crabbox.provider,
      "--target",
      session.crabbox.target,
      "--id",
      session.crabbox.id,
      "--output",
      screenshotPath,
    ],
    cwd: root,
    stdio: "inherit",
  });
  return { screenshot: path.relative(root, screenshotPath), status: "pass" };
}
async function statusSession(root: string, opts: Options, outputDir: string) {
  const { session } = readSession(root, opts, outputDir);
  const inspect = await inspectCrabbox(opts, root, session.crabbox.id);
  return {
    crabbox: { id: session.crabbox.id, slug: inspect.slug, state: inspect.state },
    status: "pass",
    webvnc: `${opts.crabboxBin} webvnc --provider ${session.crabbox.provider} --target ${session.crabbox.target} --id ${session.crabbox.id} --open`,
  };
}
function writeReport(params: {
  croppedGif?: string;
  croppedVideo?: string;
  gif: string;
  mp4: string;
  outputDir: string;
  screenshot: string;
  summaryPath: string;
  video: string;
}) {
  const report = path.join(params.outputDir, "discord-web-crabbox-session-report.md");
  fs.writeFileSync(
    report,
    [
      "# Discord Web Crabbox Proof",
      "",
      `Summary: \`${path.basename(params.summaryPath)}\``,
      `Screenshot: \`${path.basename(params.screenshot)}\``,
      `Motion GIF: \`${path.basename(params.gif)}\``,
      params.croppedGif ? `Cropped motion GIF: \`${path.basename(params.croppedGif)}\`` : undefined,
      `Motion MP4: \`${path.basename(params.mp4)}\``,
      params.croppedVideo
        ? `Cropped motion MP4: \`${path.basename(params.croppedVideo)}\``
        : undefined,
      `Full video: \`${path.basename(params.video)}\``,
      "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return report;
}
async function finishSession(root: string, opts: Options, outputDir: string) {
  const { path: file, session } = readSession(root, opts, outputDir);
  const summary: JsonObject = {
    artifacts: {},
    finishedAt: new Date().toISOString(),
    session: path.relative(root, file),
    startedAt: session.createdAt,
    status: "fail",
  };
  const videoPath = path.join(session.outputDir, "discord-web-crabbox-session.mp4");
  const motionVideoPath = path.join(session.outputDir, "discord-web-crabbox-session-motion.mp4");
  const motionGifPath = path.join(session.outputDir, "discord-web-crabbox-session-motion.gif");
  const croppedVideoPath = path.join(
    session.outputDir,
    "discord-web-crabbox-session-motion-discord-window.mp4",
  );
  const croppedGifPath = path.join(
    session.outputDir,
    "discord-web-crabbox-session-motion-discord-window.gif",
  );
  const screenshotPath = path.join(session.outputDir, "discord-web-crabbox-session.png");
  const ffmpegLogPath = path.join(session.outputDir, "ffmpeg.log");
  try {
    await stopRemoteRecording(root, session.crabbox.inspect, session);
    await scpFromRemote(root, session.crabbox.inspect, session.recorder.remoteVideo, videoPath);
    await scpFromRemote(root, session.crabbox.inspect, session.recorder.log, ffmpegLogPath).catch(
      () => {},
    );
    summary.mediaPreview = await createMotionPreview({
      motionGifPath,
      motionVideoPath,
      opts,
      root,
      videoPath,
    });
    if (opts.previewCrop)
      summary.croppedMediaPreview = await createCroppedMotionPreview({
        croppedGifPath,
        croppedVideoPath,
        opts,
        root,
        videoPath: motionVideoPath,
      });
    await runCommand({
      command: opts.crabboxBin,
      args: [
        "screenshot",
        "--provider",
        session.crabbox.provider,
        "--target",
        session.crabbox.target,
        "--id",
        session.crabbox.id,
        "--output",
        screenshotPath,
      ],
      cwd: root,
      stdio: "inherit",
    });
    summary.artifacts = {
      ffmpegLog: path.relative(root, ffmpegLogPath),
      previewGif: path.relative(root, motionGifPath),
      ...(opts.previewCrop
        ? {
            previewGifCropped: path.relative(root, croppedGifPath),
            trimmedVideoCropped: path.relative(root, croppedVideoPath),
          }
        : {}),
      screenshot: path.relative(root, screenshotPath),
      trimmedVideo: path.relative(root, motionVideoPath),
      video: path.relative(root, videoPath),
    };
    summary.status = "pass";
  } finally {
    killPidTree(session.localSut.gatewayPid);
    killPidTree(session.localSut.mockPid);
    await releaseCredential(root, session.credential.leaseFile).catch((error: unknown) => {
      summary.credentialReleaseError = error instanceof Error ? error.message : String(error);
    });
    if (session.crabbox.createdLease && !opts.keepBox)
      await stopCrabbox(root, opts, session.crabbox.id).catch((error: unknown) => {
        summary.crabboxStopError = error instanceof Error ? error.message : String(error);
      });
    if (opts.keepBox)
      summary.webvnc = `${opts.crabboxBin} webvnc --provider ${session.crabbox.provider} --target ${session.crabbox.target} --id ${session.crabbox.id} --open`;
    fs.rmSync(session.localRoot, { force: true, recursive: true });
    const summaryPath = path.join(session.outputDir, "discord-web-crabbox-session-summary.json");
    fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    const report = writeReport({
      croppedGif: opts.previewCrop ? croppedGifPath : undefined,
      croppedVideo: opts.previewCrop ? croppedVideoPath : undefined,
      gif: motionGifPath,
      mp4: motionVideoPath,
      outputDir: session.outputDir,
      screenshot: screenshotPath,
      summaryPath,
      video: videoPath,
    });
    summary.report = path.relative(root, report);
    fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(
      JSON.stringify({ reportPath: report, status: summary.status, summaryPath }, null, 2),
    );
  }
  if (summary.status !== "pass") process.exitCode = 1;
}
async function runSessionCommand(root: string, opts: Options, outputDir: string) {
  const { session } = readSession(root, opts, outputDir);
  const result = await sshRun(
    root,
    session.crabbox.inspect,
    opts.remoteCommand.map(shellQuote).join(" "),
  );
  const logPath = path.join(
    session.outputDir,
    `remote-command-${new Date().toISOString().replace(/[:.]/gu, "-")}.log`,
  );
  fs.writeFileSync(logPath, `${result.stdout}${result.stderr}`);
  return { command: opts.remoteCommand, log: path.relative(root, logPath), status: "pass" };
}
async function publishSession(root: string, opts: Options, outputDir: string) {
  const { session } = readSession(root, opts, outputDir);
  const gif = path.join(session.outputDir, "discord-web-crabbox-session-motion-discord-window.gif");
  const fallback = path.join(session.outputDir, "discord-web-crabbox-session-motion.gif");
  const publishGif = fs.existsSync(gif) ? gif : fallback;
  const publishDir = opts.publishFullArtifacts
    ? session.outputDir
    : path.join(session.outputDir, "publish-gif-only");
  if (!opts.publishFullArtifacts) {
    fs.rmSync(publishDir, { force: true, recursive: true });
    fs.mkdirSync(publishDir, { recursive: true });
    fs.copyFileSync(publishGif, path.join(publishDir, "discord-web-crabbox-session-motion.gif"));
  }
  await runCommand({
    command: opts.crabboxBin,
    args: [
      "artifacts",
      "publish",
      "--pr",
      String(opts.publishPr),
      "--repo",
      opts.publishRepo,
      "--dir",
      publishDir,
      "--summary",
      opts.publishSummary ?? "Discord Web Crabbox session motion GIF",
      "--template",
      "openclaw",
    ],
    cwd: root,
    stdio: "inherit",
  });
  return { publishDir: path.relative(root, publishDir), status: "pass" };
}
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = repoRoot();
  const outputDir = resolveRepoPath(root, opts.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  opts.outputDir = outputDir;
  if (opts.command === "start")
    return console.log(JSON.stringify(await startSession(root, opts, outputDir), null, 2));
  if (opts.command === "send")
    return console.log(JSON.stringify(await sendSessionMessage(root, opts, outputDir), null, 2));
  if (opts.command === "run")
    return console.log(JSON.stringify(await runSessionCommand(root, opts, outputDir), null, 2));
  if (opts.command === "screenshot")
    return console.log(JSON.stringify(await screenshotSession(root, opts, outputDir), null, 2));
  if (opts.command === "status")
    return console.log(JSON.stringify(await statusSession(root, opts, outputDir), null, 2));
  if (opts.command === "view")
    return console.log(JSON.stringify(await viewSession(root, opts, outputDir), null, 2));
  if (opts.command === "finish") return await finishSession(root, opts, outputDir);
  if (opts.command === "publish")
    return console.log(JSON.stringify(await publishSession(root, opts, outputDir), null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
