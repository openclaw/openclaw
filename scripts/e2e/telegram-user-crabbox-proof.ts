#!/usr/bin/env -S node --import tsx

import { type ChildProcess, spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type CommandResult = {
  stderr: string;
  stdout: string;
};

type JsonObject = Record<string, unknown>;

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
  crabboxBin: string;
  desktopChatTitle: string;
  dryRun: boolean;
  envFile?: string;
  expect: string[];
  gatewayPort: number;
  idleTimeout: string;
  keepBox: boolean;
  leaseId?: string;
  mockPort: number;
  outputDir: string;
  provider: string;
  recordSeconds: number;
  sutUsername?: string;
  target: string;
  tdlibSha256?: string;
  tdlibUrl?: string;
  text: string;
  timeoutMs: number;
  ttl: string;
  userDriverScript: string;
};

type LocalSut = {
  configPath: string;
  drained: {
    drained: number;
    pendingAfter?: number;
    pendingBefore?: number;
    webhookUrlSet: boolean;
  };
  mock: ChildProcess;
  mockLog: string;
  requestLog: string;
  stateDir: string;
  tempRoot: string;
  workspace: string;
  gateway: ChildProcess;
  gatewayLog: string;
};

const DEFAULT_SKILL_DIR = "~/.codex/skills/custom/telegram-e2e-bot-to-bot";
const DEFAULT_CONVEX_ENV_FILE = `${DEFAULT_SKILL_DIR}/convex.local.env`;
const DEFAULT_USER_DRIVER = `${DEFAULT_SKILL_DIR}/scripts/user-driver.py`;
const DEFAULT_OUTPUT_ROOT = ".artifacts/qa-e2e/telegram-user-crabbox";
const REMOTE_ROOT = "/tmp/openclaw-telegram-user-crabbox";

function usageText() {
  return [
    "Usage:",
    "  node --import tsx scripts/e2e/telegram-user-crabbox-proof.ts [--text /status] [--expect OpenClaw]",
    "",
    "Useful options:",
    "  --desktop-chat-title <name>   Telegram Desktop chat to select before recording.",
    "  --id <cbx_id>                 Reuse an existing Crabbox desktop lease.",
    "  --keep-box                    Leave the Crabbox lease running for VNC debugging.",
    "  --output-dir <path>           Artifact directory under the repo.",
    "  --record-seconds <seconds>    Desktop video duration. Default: 35.",
    "  --tdlib-sha256 <hex>         Expected SHA-256 for --tdlib-url. Defaults to <url>.sha256.",
    "  --tdlib-url <url>             Linux tdlib archive containing libtdjson.so.",
    "  --dry-run                     Validate local inputs and print the plan.",
  ].join("\n");
}

function usage(): never {
  throw new Error(usageText());
}

