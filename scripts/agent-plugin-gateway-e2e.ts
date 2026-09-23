import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { formatErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { applyMockOpenAiModelConfig } from "./e2e/lib/fixtures/mock-openai-config.mjs";
import {
  hasUnjoinedWork,
  runManagedCommand,
  signalExitCode,
} from "./lib/managed-child-process.mts";

const LABEL = "agent-plugin-gateway-e2e";
const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const GATEWAY_TOKEN = "agent-plugin-gateway-e2e";
const MAX_LOG_BYTES = 128 * 1024;

type ChildOutcome = { code: number } | { error: unknown };

type CapturedChild = {
  label: string;
  output: { stderr: string; stdout: string };
  completion: Promise<ChildOutcome>;
  stop(): void;
  readonly outcome: ChildOutcome | undefined;
};

type ResponsesPayload = {
  output?: Array<{
    content?: Array<{ text?: string; type?: string }>;
    type?: string;
  }>;
};

type E2eConfig = Record<string, unknown> & {
  agents?: Record<string, unknown> & { defaults?: Record<string, unknown> };
  gateway?: Record<string, unknown>;
  tools?: Record<string, unknown>;
};

function appendBounded(current: string, chunk: Buffer | string): string {
  const next = `${current}${chunk.toString()}`;
  return next.length <= MAX_LOG_BYTES ? next : next.slice(-MAX_LOG_BYTES);
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function startCaptured(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    label: string;
    signal: AbortSignal;
    onSignal: (received: NodeJS.Signals) => void;
    timeoutMs?: number;
  },
): CapturedChild {
  const output = { stderr: "", stdout: "" };
  const stop = new AbortController();
  let outcome: ChildOutcome | undefined;
  const completion = runManagedCommand({
    bin: command,
    args,
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    signal: AbortSignal.any([options.signal, stop.signal]),
    onSignal: options.onSignal,
    timeoutMs: options.timeoutMs,
    timeoutKillGraceMs: 2_000,
    signalKillGraceMs: 2_000,
    abortKillGraceMs: 2_000,
    cleanupDrainTimeoutMs: 1_000,
    requireProcessTreeExit: process.platform !== "win32",
    onReady(child) {
      child.stdout?.on("data", (chunk: Buffer) => {
        output.stdout = appendBounded(output.stdout, chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        output.stderr = appendBounded(output.stderr, chunk);
      });
    },
  }).then(
    (code) =>
      (outcome =
        code === 0 ? { code } : { error: childFailure({ label: options.label, output }, code) }),
    (error: unknown) => (outcome = { error }),
  );
  return {
    label: options.label,
    output,
    completion,
    stop: () => stop.abort(),
    get outcome() {
      return outcome;
    },
  };
}

function childFailure(child: Pick<CapturedChild, "label" | "output">, code: number) {
  return new Error(
    `${child.label} failed (exit ${code})\n` +
      (child.output.stderr || child.output.stdout || "<no output>"),
  );
}

function assertChildRunning(child: CapturedChild, signal: AbortSignal): void {
  signal.throwIfAborted();
  if (child.outcome) {
    throw "error" in child.outcome ? child.outcome.error : childFailure(child, child.outcome.code);
  }
}

async function waitForHttp(
  url: string,
  child: CapturedChild,
  signal: AbortSignal,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertChildRunning(child, signal);
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]),
      });
      signal.throwIfAborted();
      if (response.ok) {
        return;
      }
    } catch {
      signal.throwIfAborted();
      // The service is still starting.
    }
    await delay(100, undefined, { signal });
  }
  throw new Error(`${child.label} did not become ready at ${url}\n${child.output.stderr}`);
}

async function waitForOutputLine(
  child: CapturedChild,
  predicate: (line: string) => boolean,
  signal: AbortSignal,
  timeoutMs = 30_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertChildRunning(child, signal);
    const line = `${child.output.stdout}\n${child.output.stderr}`.split(/\r?\n/u).find(predicate);
    if (line) {
      return line;
    }
    await delay(50, undefined, { signal });
  }
  throw new Error(`${child.label} did not emit the expected output\n${child.output.stderr}`);
}

