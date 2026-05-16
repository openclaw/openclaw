import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const READY_TIMEOUT_MS = 120_000;
const DEFAULT_FUNCTION_NAME = "openclaw-vefaas-sandbox";
const DEFAULT_IMAGE =
  "enterprise-public-cn-beijing.cr.volces.com/vefaas-public/all-in-one-sandbox:1.9.3";
const DEFAULT_IMAGE_COMMAND = "/opt/gem/run.sh";
const DEFAULT_PORT = 8080;
const DEFAULT_REMOTE_WORKSPACE_DIR = "/workspace";
const DEFAULT_TTL_SECONDS = 3600;
const DEFAULT_TIMEOUT_MS = 120_000;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig(args.config);
  const resolved = resolveConfig(config);
  const sandboxName =
    args.sandboxName ||
    buildSandboxName(args.sessionKey || process.env.OPENCLAW_ACP_SESSION_KEY || randomUUID());
  const runtime = await ensureRuntime({
    config: resolved,
    sandboxName,
  });
  const bridge = new WebShellStdioBridge({
    endpointProvider: async () => {
      const endpoint = await getWebshellEndpoint({
        sdk: runtime.sdk,
        client: runtime.client,
        functionId: runtime.functionId,
        instanceName: runtime.instanceName,
      });
      if (!endpoint) {
        throw new Error("VEFaaS OpenCode ACP proxy requires a WebShell endpoint.");
      }
      return endpoint;
    },
    command: buildRemoteAcpCommand({
      command: resolved.opencode.entrypoint,
      workdir: resolved.remoteWorkspaceDir,
      env: resolved.opencode.env,
    }),
    remoteWorkspaceDir: resolved.remoteWorkspaceDir,
  });
  await bridge.run();
}

if (isDirectExecution()) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : JSON.stringify(error);
    process.stderr.write(`openclaw-vefaas-opencode-acp: ${message}\n`);
    process.exitCode = 1;
  });
}