function expandHome(value: string) {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function trimToValue(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function parsePositiveInteger(value: string, label: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function parseArgs(argv: string[]): Options {
  argv = argv[0] === "--" ? argv.slice(1) : argv;
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const opts: Options = {
    crabboxBin: trimToValue(process.env.OPENCLAW_TELEGRAM_USER_CRABBOX_BIN) ?? "crabbox",
    desktopChatTitle:
      trimToValue(process.env.OPENCLAW_TELEGRAM_USER_DESKTOP_CHAT_TITLE) ?? "OpenClaw Testing",
    dryRun: false,
    expect: ["OpenClaw"],
    gatewayPort: 19_879,
    idleTimeout: "60m",
    keepBox: false,
    mockPort: 19_882,
    outputDir: path.join(DEFAULT_OUTPUT_ROOT, stamp),
    provider: process.env.OPENCLAW_TELEGRAM_USER_CRABBOX_PROVIDER?.trim() || "aws",
    recordSeconds: 35,
    target: "linux",
    text: "/status",
    timeoutMs: 90_000,
    ttl: "120m",
    userDriverScript: DEFAULT_USER_DRIVER,
  };
  let expectWasPassed = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        usage();
      }
      index += 1;
      return value;
    };
    if (arg === "--crabbox-bin") {
      opts.crabboxBin = readValue();
    } else if (arg === "--desktop-chat-title") {
      opts.desktopChatTitle = readValue();
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--env-file") {
      opts.envFile = readValue();
    } else if (arg === "--expect") {
      if (!expectWasPassed) {
        opts.expect = [];
        expectWasPassed = true;
      }
      opts.expect.push(readValue());
    } else if (arg === "--gateway-port") {
      opts.gatewayPort = parsePositiveInteger(readValue(), "--gateway-port");
    } else if (arg === "--id") {
      opts.leaseId = readValue();
    } else if (arg === "--idle-timeout") {
      opts.idleTimeout = readValue();
    } else if (arg === "--keep-box") {
      opts.keepBox = true;
    } else if (arg === "--mock-port") {
      opts.mockPort = parsePositiveInteger(readValue(), "--mock-port");
    } else if (arg === "--output-dir") {
      opts.outputDir = readValue();
    } else if (arg === "--provider") {
      opts.provider = readValue();
    } else if (arg === "--record-seconds") {
      opts.recordSeconds = parsePositiveInteger(readValue(), "--record-seconds");
    } else if (arg === "--sut-username") {
      opts.sutUsername = readValue().replace(/^@/u, "");
    } else if (arg === "--target") {
      opts.target = readValue();
    } else if (arg === "--tdlib-sha256") {
      opts.tdlibSha256 = readValue().toLowerCase();
    } else if (arg === "--tdlib-url") {
      opts.tdlibUrl = readValue();
    } else if (arg === "--text") {
      opts.text = readValue();
    } else if (arg === "--timeout-ms") {
      opts.timeoutMs = parsePositiveInteger(readValue(), "--timeout-ms");
    } else if (arg === "--ttl") {
      opts.ttl = readValue();
    } else if (arg === "--user-driver-script") {
      opts.userDriverScript = readValue();
    } else if (arg === "--help" || arg === "-h") {
      console.log(usageText());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function repoRoot() {
  const cwd = process.cwd();
  if (
    !fs.existsSync(path.join(cwd, "package.json")) ||
    !fs.existsSync(path.join(cwd, "scripts/e2e/mock-openai-server.mjs"))
  ) {
    throw new Error("Run from the OpenClaw repo root.");
  }
  return cwd;
}

function resolveRepoPath(root: string, value: string) {
  const resolved = path.isAbsolute(value) ? value : path.resolve(root, value);
  const relative = path.relative(root, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Output path must stay inside the repo: ${value}`);
  }
  return resolved;
}

function readJsonFile(filePath: string): JsonObject {
  try {
    return JSON.parse(fs.readFileSync(expandHome(filePath), "utf8")) as JsonObject;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function requireString(source: JsonObject, key: string) {
  const value = source[key];
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throw new Error(`Missing ${key}.`);
}

function optionalString(source: JsonObject, key: string) {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
      if (params.stdio === "inherit") {
        process.stdout.write(text);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      if (params.stdio === "inherit") {
        process.stderr.write(text);
      }
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      reject(
        new Error(
          `${params.command} ${params.args.join(" ")} failed with ${detail}\n${stdout}${stderr}`,
        ),
      );
    });
    if (params.stdin) {
      child.stdin.end(params.stdin);
    } else {
      child.stdin.end();
    }
  });
}

function spawnLogged(command: string, args: string[], options: SpawnOptionsWithoutStdio) {
  const child = spawn(command, args, {
    ...options,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let output = "";
  const capture = (chunk: string) => {
    output = `${output}${chunk}`.slice(-12000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  return {
    child,
    get output() {
      return output;
    },
  };
}

function waitForOutput(
  child: ChildProcess,
  pattern: RegExp,
  output: () => string,
  label: string,
  timeoutMs: number,
) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(`${label} did not become ready within ${timeoutMs}ms\n${output().slice(-4000)}`),
      );
    }, timeoutMs);
    const onData = () => {
      if (pattern.test(output())) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(
        new Error(
          `${label} exited before ready with code ${code ?? "unknown"}\n${output().slice(-4000)}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", onExit);
    onData();
  });
}

function killTree(child: ChildProcess | undefined) {
  if (!child || child.killed || child.exitCode !== null) {
    return;
  }
  if (!child.pid) {
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

async function telegram(token: string, method: string, body: JsonObject = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as JsonObject;
  if (!response.ok || payload.ok !== true) {
    throw new Error(
      optionalString(payload, "description") ?? `${method} failed with HTTP ${response.status}`,
    );
  }
  return payload.result;
}

async function drainSutUpdates(sutToken: string) {
  const before = telegramResultObject(await telegram(sutToken, "getWebhookInfo"), "getWebhookInfo");
  const rawUpdates = await telegram(sutToken, "getUpdates", {
    allowed_updates: ["message", "edited_message"],
    timeout: 0,
  });
  if (!Array.isArray(rawUpdates)) {
    throw new Error("getUpdates returned an invalid payload.");
  }
  const updates = rawUpdates;
  if (updates.length) {
    const last = updates.at(-1);
    if (
      last &&
      typeof last === "object" &&
      "update_id" in last &&
      typeof last.update_id === "number"
    ) {
      await telegram(sutToken, "getUpdates", { offset: last.update_id + 1, timeout: 0 });
    }
  }
  const after = telegramResultObject(await telegram(sutToken, "getWebhookInfo"), "getWebhookInfo");
  return {
    drained: updates.length,
    pendingAfter:
      typeof after.pending_update_count === "number" ? after.pending_update_count : undefined,
    pendingBefore:
      typeof before.pending_update_count === "number" ? before.pending_update_count : undefined,
    webhookUrlSet: typeof before.url === "string" && before.url.length > 0,
  };
}

async function sutIdentity(sutToken: string) {
  const result = telegramResultObject(await telegram(sutToken, "getMe"), "getMe");
  const username = requireString(result, "username").replace(/^@/u, "");
  return { id: requireString(result, "id"), username };
}

function telegramResultObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid payload.`);
  }
  return value as JsonObject;
}

function writeSutConfig(params: {
  gatewayPort: number;
  groupId: string;
  mockPort: number;
  outputDir: string;
  testerId: string;
}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tg-crabbox-sut-"));
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
      telegram: {
        allowFrom: [params.testerId],
        botToken: { id: "TELEGRAM_BOT_TOKEN", provider: "default", source: "env" },
        commands: { native: true, nativeSkills: false },
        dmPolicy: "allowlist",
        enabled: true,
        groupAllowFrom: [params.testerId],
        groupPolicy: "allowlist",
        groups: {
          [params.groupId]: {
            allowFrom: [params.testerId],
            groupPolicy: "allowlist",
            requireMention: false,
          },
        },
        replyToMode: "first",
      },
    },
    gateway: { auth: { mode: "none" }, bind: "loopback", mode: "local", port: params.gatewayPort },
    messages: { groupChat: { visibleReplies: "automatic" } },
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
      allow: ["telegram", "openai"],
      enabled: true,
      entries: { openai: { enabled: true }, telegram: { enabled: true } },
    },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { configPath, stateDir, tempRoot, workspace };
}

async function startLocalSut(params: {
  gatewayPort: number;
  groupId: string;
  mockPort: number;
  outputDir: string;
  sutToken: string;
  testerId: string;
  repoRoot: string;
}) {
  const drained = await drainSutUpdates(params.sutToken);
  const config = writeSutConfig(params);
  const requestLog = path.join(params.outputDir, "mock-openai-requests.ndjson");
  const mock = spawnLogged("node", ["scripts/e2e/mock-openai-server.mjs"], {
    cwd: params.repoRoot,
    env: {
      ...process.env,
      MOCK_PORT: String(params.mockPort),
      MOCK_REQUEST_LOG: requestLog,
      SUCCESS_MARKER: "OPENCLAW_E2E_OK",
    },
  });
  await waitForOutput(
    mock.child,
    /mock-openai listening/u,
    () => mock.output,
    "mock-openai",
    10_000,
  );
  const gateway = spawnLogged(
    "pnpm",
    ["openclaw", "gateway", "--port", String(params.gatewayPort)],
    {
      cwd: params.repoRoot,
      env: {
        ...process.env,
        OPENAI_API_KEY: "sk-openclaw-e2e-mock",
        OPENCLAW_CONFIG_PATH: config.configPath,
        OPENCLAW_STATE_DIR: config.stateDir,
        TELEGRAM_BOT_TOKEN: params.sutToken,
      },
    },
  );
  await waitForOutput(gateway.child, /\[gateway\] ready/u, () => gateway.output, "gateway", 60_000);
  return {
    ...config,
    drained,
    gateway: gateway.child,
    get gatewayLog() {
      return gateway.output;
    },
    mock: mock.child,
    get mockLog() {
      return mock.output;
    },
    requestLog,
  };
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
      "--idle-timeout",
      opts.idleTimeout,
      "--ttl",
      opts.ttl,
    ],
    cwd: root,
    stdio: "inherit",
  });
  const leaseId = extractLeaseId(`${result.stdout}\n${result.stderr}`);
  if (!leaseId) {
    throw new Error("Crabbox warmup did not print a lease id.");
  }
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
  if (!inspect.host || !inspect.sshKey || !inspect.sshUser) {
    throw new Error("Crabbox inspect output is missing SSH details.");
  }
  return {
    base: [
      "-i",
      inspect.sshKey,
      "-p",
      inspect.sshPort ?? "22",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=15",
    ],
    scpBase: [
      "-i",
      inspect.sshKey,
      "-P",
      inspect.sshPort ?? "22",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=15",
    ],
    target: `${inspect.sshUser}@${inspect.host}`,
  };
}

async function scpToRemote(root: string, inspect: CrabboxInspect, local: string, remote: string) {
  const ssh = sshArgs(inspect);
  await runCommand({
    command: "scp",
    args: [...ssh.scpBase, local, `${ssh.target}:${remote}`],
    cwd: root,
    stdio: "inherit",
  });
}

async function scpFromRemote(root: string, inspect: CrabboxInspect, remote: string, local: string) {
  const ssh = sshArgs(inspect);
  await runCommand({
    command: "scp",
    args: [...ssh.scpBase, `${ssh.target}:${remote}`, local],
    cwd: root,
    stdio: "inherit",
  });
}

async function sshRun(root: string, inspect: CrabboxInspect, remoteCommand: string) {
  const ssh = sshArgs(inspect);
  return await runCommand({
    command: "ssh",
    args: [...ssh.base, ssh.target, remoteCommand],
    cwd: root,
    stdio: "inherit",
  });
}

function renderRemoteSetup(params: { tdlibSha256?: string; tdlibUrl?: string }) {
  const tdlibSha256 = JSON.stringify(params.tdlibSha256 ?? "");
  const tdlibUrl = JSON.stringify(params.tdlibUrl ?? "");
  return `#!/usr/bin/env bash
set -euo pipefail
root=${REMOTE_ROOT}
tdlib_sha256=${tdlibSha256}
tdlib_url=${tdlibUrl}
mkdir -p "$root"
tar -xzf "$root/state.tgz" -C "$root"
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y curl git cmake g++ make zlib1g-dev libssl-dev python3 ffmpeg scrot xz-utils tar wmctrl xdotool libopengl0 libxcb-cursor0 libxcb-icccm4 libxcb-image0 libxcb-keysyms1 libxcb-randr0 libxcb-render-util0 libxcb-shape0 libxcb-xfixes0 libxcb-xinerama0 libxkbcommon-x11-0 >/tmp/openclaw-telegram-apt.log
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required" >&2
  exit 127
fi
if [ ! -x "$root/Telegram/Telegram" ]; then
  curl -fL https://telegram.org/dl/desktop/linux -o "$root/telegram.tar.xz"
  tar -xJf "$root/telegram.tar.xz" -C "$root"
fi
if ! ldconfig -p | grep -q libtdjson.so; then
  if [ -n "$tdlib_url" ]; then
    curl -fL "$tdlib_url" -o "$root/tdlib-linux.tgz"
    if [ -z "$tdlib_sha256" ]; then
      curl -fL "$tdlib_url.sha256" -o "$root/tdlib-linux.tgz.sha256"
      tdlib_sha256="$(awk '{print $1; exit}' "$root/tdlib-linux.tgz.sha256")"
    fi
    printf '%s  %s\\n' "$tdlib_sha256" "$root/tdlib-linux.tgz" | sha256sum -c -
    mkdir -p "$root/tdlib-linux"
    tar -xzf "$root/tdlib-linux.tgz" -C "$root/tdlib-linux"
    lib="$(find "$root/tdlib-linux" -name libtdjson.so -type f | head -n 1)"
    test -n "$lib"
    sudo install -m 0755 "$lib" /usr/local/lib/libtdjson.so
  else
    rm -rf "$root/td" "$root/td-build"
    git clone --depth 1 --branch v1.8.0 https://github.com/tdlib/td.git "$root/td"
    cmake -S "$root/td" -B "$root/td-build" -DCMAKE_BUILD_TYPE=Release -DTD_ENABLE_JNI=OFF
    cmake --build "$root/td-build" --target tdjson -j "$(nproc)"
    sudo cmake --install "$root/td-build"
  fi
  sudo ldconfig
fi
TELEGRAM_USER_DRIVER_STATE_DIR="$root/user-driver" python3 "$root/user-driver.py" status --json --timeout-ms 60000 >"$root/status.json"
`;
}

function renderLaunchDesktop() {
  return `#!/usr/bin/env bash
set -euo pipefail
root=${REMOTE_ROOT}
export DISPLAY="\${DISPLAY:-:99}"
pkill -f "$root/Telegram/Telegram" >/dev/null 2>&1 || true
nohup "$root/Telegram/Telegram" -workdir "$root/desktop" >"$root/telegram-desktop.log" 2>&1 &
pid=$!
sleep 8
if ! kill -0 "$pid" >/dev/null 2>&1; then
  cat "$root/telegram-desktop.log" >&2
  exit 1
fi
if ! wmctrl -l | grep -i telegram >/dev/null 2>&1; then
  cat "$root/telegram-desktop.log" >&2
  exit 1
fi
`;
}

function renderSelectDesktopChat(params: { chatTitle: string }) {
  return `#!/usr/bin/env bash
set -euo pipefail
chat_title=${JSON.stringify(params.chatTitle)}
export DISPLAY="\${DISPLAY:-:99}"
win="$(wmctrl -l | awk 'tolower($0) ~ /telegram/ {print $1; exit}')"
test -n "$win"
left=520
top=170
xdotool windowactivate --sync "$win"
xdotool windowsize "$win" 980 720
xdotool windowmove "$win" "$left" "$top"
sleep 1
xdotool mousemove "$((left + 180))" "$((top + 50))" click 1
xdotool key ctrl+a BackSpace
xdotool type --delay 5 -- "$chat_title"
sleep 2
xdotool mousemove "$((left + 150))" "$((top + 120))" click 1
sleep 1
`;
}

function renderRemoteProbe(params: {
  expect: string[];
  sutUsername: string;
  text: string;
  timeoutMs: number;
}) {
  const args = [
    "probe",
    "--text",
    params.text,
    "--timeout-ms",
    String(params.timeoutMs),
    "--output",
    `${REMOTE_ROOT}/probe.json`,
    "--json",
  ];
  for (const expected of params.expect) {
    args.push("--expect", expected);
  }
  const escapedArgs = args.map((arg) => JSON.stringify(arg)).join(" ");
  return `#!/usr/bin/env bash
set -euo pipefail
root=${REMOTE_ROOT}
export TELEGRAM_USER_DRIVER_STATE_DIR="$root/user-driver"
export TELEGRAM_USER_DRIVER_SUT_USERNAME=${JSON.stringify(params.sutUsername)}
python3 "$root/user-driver.py" ${escapedArgs}
`;
}

async function writeExecutable(filePath: string, content: string) {
  fs.writeFileSync(filePath, content);
  fs.chmodSync(filePath, 0o700);
}

async function prepareRemoteState(params: { localRoot: string; opts: Options; root: string }) {
  const stateArchive = path.join(params.localRoot, "remote-state.tgz");
  const userDriverScript = expandHome(params.opts.userDriverScript);
  if (!fs.existsSync(userDriverScript)) {
    throw new Error(`Missing user driver script: ${params.opts.userDriverScript}`);
  }
  await runCommand({
    command: "cp",
    args: [userDriverScript, path.join(params.localRoot, "user-driver.py")],
    cwd: params.root,
  });
  await runCommand({
    command: "tar",
    args: [
      "-C",
      params.localRoot,
      "-czf",
      stateArchive,
      "user-driver",
      "desktop",
      "user-driver.py",
    ],
    cwd: params.root,
  });
  return stateArchive;
}

async function leaseCredential(params: { localRoot: string; opts: Options; root: string }) {
  const userDriverDir = path.join(params.localRoot, "user-driver");
  const desktopWorkdir = path.join(params.localRoot, "desktop");
  const leaseFile = path.join(params.localRoot, "lease.json");
  const payloadFile = path.join(params.localRoot, "payload.json");
  const args = [
    "scripts/e2e/telegram-user-credential.ts",
    "lease-restore",
    "--user-driver-dir",
    userDriverDir,
    "--desktop-workdir",
    desktopWorkdir,
    "--lease-file",
    leaseFile,
    "--payload-output",
    payloadFile,
  ];
  if (params.opts.envFile) {
    args.push("--env-file", params.opts.envFile);
  }
  const result = await runCommand({
    command: "node",
    args: ["--import", "tsx", ...args],
    cwd: params.root,
    stdio: "inherit",
  });
  const acquired = JSON.parse(result.stdout || "{}") as JsonObject;
  const payload = readJsonFile(payloadFile);
  return {
    acquired,
    desktopWorkdir,
    groupId: requireString(payload, "groupId"),
    leaseFile,
    payloadFile,
    sutToken: requireString(payload, "sutToken"),
    testerUserId: requireString(payload, "testerUserId"),
    testerUsername: requireString(payload, "testerUsername"),
    userDriverDir,
  };
}

async function releaseCredential(root: string, opts: Options, leaseFile: string) {
  if (!fs.existsSync(leaseFile)) {
    return;
  }
  const args = ["scripts/e2e/telegram-user-credential.ts", "release", "--lease-file", leaseFile];
  if (opts.envFile) {
    args.push("--env-file", opts.envFile);
  }
  await runCommand({
    command: "node",
    args: ["--import", "tsx", ...args],
    cwd: root,
    stdio: "inherit",
  });
}

async function stopCrabbox(root: string, opts: Options, leaseId: string) {
  await runCommand({
    command: opts.crabboxBin,
    args: ["stop", "--provider", opts.provider, leaseId],
    cwd: root,
    stdio: "inherit",
  });
}

function buildTargetText(text: string, sutUsername: string) {
  if (!text.startsWith("/")) {
    return text.replaceAll("{sut}", sutUsername);
  }
  if (/^\/\S+@\w+/u.test(text)) {
    return text;
  }
  const [command, ...rest] = text.split(/\s+/u);
  return [`${command}@${sutUsername}`, ...rest].join(" ").trim();
}

function summarizeProbe(probePath: string) {
  const probe = readJsonFile(probePath);
  const reply = probe.reply;
  const sent = probe.sent;
  return {
    ok: probe.ok === true,
    replyMessageId: reply && typeof reply === "object" && "id" in reply ? reply.id : undefined,
    sentMessageId: sent && typeof sent === "object" && "id" in sent ? sent.id : undefined,
  };
}

function writeReport(params: {
  motionGifPath?: string;
  motionVideoPath?: string;
  outputDir: string;
  screenshotPath?: string;
  status: "pass" | "fail";
  summaryPath: string;
  videoPath?: string;
}) {
  const reportPath = path.join(params.outputDir, "telegram-user-crabbox-proof.md");
  fs.writeFileSync(
    reportPath,
    [
      "# Telegram User Crabbox Proof",
      "",
      `Status: ${params.status}`,
      `Summary: ${path.basename(params.summaryPath)}`,
      params.videoPath ? `Video: ${path.basename(params.videoPath)}` : "Video: missing",
      params.motionVideoPath
        ? `Motion video: ${path.basename(params.motionVideoPath)}`
        : "Motion video: missing",
      params.motionGifPath
        ? `Motion GIF: ${path.basename(params.motionGifPath)}`
        : "Motion GIF: missing",
      params.screenshotPath
        ? `Screenshot: ${path.basename(params.screenshotPath)}`
        : "Screenshot: missing",
      "",
    ].join("\n"),
  );
  return reportPath;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = repoRoot();
  const outputDir = resolveRepoPath(root, opts.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  opts.outputDir = outputDir;

  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-telegram-crabbox-"));
  const summary: JsonObject = {
    artifacts: {},
    crabbox: { provider: opts.provider, target: opts.target },
    outputDir,
    startedAt: new Date().toISOString(),
    status: "fail",
  };

  let credential: Awaited<ReturnType<typeof leaseCredential>> | undefined;
  let leaseId = opts.leaseId;
  let createdLease = false;
  let localSut: LocalSut | undefined;

  try {
    const convexEnvFile = expandHome(opts.envFile ?? DEFAULT_CONVEX_ENV_FILE);
    const hasConvexEnv =
      trimToValue(process.env.OPENCLAW_QA_CONVEX_SITE_URL) &&
      trimToValue(process.env.OPENCLAW_QA_CONVEX_SECRET_CI);
    if (!hasConvexEnv && !fs.existsSync(convexEnvFile)) {
      throw new Error(`Missing Convex env file: ${opts.envFile ?? DEFAULT_CONVEX_ENV_FILE}`);
    }
    await runCommand({ command: opts.crabboxBin, args: ["--version"], cwd: root });
    if (opts.dryRun) {
      summary.status = "pass";
      summary.plan = {
        command: "telegram-user-crabbox-proof",
        outputDir,
        provider: opts.provider,
        target: opts.target,
        tdlibSha256: opts.tdlibSha256,
        tdlibUrl: opts.tdlibUrl,
        text: opts.text,
      };
      return;
    }

    credential = await leaseCredential({ localRoot, opts, root });
    const sut = opts.sutUsername
      ? { id: "", username: opts.sutUsername }
      : await sutIdentity(credential.sutToken);
    const targetText = buildTargetText(opts.text, sut.username);
    summary.telegram = {
      groupId: credential.groupId,
      sutUsername: sut.username,
      testerUserId: credential.testerUserId,
      testerUsername: credential.testerUsername,
      text: targetText,
    };

    const stateArchive = await prepareRemoteState({
      localRoot,
      opts,
      root,
    });
    if (!leaseId) {
      leaseId = await warmupCrabbox(opts, root);
      createdLease = true;
    }
    summary.crabbox = {
      createdLease,
      id: leaseId,
      provider: opts.provider,
      target: opts.target,
    };
    const inspect = await inspectCrabbox(opts, root, leaseId);
    summary.crabbox = {
      createdLease,
      id: leaseId,
      provider: opts.provider,
      slug: inspect.slug,
      state: inspect.state,
      target: opts.target,
    };

    const setupScript = path.join(localRoot, "remote-setup.sh");
    const launchScript = path.join(localRoot, "launch-desktop.sh");
    const selectChatScript = path.join(localRoot, "select-desktop-chat.sh");
    const probeScript = path.join(localRoot, "remote-probe.sh");
    await writeExecutable(
      setupScript,
      renderRemoteSetup({ tdlibSha256: opts.tdlibSha256, tdlibUrl: opts.tdlibUrl }),
    );
    await writeExecutable(launchScript, renderLaunchDesktop());
    await writeExecutable(
      selectChatScript,
      renderSelectDesktopChat({ chatTitle: opts.desktopChatTitle }),
    );
    await writeExecutable(
      probeScript,
      renderRemoteProbe({
        expect: opts.expect,
        sutUsername: sut.username,
        text: targetText,
        timeoutMs: opts.timeoutMs,
      }),
    );

    await sshRun(root, inspect, `rm -rf ${REMOTE_ROOT} && mkdir -p ${REMOTE_ROOT}`);
    await scpToRemote(root, inspect, stateArchive, `${REMOTE_ROOT}/state.tgz`);
    await scpToRemote(root, inspect, setupScript, `${REMOTE_ROOT}/remote-setup.sh`);
    await scpToRemote(root, inspect, launchScript, `${REMOTE_ROOT}/launch-desktop.sh`);
    await scpToRemote(root, inspect, selectChatScript, `${REMOTE_ROOT}/select-desktop-chat.sh`);
    await scpToRemote(root, inspect, probeScript, `${REMOTE_ROOT}/remote-probe.sh`);
    await sshRun(root, inspect, `bash ${REMOTE_ROOT}/remote-setup.sh`);

    const sutRuntime = await startLocalSut({
      gatewayPort: opts.gatewayPort,
      groupId: credential.groupId,
      mockPort: opts.mockPort,
      outputDir,
      repoRoot: root,
      sutToken: credential.sutToken,
      testerId: credential.testerUserId,
    });
    localSut = sutRuntime;
    summary.localSut = {
      drained: sutRuntime.drained,
      gatewayPort: opts.gatewayPort,
      mockPort: opts.mockPort,
      requestLog: path.relative(root, sutRuntime.requestLog),
    };

    await sshRun(root, inspect, `bash ${REMOTE_ROOT}/launch-desktop.sh`);
    await sshRun(root, inspect, `bash ${REMOTE_ROOT}/select-desktop-chat.sh`);
    const videoPath = path.join(outputDir, "telegram-user-crabbox-proof.mp4");
    const recording = spawn(
      opts.crabboxBin,
      [
        "artifacts",
        "video",
        "--provider",
        opts.provider,
        "--target",
        opts.target,
        "--id",
        leaseId,
        "--duration",
        `${opts.recordSeconds}s`,
        "--output",
        videoPath,
      ],
      { cwd: root, stdio: "inherit" },
    );
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await sshRun(root, inspect, `bash ${REMOTE_ROOT}/remote-probe.sh`);
    const recordCode = await new Promise<number | null>((resolve) => recording.on("exit", resolve));
    if (recordCode !== 0) {
      throw new Error(`Crabbox recording failed with exit code ${recordCode ?? "unknown"}.`);
    }
    const motionVideoPath = path.join(outputDir, "telegram-user-crabbox-proof-motion.mp4");
    const motionGifPath = path.join(outputDir, "telegram-user-crabbox-proof-motion.gif");
    const preview = await runCommand({
      command: opts.crabboxBin,
      args: [
        "media",
        "preview",
        "--input",
        videoPath,
        "--output",
        motionGifPath,
        "--trimmed-video-output",
        motionVideoPath,
        "--json",
      ],
      cwd: root,
      stdio: "inherit",
    });
    summary.mediaPreview = JSON.parse(preview.stdout) as JsonObject;

    const screenshotPath = path.join(outputDir, "telegram-user-crabbox-proof.png");
    await runCommand({
      command: opts.crabboxBin,
      args: [
        "screenshot",
        "--provider",
        opts.provider,
        "--target",
        opts.target,
        "--id",
        leaseId,
        "--output",
        screenshotPath,
      ],
      cwd: root,
      stdio: "inherit",
    });
    const probePath = path.join(outputDir, "probe.json");
    const statusPath = path.join(outputDir, "status.json");
    const desktopLogPath = path.join(outputDir, "telegram-desktop.log");
    await scpFromRemote(root, inspect, `${REMOTE_ROOT}/probe.json`, probePath);
    await scpFromRemote(root, inspect, `${REMOTE_ROOT}/status.json`, statusPath);
    await scpFromRemote(root, inspect, `${REMOTE_ROOT}/telegram-desktop.log`, desktopLogPath);
    summary.artifacts = {
      desktopLog: path.relative(root, desktopLogPath),
      probe: path.relative(root, probePath),
      previewGif: path.relative(root, motionGifPath),
      screenshot: path.relative(root, screenshotPath),
      status: path.relative(root, statusPath),
      trimmedVideo: path.relative(root, motionVideoPath),
      video: path.relative(root, videoPath),
    };
    summary.probe = summarizeProbe(probePath);
    summary.status = "pass";
  } finally {
    killTree(localSut?.gateway);
    killTree(localSut?.mock);
    if (credential) {
      await releaseCredential(root, opts, credential.leaseFile).catch((error: unknown) => {
        summary.credentialReleaseError = error instanceof Error ? error.message : String(error);
      });
    }
    if (leaseId && createdLease && !opts.keepBox) {
      await stopCrabbox(root, opts, leaseId).catch((error: unknown) => {
        summary.crabboxStopError = error instanceof Error ? error.message : String(error);
      });
    }
    if (opts.keepBox && leaseId) {
      summary.keepBox = true;
      summary.webvnc = `${opts.crabboxBin} webvnc --provider ${opts.provider} --target ${opts.target} --id ${leaseId} --open`;
    }
    summary.finishedAt = new Date().toISOString();
    const summaryPath = path.join(outputDir, "telegram-user-crabbox-proof-summary.json");
    fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    const artifacts = summary.artifacts;
    const screenshotPath =
      artifacts &&
      typeof artifacts === "object" &&
      "screenshot" in artifacts &&
      typeof artifacts.screenshot === "string"
        ? path.join(root, artifacts.screenshot)
        : undefined;
    const motionGifPath =
      artifacts &&
      typeof artifacts === "object" &&
      "previewGif" in artifacts &&
      typeof artifacts.previewGif === "string"
        ? path.join(root, artifacts.previewGif)
        : undefined;
    const motionVideoPath =
      artifacts &&
      typeof artifacts === "object" &&
      "trimmedVideo" in artifacts &&
      typeof artifacts.trimmedVideo === "string"
        ? path.join(root, artifacts.trimmedVideo)
        : undefined;
    const videoPath =
      artifacts &&
      typeof artifacts === "object" &&
      "video" in artifacts &&
      typeof artifacts.video === "string"
        ? path.join(root, artifacts.video)
        : undefined;
    const reportPath = writeReport({
      motionGifPath,
      motionVideoPath,
      outputDir,
      screenshotPath,
      status: summary.status === "pass" ? "pass" : "fail",
      summaryPath,
      videoPath,
    });
    summary.report = path.relative(root, reportPath);
    fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    fs.rmSync(localRoot, { force: true, recursive: true });
    console.log(JSON.stringify({ outputDir, reportPath, status: summary.status }, null, 2));
  }

  if (summary.status !== "pass") {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