async function writeFixture(pluginRoot: string): Promise<void> {
  const skillDir = path.join(pluginRoot, "skills", "forecast-brief");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginRoot, "plugin.json"),
    `${JSON.stringify(
      {
        $schema: PLUGIN_SCHEMA,
        name: "weather-helper",
        extensions: {
          "ai.openclaw": { activation: { onStartup: true } },
          "com.example.other": { ignored: true },
        },
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: forecast-brief\ndescription: Summarize a weather forecast.\n---\n\nUse the weather probe when asked for a forecast.\n",
  );
  await fs.writeFile(
    path.join(pluginRoot, "mcp.json"),
    `${JSON.stringify(
      {
        $schema: MCP_SCHEMA,
        mcpServers: {
          "weather-probe": {
            type: "stdio",
            command: "node",
            args: ["${PLUGIN_ROOT}/server.mjs"],
            env: { PROBE_MODE: "live" },
            cwd: "${PLUGIN_DATA}",
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(
    path.join(pluginRoot, "server.mjs"),
    `import fs from "node:fs";
import path from "node:path";

const pluginData = process.env.PLUGIN_DATA ?? "";
fs.writeFileSync(
  path.join(pluginData, "probe-launch.txt"),
  JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    pluginData,
    pluginRoot: process.env.PLUGIN_ROOT,
  }),
  "utf8",
);
let buffer = "";
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
function handle(message) {
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "weather-probe", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [{
          name: "weather_probe",
          description: "Reports the Agent Plugins subprocess environment contract.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        }],
      },
    });
    return;
  }
  if (message.method === "tools/call") {
    const text = [
      "probe ok",
      "PLUGIN_ROOT=" + process.env.PLUGIN_ROOT,
      "PLUGIN_DATA=" + process.env.PLUGIN_DATA,
      "PROBE_MODE=" + process.env.PROBE_MODE,
    ].join("; ");
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text }], isError: false },
    });
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).replace(/\\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
`,
  );
}

async function writeConfig(params: {
  configPath: string;
  gatewayPort: number;
  mockPort: number;
  workspaceDir: string;
}): Promise<void> {
  const installedConfig = JSON.parse(await fs.readFile(params.configPath, "utf8")) as E2eConfig;
  const cfg: E2eConfig = {
    ...installedConfig,
    agents: {
      ...installedConfig.agents,
      defaults: { ...installedConfig.agents?.defaults, workspace: params.workspaceDir },
    },
    gateway: {
      ...installedConfig.gateway,
      mode: "local",
      bind: "loopback",
      port: params.gatewayPort,
      auth: { mode: "token", token: GATEWAY_TOKEN },
      controlUi: { enabled: false },
      http: { endpoints: { responses: { enabled: true } } },
    },
    tools: { ...installedConfig.tools, profile: "coding" },
  };
  applyMockOpenAiModelConfig(cfg, { mockPort: params.mockPort });
  await fs.writeFile(params.configPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
}

function responseText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const output = (payload as ResponsesPayload).output;
  return (output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((content) => content.type === "output_text" && typeof content.text === "string")
    .map((content) => content.text)
    .join("\n");
}

async function main() {
  const cancellation = new AbortController();
  const signal = cancellation.signal;
  const children: CapturedChild[] = [];
  const failures: unknown[] = [];
  const interruption = new Error(`${LABEL} interrupted`);
  const handleSignal = (received?: NodeJS.Signals) => {
    if (received === "SIGHUP") {
      process.exitCode = signalExitCode(received);
    }
    // An external signal still fails the run after normal teardown has begun.
    if (!failures.includes(interruption)) {
      failures.push(interruption);
    }
    cancellation.abort(interruption);
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
  let rootDir: string | undefined;
  const keep = process.env.OPENCLAW_AGENT_PLUGIN_GATEWAY_E2E_KEEP === "1";
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const devRunnerPath = path.join(repoRoot, "scripts", "run-node.mjs");
  const entryPath = path.join(repoRoot, "dist", "index.js");
  const result = await (async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-plugin-gateway-"));
    rootDir = await fs.realpath(rootDir);
    const stateDir = path.join(rootDir, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const fixtureDir = path.join(rootDir, "weather-helper");
    const workspaceDir = path.join(rootDir, "workspace");
    const mockPort = await freePort();
    let gatewayPort = await freePort();
    while (gatewayPort === mockPort) {
      signal.throwIfAborted();
      gatewayPort = await freePort();
    }
    signal.throwIfAborted();
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      OPENAI_API_KEY: "agent-plugin-gateway-e2e",
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: "1",
      OPENCLAW_STATE_DIR: stateDir,
    };
    await fs.mkdir(stateDir, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });
    await writeFixture(fixtureDir);

    const install = startCaptured(
      process.execPath,
      [devRunnerPath, "plugins", "install", fixtureDir, "--force", "--accept-capabilities"],
      {
        cwd: repoRoot,
        env: childEnv,
        label: "plugin install",
        signal,
        onSignal: handleSignal,
        timeoutMs: 120_000,
      },
    );
    children.push(install);
    const installed = await install.completion;
    if ("error" in installed) {
      throw installed.error;
    }
    signal.throwIfAborted();
    await writeConfig({ configPath, gatewayPort, mockPort, workspaceDir });

    const mock = startCaptured(process.execPath, ["scripts/e2e/mock-openai-server.mjs"], {
      cwd: repoRoot,
      env: { ...childEnv, MOCK_PORT: String(mockPort) },
      label: "mock OpenAI server",
      signal,
      onSignal: handleSignal,
    });
    children.push(mock);
    await waitForHttp(`http://127.0.0.1:${mockPort}/health`, mock, signal);

    const gateway = startCaptured(
      process.execPath,
      [entryPath, "gateway", "--port", String(gatewayPort), "--bind", "loopback"],
      { cwd: repoRoot, env: childEnv, label: "gateway", signal, onSignal: handleSignal },
    );
    children.push(gateway);
    await waitForHttp(`http://127.0.0.1:${gatewayPort}/health`, gateway, signal, 120_000);
    const startupLog = await waitForOutputLine(
      gateway,
      (line) => line.includes("http server listening (") && line.includes("weather-helper"),
      signal,
    );

    const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${GATEWAY_TOKEN}`,
        "content-type": "application/json",
        "x-openclaw-agent": "main",
        "x-openclaw-scopes": "operator.write",
        "x-openclaw-session-key": "agent:main:openresponses:agent-plugin-gateway-e2e",
      },
      body: JSON.stringify({
        model: "openclaw/main",
        input: "agent plugin bundle qa check",
        max_output_tokens: 256,
        stream: false,
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
    });
    const responseBody = await response.text();
    if (!response.ok) {
      throw new Error(`gateway response failed (${response.status}): ${responseBody}`);
    }
    const finalText = responseText(JSON.parse(responseBody) as unknown);
    if (!finalText.includes("AGENT_BUNDLE_MCP_OK")) {
      throw new Error(`unexpected final response: ${finalText || responseBody}`);
    }

    const pluginOutput = `${install.output.stdout}\n${install.output.stderr}\n${gateway.output.stdout}\n${gateway.output.stderr}`;
    if (
      pluginOutput.includes("com.example.other") ||
      pluginOutput.includes("ignoring Agent Plugins")
    ) {
      throw new Error(`foreign extension namespace produced plugin diagnostics:\n${pluginOutput}`);
    }

    const installedPlugin = await fs.realpath(path.join(stateDir, "extensions", "weather-helper"));
    const pluginData = path.join(stateDir, "plugin-data", "weather-helper");
    const launchMarker = path.join(pluginData, "probe-launch.txt");
    const launchPayload = JSON.parse(await fs.readFile(launchMarker, "utf8")) as {
      argv?: unknown;
      cwd?: unknown;
      pluginData?: unknown;
      pluginRoot?: unknown;
    };
    const expectedLaunch = {
      argv: [],
      cwd: pluginData,
      pluginData,
      pluginRoot: installedPlugin,
    };
    if (JSON.stringify(launchPayload) !== JSON.stringify(expectedLaunch)) {
      throw new Error(
        `invalid probe launch contract: ${JSON.stringify({ expectedLaunch, launchPayload })}`,
      );
    }
    signal.throwIfAborted();
    return { ok: true, finalText, installedPlugin, launchMarker, startupLog };
  })().then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  if ("error" in result && !failures.includes(result.error)) {
    failures.push(result.error);
  }
  // Keep the mock available while the Gateway drains on ordinary completion or failure.
  for (const child of children.toReversed()) {
    child.stop();
    const outcome = await child.completion;
    if (
      "error" in outcome &&
      outcome.error !== signal.reason &&
      !(
        outcome.error instanceof Error &&
        "code" in outcome.error &&
        outcome.error.code === "ABORT_ERR"
      ) &&
      !failures.includes(outcome.error)
    ) {
      failures.push(outcome.error);
    }
  }
  try {
    if (rootDir) {
      if (keep || failures.some(hasUnjoinedWork)) {
        process.stderr.write(`[${LABEL}] retained fixture directory: ${rootDir}\n`);
      } else {
        await fs.rm(rootDir, { recursive: true, force: true });
      }
    }
  } catch (error) {
    failures.push(error);
  } finally {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
  }
  if ("error" in result || failures.length > 0) {
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(failures, `${LABEL} failed, including child cleanup`);
  }
  return result.value;
}

try {
  process.stdout.write(`${JSON.stringify(await main(), null, 2)}\n`);
} catch (error) {
  const message =
    error instanceof AggregateError
      ? formatErrorMessage(error, { redact: (text) => text })
      : error instanceof Error
        ? error.stack || error.message
        : String(error);
  const exitCode = Number(process.exitCode) || 1;
  process.stderr.write(`${message}\n[${LABEL}] FAILED (exit ${exitCode})\n`);
  process.exitCode = exitCode;
}