function isDirectExecution() {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint && import.meta.url === pathToFileURL(entrypoint).href);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") {
      result.config = requireNext(argv, ++index, arg);
      continue;
    }
    if (arg === "--sandbox-name") {
      result.sandboxName = requireNext(argv, ++index, arg);
      continue;
    }
    if (arg === "--session-key") {
      result.sessionKey = requireNext(argv, ++index, arg);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function requireNext(argv, index, flag) {
  const value = argv[index];
  if (!value) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

async function loadConfig(configPath) {
  if (configPath) {
    return JSON.parse(await fs.readFile(configPath, "utf8"));
  }
  const raw = process.env.OPENCLAW_VEFAAS_SANDBOX_CONFIG;
  if (!raw) {
    throw new Error("Missing --config or OPENCLAW_VEFAAS_SANDBOX_CONFIG.");
  }
  return JSON.parse(raw);
}

function resolveConfig(raw) {
  return {
    functionId: trim(raw.functionId),
    functionName: trim(raw.functionName) || DEFAULT_FUNCTION_NAME,
    region: trim(raw.region),
    endpoint: trim(raw.endpoint),
    image: trim(raw.image) || DEFAULT_IMAGE,
    imageCommand: trim(raw.imageCommand) || DEFAULT_IMAGE_COMMAND,
    port: Number.isInteger(raw.port) ? raw.port : DEFAULT_PORT,
    remoteWorkspaceDir: normalizeRemotePath(raw.remoteWorkspaceDir, DEFAULT_REMOTE_WORKSPACE_DIR),
    ttlSeconds: Number.isFinite(raw.ttlSeconds) ? raw.ttlSeconds : DEFAULT_TTL_SECONDS,
    timeoutMs: Number.isFinite(raw.timeoutMs)
      ? raw.timeoutMs
      : Number.isFinite(raw.timeoutSeconds)
        ? Math.floor(raw.timeoutSeconds * 1000)
        : DEFAULT_TIMEOUT_MS,
    resources: isRecord(raw.resources) ? raw.resources : {},
    opencode: {
      entrypoint: trim(raw.opencode?.entrypoint) || "opencode",
      env: isRecord(raw.opencode?.env) ? raw.opencode.env : {},
    },
  };
}

async function ensureRuntime(params) {
  const sdk = await import("@volcengine/vefaas");
  const client = createClient(sdk, params.config);
  const functionId = await resolveFunctionId({ sdk, client, config: params.config });
  const existing = await findInstance({
    sdk,
    client,
    functionId,
    sandboxName: params.sandboxName,
  });
  if (existing) {
    return { ...existing, sdk, client };
  }

  let result;
  try {
    result = await client.send(
      new sdk.CreateSandboxCommand({
        FunctionId: functionId,
        SessionId: params.sandboxName,
        Timeout: Math.max(1, Math.ceil(params.config.ttlSeconds / 60)),
        TimeoutUnit: "minute",
        CpuMilli: resourceCpuMilli(params.config.resources.cpuCores),
        MemoryMB: params.config.resources.memoryMiB,
        MaxConcurrency: 10,
        RequestTimeout: Math.ceil(params.config.timeoutMs / 1000),
        Envs: Object.entries(
          buildAllInOneEnv({
            workspaceDir: params.config.remoteWorkspaceDir,
            port: params.config.port,
          }),
        ).map(([Key, Value]) => ({ Key, Value })),
        Metadata: {
          openclaw: "true",
          sandboxName: params.sandboxName,
          purpose: "opencode-acp",
        },
        InstanceImageInfo: {
          Image: params.config.image,
          Command: params.config.imageCommand,
          Port: params.config.port,
        },
      }),
    );
  } catch (error) {
    throw new Error(`failed to create VEFaaS sandbox: ${errorMessage(error)}`);
  }
  const instanceName = stringField(result, ["Result", "SandboxId"]) || params.sandboxName;
  const runtime = await waitForInstance({
    sdk,
    client,
    functionId,
    sandboxName: params.sandboxName,
    instanceName,
  });
  return { ...runtime, sdk, client };
}

async function resolveFunctionId(params) {
  if (params.config.functionId) {
    return params.config.functionId;
  }
  const result = await params.client.send(
    new params.sdk.ListFunctionsCommand({
      PageNumber: 1,
      PageSize: 100,
    }),
  );
  const match = arrayField(result, ["Result", "Items"]).find(
    (item) => stringField(item, ["Name"]) === params.config.functionName,
  );
  if (!match) {
    throw new Error(
      `VEFaaS function ${params.config.functionName} was not found; configure functionId.`,
    );
  }
  const functionId = stringField(match, ["Id"]);
  if (!functionId) {
    throw new Error(`VEFaaS function ${params.config.functionName} did not include an id.`);
  }
  return functionId;
}

async function waitForInstance(params) {
  const deadline = Date.now() + Math.max(READY_TIMEOUT_MS, 1);
  while (Date.now() < deadline) {
    const runtime = await findInstance(params);
    if (runtime?.instanceName === params.instanceName) {
      return runtime;
    }
    await sleep(3_000);
  }
  throw new Error(`Timed out waiting for VEFaaS sandbox instance ${params.instanceName}.`);
}

async function findInstance(params) {
  const sandbox = await findSandbox(params);
  if (!sandbox) {
    return null;
  }
  const result = await params.client.send(
    new params.sdk.ListFunctionInstancesCommand({
      FunctionId: params.functionId,
    }),
  );
  const exact = arrayField(result, ["Result", "Items"]).find(
    (item) =>
      stringField(item, ["InstanceName"]) === sandbox.instanceName ||
      stringField(item, ["Id"]) === sandbox.instanceName,
  );
  if (!exact) {
    return null;
  }
  const status = stringField(exact, ["InstanceStatus"]);
  if (status && status !== "Ready") {
    return null;
  }
  const instanceName = stringField(exact, ["InstanceName"]) || sandbox.instanceName;
  return {
    functionId: params.functionId,
    instanceName,
  };
}

async function findSandbox(params) {
  const result = await params.client.send(
    new params.sdk.ListSandboxesCommand({
      FunctionId: params.functionId,
      Metadata: {
        openclaw: "true",
        sandboxName: params.sandboxName,
      },
      PageNumber: 1,
      PageSize: 100,
    }),
  );
  const sandboxes =
    arrayField(result, ["Result", "Sandboxes"]).length > 0
      ? arrayField(result, ["Result", "Sandboxes"])
      : arrayField(result, ["Sandboxes"]);
  const exact = sandboxes.find(
    (item) =>
      stringField(item, ["SessionId"]) === params.sandboxName ||
      stringField(item, ["Metadata", "sandboxName"]) === params.sandboxName,
  );
  if (!exact) {
    return null;
  }
  const status = stringField(exact, ["Status"]);
  if (status && !["Ready", "Running"].includes(status)) {
    return null;
  }
  const instanceName = stringField(exact, ["Id"]);
  return instanceName ? { instanceName } : null;
}

async function getWebshellEndpoint(params) {
  const result = await params.client.send(
    new params.sdk.GenWebshellEndpointCommand({
      FunctionId: params.functionId,
      InstanceName: params.instanceName,
    }),
  );
  return result
    ? stringField(result, ["Result", "Endpoint"]) || stringField(result, ["Endpoint"])
    : undefined;
}

function createClient(sdk, config) {
  const clientConfig = {};
  const accessKeyId =
    process.env.VOLCENGINE_ACCESS_KEY ||
    process.env.VOLCENGINE_ACCESS_KEY_ID ||
    process.env.VOLCSTACK_ACCESS_KEY ||
    process.env.VOLCSTACK_ACCESS_KEY_ID;
  const secretAccessKey =
    process.env.VOLCENGINE_SECRET_KEY ||
    process.env.VOLCENGINE_SECRET_ACCESS_KEY ||
    process.env.VOLCSTACK_SECRET_KEY ||
    process.env.VOLCSTACK_SECRET_ACCESS_KEY;
  const sessionToken = process.env.VOLCENGINE_SESSION_TOKEN || process.env.VOLCSTACK_SESSION_TOKEN;
  if (accessKeyId) {
    clientConfig.accessKeyId = accessKeyId;
  }
  if (secretAccessKey) {
    clientConfig.secretAccessKey = secretAccessKey;
  }
  if (sessionToken) {
    clientConfig.sessionToken = sessionToken;
  }
  if (config.region) {
    clientConfig.region = config.region;
  }
  if (config.endpoint) {
    clientConfig.endpoint = config.endpoint;
  }
  return new sdk.VEFAASClient(clientConfig);
}

class WebShellStdioBridge {
  constructor(config) {
    this.config = config;
    this.ws = undefined;
    this.stdoutBuffer = "";
    this.stdinBuffer = "";
  }

  async run() {
    const WebSocketCtor = globalThis.WebSocket;
    if (!WebSocketCtor) {
      throw new Error("VEFaaS WebShell ACP proxy requires a Node.js runtime with WebSocket support.");
    }
    this.ws = await this.openWebSocket(WebSocketCtor);
    this.sendStdin("stty -echo -icanon min 1 time 0\n");
    this.sendStdin(`${this.config.command}\n`);
    await sleep(500);

    const onInput = (chunk) => this.handleLocalInput(Buffer.from(chunk).toString("utf8"));
    process.stdin.on("data", onInput);
    process.stdin.on("end", () => {
      if (this.stdinBuffer) {
        this.sendStdin(rewriteAcpInputLine(this.stdinBuffer, this.config.remoteWorkspaceDir));
        this.stdinBuffer = "";
      }
      this.sendStdin("\u0004");
    });
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("message", (event) => this.handleMessage(event));
      this.ws.addEventListener("error", (event) =>
        reject(new Error(`VEFaaS WebShell error: ${formatWebSocketEvent(event)}`)),
      );
      this.ws.addEventListener("close", () => resolve());
      process.on("SIGTERM", () => {
        this.close();
        resolve();
      });
      process.on("SIGINT", () => {
        this.close();
        resolve();
      });
    });
    process.stdin.off("data", onInput);
  }

  async openWebSocket(WebSocketCtor) {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let ws;
      try {
        const endpoint = await this.config.endpointProvider();
        ws = new WebSocketCtor(endpoint);
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error("Timed out opening VEFaaS WebShell.")),
            30_000,
          );
          const cleanup = () => clearTimeout(timeout);
          ws.addEventListener(
            "open",
            () => {
              cleanup();
              resolve();
            },
            { once: true },
          );
          ws.addEventListener(
            "error",
            (event) => {
              cleanup();
              reject(new Error(`VEFaaS WebShell error: ${formatWebSocketEvent(event)}`));
            },
            { once: true },
          );
          ws.addEventListener(
            "close",
            (event) => {
              cleanup();
              reject(
                new Error(`VEFaaS WebShell closed while opening: ${formatWebSocketEvent(event)}`),
              );
            },
            { once: true },
          );
        });
        return ws;
      } catch (error) {
        lastError = error;
        try {
          ws?.close();
        } catch {
          // Ignore failed cleanup for a socket that never opened.
        }
        if (attempt < 3) {
          await sleep(attempt * 1_000);
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Failed to open VEFaaS WebShell.");
  }

  handleMessage(event) {
    const text = frameToText(messageDataToString(event));
    if (!text) {
      return;
    }
    this.stdoutBuffer += stripAnsi(text).replace(/\r/g, "");
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !looksLikeJsonRpc(trimmed)) {
        if (trimmed && process.env.OPENCLAW_VEFAAS_ACP_DEBUG === "1") {
          process.stderr.write(`[vefaas-acp] ${trimmed}\n`);
        }
        continue;
      }
      process.stdout.write(`${trimmed}\n`);
    }
  }

  sendStdin(data) {
    this.ws?.send(JSON.stringify({ Op: "stdin", Data: data }));
  }

  handleLocalInput(data) {
    this.stdinBuffer += data;
    for (;;) {
      const newlineIndex = this.stdinBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const line = this.stdinBuffer.slice(0, newlineIndex + 1);
      this.stdinBuffer = this.stdinBuffer.slice(newlineIndex + 1);
      this.sendStdin(rewriteAcpInputLine(line, this.config.remoteWorkspaceDir));
    }
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // Ignore close races.
    }
  }
}

