import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import net from "node:net";
import { performance } from "node:perf_hooks";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { createOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";

type Options = {
  assertResponsive: boolean;
  assertStall: boolean;
  chunkSize: number;
  chunks: number;
  healthTimeoutMs: number;
  pingIntervalMs: number;
  responsiveThresholdMs: number;
  serverBatchSize: number;
  stallThresholdMs: number;
};

type LatencySummary = {
  count: number;
  max: number;
  min: number;
  over1000ms: number;
  over100ms: number;
  over500ms: number;
  p50: number;
  p95: number;
  p99: number;
};

type DenseStreamServer = {
  chatRequests: () => number;
  close: () => Promise<void>;
  port: number;
};

type StopFlag = {
  done: boolean;
};

type PingResult = {
  errors: number;
  samples: number[];
};

type EventLike = {
  event?: unknown;
  payload?: unknown;
};

const DEFAULT_OPTIONS: Options = {
  assertResponsive: false,
  assertStall: false,
  chunks: 10_000,
  chunkSize: 64,
  pingIntervalMs: 20,
  healthTimeoutMs: 10_000,
  responsiveThresholdMs: 1_000,
  serverBatchSize: 100,
  stallThresholdMs: 1_000,
};

function parsePositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(parsed) !== value.trim()) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    ...DEFAULT_OPTIONS,
    chunks:
      parsePositiveInteger(process.env.OPENCLAW_REPRO_DENSE_STREAM_CHUNKS, "chunks") ??
      DEFAULT_OPTIONS.chunks,
    chunkSize:
      parsePositiveInteger(process.env.OPENCLAW_REPRO_DENSE_STREAM_CHUNK_SIZE, "chunk-size") ??
      DEFAULT_OPTIONS.chunkSize,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readNumber = (name: string): number => {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${name} requires a value`);
      }
      index += 1;
      return parsePositiveInteger(value, name) ?? 0;
    };

    switch (arg) {
      case "--assert-responsive":
        options.assertResponsive = true;
        break;
      case "--assert-stall":
        options.assertStall = true;
        break;
      case "--chunks":
        options.chunks = readNumber("--chunks");
        break;
      case "--chunk-size":
        options.chunkSize = readNumber("--chunk-size");
        break;
      case "--health-timeout-ms":
        options.healthTimeoutMs = readNumber("--health-timeout-ms");
        break;
      case "--ping-interval-ms":
        options.pingIntervalMs = readNumber("--ping-interval-ms");
        break;
      case "--responsive-threshold-ms":
        options.responsiveThresholdMs = readNumber("--responsive-threshold-ms");
        break;
      case "--server-batch-size":
        options.serverBatchSize = readNumber("--server-batch-size");
        break;
      case "--stall-threshold-ms":
        options.stallThresholdMs = readNumber("--stall-threshold-ms");
        break;
      case "--help":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.assertResponsive && options.assertStall) {
    throw new Error("--assert-responsive and --assert-stall cannot be used together");
  }

  return options;
}

function printHelp(): void {
  console.log(`Usage: node --import tsx scripts/repro-gateway-dense-stream-latency.ts [options]

Starts a real OpenClaw gateway and points the Ollama provider at a local
Ollama-compatible endpoint that emits dense native /api/chat NDJSON.
While the agent stream is processed, a second gateway client measures health RPC latency.

Options:
  --chunks <n>              Dense stream chunk count (default: 10000)
  --chunk-size <n>          Text bytes per chunk (default: 64)
  --ping-interval-ms <n>    Health ping cadence during the run (default: 20)
  --health-timeout-ms <n>   Per-health RPC timeout (default: 10000)
  --server-batch-size <n>   Provider chunks to write before yielding (default: 100)
  --assert-stall            Exit nonzero unless max health latency exceeds threshold
  --stall-threshold-ms <n>  Assertion threshold for --assert-stall (default: 1000)
  --assert-responsive       Exit nonzero unless p99 health latency stays below threshold
  --responsive-threshold-ms <n> Assertion threshold for --assert-responsive (default: 1000)
`);
}

async function getFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") {
    throw new Error("failed to allocate a free port");
  }
  return address.port;
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function writeJson(res: ServerResponse, value: unknown): void {
  res.setHeader("content-type", "application/json");
  res.end(`${JSON.stringify(value)}\n`);
}

async function writeDenseChatResponse(
  res: ServerResponse,
  options: Options,
  chunkText: string,
): Promise<void> {
  for (let index = 0; index < options.chunks; index += 1) {
    const canContinue = res.write(
      `${JSON.stringify({
        model: "qwen2.5:0.5b",
        created_at: new Date().toISOString(),
        message: { role: "assistant", content: chunkText },
        done: false,
      })}\n`,
    );
    if (!canContinue) {
      await new Promise<void>((resolve) => res.once("drain", resolve));
    }
    if ((index + 1) % options.serverBatchSize === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  res.end(
    `${JSON.stringify({
      model: "qwen2.5:0.5b",
      created_at: new Date().toISOString(),
      message: { role: "assistant", content: "" },
      done: true,
      done_reason: "stop",
    })}\n`,
  );
}

async function createDenseStreamServer(options: Options): Promise<DenseStreamServer> {
  const port = await getFreePort();
  let chatRequests = 0;
  const chunkText = "x".repeat(options.chunkSize);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/api/tags") {
      writeJson(res, {
        models: [
          {
            name: "qwen2.5:0.5b",
            model: "qwen2.5:0.5b",
            modified_at: new Date().toISOString(),
            size: 1,
            digest: "dense-repro",
          },
        ],
      });
      return;
    }

    if (req.url === "/api/show") {
      writeJson(res, {
        model_info: { "qwen2.context_length": 32768 },
        parameters: "num_ctx 32768",
        capabilities: ["completion"],
      });
      return;
    }

    if (req.url === "/api/chat") {
      chatRequests += 1;
      req.resume();
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      void writeDenseChatResponse(res, options, chunkText).catch((error: unknown) => {
        res.destroy(error instanceof Error ? error : new Error(String(error)));
      });
      return;
    }

    res.statusCode = 404;
    res.end("not found\n");
  });

  await listen(server, port);
  return {
    port,
    chatRequests: () => chatRequests,
    close: () => closeServer(server),
  };
}

async function waitForGatewayPort(
  proc: ChildProcessWithoutNullStreams,
  port: number,
  logs: string[],
  timeoutMs = 120_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (proc.exitCode !== null) {
      throw new Error(
        `gateway exited code=${String(proc.exitCode)}\n${logs.join("").slice(-4000)}`,
      );
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host: "127.0.0.1", port });
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", (error) => {
          socket.destroy();
          reject(error);
        });
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(
    `timeout waiting for gateway port ${String(port)}\n${logs.join("").slice(-4000)}`,
  );
}

async function waitForExit(
  proc: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  return await Promise.race([
    new Promise<boolean>((resolve) => proc.once("exit", () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0;
}

function summarizeLatency(values: number[]): LatencySummary {
  if (values.length === 0) {
    return {
      count: 0,
      min: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      max: 0,
      over100ms: 0,
      over500ms: 0,
      over1000ms: 0,
    };
  }
  return {
    count: values.length,
    min: Math.round(Math.min(...values)),
    p50: Math.round(percentile(values, 0.5)),
    p95: Math.round(percentile(values, 0.95)),
    p99: Math.round(percentile(values, 0.99)),
    max: Math.round(Math.max(...values)),
    over100ms: values.filter((value) => value > 100).length,
    over500ms: values.filter((value) => value > 500).length,
    over1000ms: values.filter((value) => value > 1000).length,
  };
}

async function pingHealthLoop(
  client: Awaited<ReturnType<typeof connectGatewayClient>>,
  stopFlag: StopFlag,
  options: Options,
): Promise<PingResult> {
  const samples: number[] = [];
  let errors = 0;
  while (!stopFlag.done) {
    const startedAt = performance.now();
    try {
      await client.request("health", {}, { timeoutMs: options.healthTimeoutMs });
    } catch {
      errors += 1;
    }
    const elapsedMs = performance.now() - startedAt;
    samples.push(elapsedMs);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, options.pingIntervalMs - elapsedMs)),
    );
  }
  return { samples, errors };
}

function finalTextLength(events: EventLike[], runId: string): number {
  for (const event of events) {
    if (event.event !== "chat") {
      continue;
    }
    const payload = event.payload;
    if (
      !payload ||
      typeof payload !== "object" ||
      (payload as { runId?: unknown }).runId !== runId ||
      (payload as { state?: unknown }).state !== "final"
    ) {
      continue;
    }
    const message = (payload as { message?: unknown }).message;
    if (!message || typeof message !== "object") {
      continue;
    }
    const directText = (message as { text?: unknown }).text;
    if (typeof directText === "string") {
      return directText.length;
    }
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      return 0;
    }
    return content
      .map((entry) =>
        entry && typeof entry === "object" && typeof (entry as { text?: unknown }).text === "string"
          ? (entry as { text: string }).text
          : "",
      )
      .join("\n").length;
  }
  return 0;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const denseStreamServer = await createDenseStreamServer(options);
  const gatewayPort = await getFreePort();
  const gatewayToken = `gateway-token-${randomUUID()}`;
  const state = await createOpenClawTestState({
    label: `gateway-dense-stream-repro-${Date.now()}`,
    layout: "home",
    applyEnv: false,
  });
  await state.writeConfig({
    gateway: {
      port: gatewayPort,
      auth: { mode: "token", token: gatewayToken },
      controlUi: { enabled: false },
    },
    models: {
      providers: {
        ollama: {
          api: "ollama",
          baseUrl: `http://127.0.0.1:${String(denseStreamServer.port)}`,
          apiKey: "ollama-local",
          models: [
            {
              id: "qwen2.5:0.5b",
              name: "qwen2.5:0.5b",
              contextWindow: 32768,
              maxTokens: 8192,
              compat: { supportsTools: false, supportsUsageInStreaming: true },
            },
          ],
        },
      },
    },
    agents: { defaults: { model: { primary: "ollama/qwen2.5:0.5b" } } },
  });

  const logs: string[] = [];
  const proc = spawn(
    "node",
    [
      "scripts/run-node.mjs",
      "gateway",
      "--port",
      String(gatewayPort),
      "--bind",
      "loopback",
      "--allow-unconfigured",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...state.env,
        OPENCLAW_GATEWAY_TOKEN: "",
        OPENCLAW_GATEWAY_PASSWORD: "",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OLLAMA_API_KEY: "ollama-local",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => logs.push(String(chunk)));
  proc.stderr.on("data", (chunk) => logs.push(String(chunk)));

  try {
    await waitForGatewayPort(proc, gatewayPort, logs);
    const events: EventLike[] = [];
    const runClient = await connectGatewayClient({
      url: `ws://127.0.0.1:${String(gatewayPort)}`,
      token: gatewayToken,
      role: "operator",
      clientDisplayName: "dense-stream-repro-run",
      timeoutMs: 30_000,
      onEvent: (event) => events.push(event),
    });
    const pingClient = await connectGatewayClient({
      url: `ws://127.0.0.1:${String(gatewayPort)}`,
      token: gatewayToken,
      role: "operator",
      clientDisplayName: "dense-stream-repro-ping",
      timeoutMs: 30_000,
    });

    try {
      const baseline: number[] = [];
      for (let index = 0; index < 20; index += 1) {
        const startedAt = performance.now();
        await pingClient.request("health", {}, { timeoutMs: options.healthTimeoutMs });
        baseline.push(performance.now() - startedAt);
      }

      const stopFlag: StopFlag = { done: false };
      const pingResultPromise = pingHealthLoop(pingClient, stopFlag, options);
      const runId = `dense-${randomUUID()}`;
      const startedAt = performance.now();
      let sendResult: unknown;
      let waitResult: unknown;
      let ackMs = 0;
      let runError: unknown;
      try {
        sendResult = await runClient.request(
          "chat.send",
          {
            sessionKey: "agent:main:gateway-dense-stream-repro",
            idempotencyKey: runId,
            message: "Reply normally.",
          },
          { timeoutMs: 30_000 },
        );
        ackMs = performance.now() - startedAt;
        waitResult = await runClient.request(
          "agent.wait",
          { runId, timeoutMs: 120_000 },
          { timeoutMs: 125_000 },
        );
      } catch (err) {
        runError = err;
      } finally {
        stopFlag.done = true;
      }
      const pingResult = await pingResultPromise;
      if (runError) {
        throw runError;
      }
      const totalMs = performance.now() - startedAt;
      const during = summarizeLatency(pingResult.samples);
      const result = {
        liveGateway: true,
        providerProtocol: "ollama-native-compatible",
        realProviderDaemon: false,
        chunks: options.chunks,
        chunkBytes: options.chunkSize,
        serverBatchSize: options.serverBatchSize,
        finalExpectedChars: options.chunks * options.chunkSize,
        chatRequests: denseStreamServer.chatRequests(),
        sendStatus:
          sendResult && typeof sendResult === "object"
            ? (sendResult as { status?: unknown }).status
            : undefined,
        runStatus:
          waitResult && typeof waitResult === "object"
            ? (waitResult as { status?: unknown }).status
            : undefined,
        ackMs: Math.round(ackMs),
        totalMs: Math.round(totalMs),
        baseline: summarizeLatency(baseline),
        during: { ...during, errors: pingResult.errors },
        chatEvents: events.filter((event) => event.event === "chat").length,
        finalChars: finalTextLength(events, runId),
      };
      console.log(JSON.stringify(result, null, 2));

      if (options.assertStall && during.max < options.stallThresholdMs) {
        throw new Error(
          `expected max health latency >= ${String(options.stallThresholdMs)}ms, observed ${String(
            during.max,
          )}ms`,
        );
      }
      if (options.assertResponsive && during.p99 >= options.responsiveThresholdMs) {
        throw new Error(
          `expected p99 health latency < ${String(options.responsiveThresholdMs)}ms, observed ${String(
            during.p99,
          )}ms`,
        );
      }
    } finally {
      await disconnectGatewayClient(runClient).catch(() => {});
      await disconnectGatewayClient(pingClient).catch(() => {});
    }
  } finally {
    proc.kill("SIGTERM");
    if (!(await waitForExit(proc, 1_500))) {
      proc.kill("SIGKILL");
    }
    await state.cleanup();
    await denseStreamServer.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