export function rewriteAcpInputLine(line, remoteWorkspaceDir) {
  const newline = line.endsWith("\n") ? "\n" : "";
  const body = newline ? line.slice(0, -1) : line;
  const carriage = body.endsWith("\r") ? "\r" : "";
  const trimmedBody = carriage ? body.slice(0, -1) : body;
  if (!trimmedBody.trim().startsWith("{")) {
    return line;
  }
  try {
    const parsed = JSON.parse(trimmedBody);
    if (
      isRecord(parsed) &&
      parsed.jsonrpc === "2.0" &&
      isRecord(parsed.params) &&
      typeof parsed.params.cwd === "string"
    ) {
      parsed.params = {
        ...parsed.params,
        cwd: remoteWorkspaceDir,
      };
      return `${JSON.stringify(parsed)}${carriage}${newline}`;
    }
  } catch {
    return line;
  }
  return line;
}

function buildRemoteAcpCommand(params) {
  const scriptPath = `/tmp/openclaw-vefaas-opencode-acp-${randomUUID()}.py`;
  const payload = Buffer.from(
    JSON.stringify({
      command: params.command,
      args: ["acp"],
      workdir: params.workdir,
      env: params.env,
    }),
  ).toString("base64");
  const chunks = payload.match(/.{1,1000}/g) ?? [];
  const script = [
    "import base64, json, os, subprocess, sys",
    "payload = json.loads(base64.b64decode(''.join(sys.argv[1:])))",
    "if payload.get('workdir'):",
    "    os.makedirs(payload['workdir'], exist_ok=True)",
    "    os.chdir(payload['workdir'])",
    "env = os.environ.copy()",
    "env.update(payload.get('env') or {})",
    "argv = [payload['command'], *payload.get('args', [])]",
    "proc = subprocess.Popen(argv, stdin=sys.stdin.buffer, stdout=sys.stdout.buffer, stderr=sys.stderr.buffer, env=env)",
    "sys.exit(proc.wait())",
  ].join("\n");
  return [
    `cat > ${quoteShellArg(scriptPath)} <<'OPENCLAW_VEFAAS_ACP_PY'`,
    script,
    "OPENCLAW_VEFAAS_ACP_PY",
    ["python3", quoteShellArg(scriptPath), ...chunks.map(quoteShellArg)].join(" "),
  ].join("\n");
}

function quoteShellArg(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function buildAllInOneEnv(params) {
  return {
    USER: "gem",
    USER_UID: "1000",
    USER_GID: "1000",
    DISPLAY: ":99.0",
    DISPLAY_DEPTH: "24",
    WORKSPACE: params.workspaceDir,
    LOG_DIR: "/var/log/gem",
    PUBLIC_PORT: String(params.port),
    AUTH_BACKEND_PORT: "8081",
    SANDBOX_SRV_PORT: "8091",
    WAIT_PORTS: "8091",
    AIO_BASE_URL: "http://localhost:8091",
    MAX_SHELL_SESSIONS: "10",
    NODE_CODE_EXEC_VERSION: "node22",
    NODEJS_REPL_PORT_20: "8192",
    NODEJS_REPL_PORT_22: "8092",
    NODEJS_REPL_PORT_24: "8392",
    DISABLE_NODEJS_REPL: "false",
    DISABLE_JUPYTER: "true",
    DISABLE_CODE_SERVER: "true",
    DISABLE_BROWSER: "true",
    DISABLE_MCP_BROWSER: "true",
    DISABLE_VNC: "true",
    ENABLE_CJK_IME: "false",
    MCP_SERVER_BROWSER_PORT: "8100",
    BROWSER_REMOTE_DEBUGGING_PORT: "9222",
    BROWSER_EXECUTABLE_PATH: "/usr/local/bin/browser",
    AGENT_BROWSER_EXECUTABLE_PATH: "/usr/local/bin/browser",
    BROWSER_EXTRA_ARGS: "",
    BROWSER_DOWNLOAD_DIR: "",
    BROWSER_NO_SANDBOX: "",
    BROWSER_LANG: "en-US",
    CHROME_UI_LANG: "",
    BROWSER_USER_AGENT: "",
    DISPLAY_WIDTH: "1280",
    DISPLAY_HEIGHT: "1024",
    VNC_SERVER_PORT: "5900",
    WEBSOCKET_PROXY_PORT: "6080",
    JUPYTER_LAB_PORT: "8888",
    CODE_SERVER_PORT: "8200",
    OPENCODE_PORT: "4096",
    TINYPROXY_PORT: "8118",
    LOG_STDOUT_SERVER: "false",
    LOG_TOOL_TRACE: "false",
    RUN_HOOK_INIT: "",
    RUN_HOOK_PRE_SERVICES: "",
    RUN_HOOK_POST_READY: "",
    RUN_HOOKS_STRICT: "false",
    SANDBOX_SHUTDOWN_HOOKS: "",
    SANDBOX_SHUTDOWN_HOOKS_TIMEOUT: "30",
    AIO_CLI_SKILL_ENABLED: "false",
    AIO_SKILLS_PATH: "",
    EXTRA_MCP_SERVERS: "",
    PUBLIC_LISTEN_IPV4: "0.0.0.0",
    PUBLIC_LISTEN_IPV6: "[::]",
    JWT_PUBLIC_KEY: "",
    HOMEPAGE: "",
    GITHUB_TOKEN: "",
    BROWSER_INIT_COOKIES: "",
    BROWSER_URL_BLOCKLIST: "",
    BROWSER_URL_ALLOWLIST: "",
    PROXY_BYPASS_LIST: "",
    DNS_OVER_HTTPS_TEMPLATES: "",
    PYTHON_CODE_EXEC_VERSION: "python3",
    LANG: "en_US.UTF-8",
    LANGUAGE: "en_US:en",
    LC_ALL: "en_US.UTF-8",
    TZ: "Asia/Shanghai",
    OTEL_SDK_DISABLED: "false",
    OTEL_PYTHON_DISABLED_INSTRUMENTATIONS: "redis",
    PYTHONPATH: "",
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
    RUNTIME_LOGDIR: "/var/log/gem",
    UV_TOOL_BIN_DIR: "/usr/local/bin/",
    UV_TOOL_DIR: "/usr/local/share/uv/tools",
    GO_PATH: "/usr/local/go",
    CC: "gcc",
    CXX: "g++",
    FNM_DIR: "/opt/fnm",
    NODEJS_DIR: "/opt/nodejs",
  };
}

function looksLikeJsonRpc(value) {
  if (!value.startsWith("{")) {
    return false;
  }
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) && parsed.jsonrpc === "2.0";
  } catch {
    return false;
  }
}

function buildSandboxName(seed) {
  const safe = seed
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const hash = createHash("sha256").update(seed).digest("hex").slice(0, 8);
  return `oc-vefaas-acp-${safe || "opencode"}-${hash}`;
}

function normalizeRemotePath(value, fallback) {
  const candidate = trim(value) || fallback;
  const normalized = path.posix.normalize(candidate);
  if (!normalized.startsWith("/") || normalized === "/") {
    throw new Error(`VEFaaS remote path must be absolute and not root: ${candidate}`);
  }
  return normalized;
}

function trim(value) {
  return typeof value === "string" ? value.trim() : "";
}

function resourceCpuMilli(cpuCores) {
  return typeof cpuCores === "number" ? Math.floor(cpuCores * 1000) : undefined;
}

function stringField(value, keys) {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return typeof current === "string" && current.trim() ? current : undefined;
}

function arrayField(value, keys) {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) {
      return [];
    }
    current = current[key];
  }
  return Array.isArray(current) ? current : [];
}

function messageDataToString(event) {
  const data = event?.data;
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  return "";
}

function frameToText(value) {
  try {
    const parsed = JSON.parse(value);
    if (isRecord(parsed)) {
      return typeof parsed.Data === "string" ? parsed.Data : "";
    }
  } catch {
    return value;
  }
  return value;
}

function stripAnsi(value) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function formatWebSocketEvent(event) {
  if (!event || typeof event !== "object") {
    return String(event);
  }
  const parts = [];
  if ("message" in event && typeof event.message === "string" && event.message) {
    parts.push(event.message);
  }
  if ("error" in event && event.error instanceof Error) {
    parts.push(event.error.message);
  }
  if ("code" in event && typeof event.code === "number") {
    parts.push(`code=${event.code}`);
  }
  if ("reason" in event && typeof event.reason === "string" && event.reason) {
    parts.push(`reason=${event.reason}`);
  }
  return parts.join(", ") || String(event);
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
