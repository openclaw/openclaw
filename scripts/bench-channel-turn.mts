import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { once } from "node:events";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  writeSync,
  renameSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as immediate, setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { startOpenClawCrablineAdapter } from "@openclaw/crabline";
import { startQaBusServer, createQaBusState } from "../extensions/qa-lab/bus-api.ts";
import type { AnyAgentTool } from "../src/agents/agent-tools.types.js";
import type { ToolHandlerContext } from "../src/agents/embedded-agent-subscribe.handlers.types.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { applyMockOpenAiModelConfig } from "./e2e/lib/fixtures/mock-openai-config.mjs";
import { stopChild } from "./lib/gateway-bench-child.ts";
import { getFreePort } from "./lib/gateway-bench-probes.ts";
import {
  controlGatewayProfile,
  measureGatewayCpuUsage,
  readGatewayCpuUsage,
  readGatewayResources,
  type GatewayCpuUsage,
  type GatewayResourceSnapshot,
} from "./lib/gateway-bench-profile.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  waitForInitialProbe,
  writeGatewayBenchConfig,
} from "./lib/gateway-bench-runtime.ts";
const { values } = parseArgs({
  options: {
    entry: { type: "string", default: "dist/entry.js" },
    help: { type: "boolean", short: "h" },
    resources: { type: "boolean", default: false },
    "cpu-profile": { type: "boolean", default: false },
    "tool-invocations": { type: "boolean", default: false },
    "tool-argument-bytes": { type: "string", default: "65536" },
    "tool-progress-events": { type: "string", default: "500" },
    "tool-calls": { type: "string", default: "200" },
    "tool-samples": { type: "string", default: "5" },
    "tool-start-file": { type: "string" },
    "tool-interval-ms": { type: "string", default: "100" },
    "tool-gc-log": { type: "string" },
    channel: { type: "string", default: "qa-channel" },
    "reply-chars": { type: "string", default: "0" },
  },
});
if (values.help) {
  console.log(
    "Usage: node --import ./scripts/tsx.mjs scripts/bench-channel-turn.mts [--entry dist/entry.js] [--channel qa-channel|telegram|slack] [--reply-chars N]\nRuns one cold and ten warmed channel turns with an isolated local mock provider.\nWith --channel telegram or slack, the channel plugin talks to a local Crabline provider server.\nWith --reply-chars N, each reply is a generated technical Markdown answer of at least N characters.\nOr use --tool-invocations [--tool-argument-bytes 65536] [--tool-progress-events 500] [--tool-calls 200] [--tool-samples 5] [--tool-interval-ms 100] --tool-gc-log <stdout-log> with --expose-gc --trace-gc-nvp, redirecting stdout to that log, for real tool-owner allocation, promotion, GC and latency measurements without a Gateway.",
  );
  process.exit(0);
}
if (values["tool-invocations"]) {
  await measureToolInvocations();
  process.exit(0);
}
const crablineChannel =
  values.channel === "telegram" || values.channel === "slack" ? values.channel : undefined;
const replyChars = Number(values["reply-chars"]);
if (
  (!crablineChannel && values.channel !== "qa-channel") ||
  !Number.isSafeInteger(replyChars) ||
  replyChars < 0
) {
  console.error(
    "--channel must be qa-channel, telegram or slack and --reply-chars a non-negative integer",
  );
  process.exit(2);
}
// A long coding answer: headings, lists, links, inline code with HTML-sensitive characters and
// fenced TypeScript. Long replies pad the turn number so every turn has the same length.
function buildReply(turn: number) {
  const id = replyChars > 0 ? String(turn).padStart(2, "0") : String(turn);
  const intro = `Synthetic channel measurement response ${id}. The Gateway receives this streamed answer from the local mock provider and delivers it ${crablineChannel ? `through the ${crablineChannel} plugin to a local Crabline server` : "to the isolated QA bus"}.`;
  const parts = [intro];
  for (let step = 1, length = intro.length; length < replyChars; step++) {
    const section = [
      `## Step ${step}: keep chunk ${step} within budget`,
      `1. Read [render-aware-chunking.ts](https://github.com/openclaw/openclaw/blob/main/packages/markdown-core/src/render-aware-chunking.ts) before changing \`limit <= ${step * 100}\`.\n2. Keep \`Map<string, Chunk[]>\` entries in order & drop empty ones.\n3. Compare [step ${step - 1}](#step-${step - 1}) when \`chunks[${step}] !== undefined\`.`,
      `- The budget counts rendered characters, so \`<b>\` and \`&amp;\` count in full.\n- Prefer a paragraph break, then a line break, then a space.`,
      `\`\`\`ts\nexport function planStep${step}(chunks: readonly string[], limit = ${step * 100}): string[] {\n  const kept: string[] = [];\n  for (const chunk of chunks) {\n    if (chunk.length > 0 && chunk.length <= limit && !chunk.includes("<&>")) {\n      kept.push(chunk.trim());\n    }\n  }\n  return kept;\n}\n\`\`\``,
    ];
    parts.push(...section);
    length += section.reduce((sum, part) => sum + part.length + 2, 0);
  }
  if (parts.length > 1) {
    parts.push(`End of synthetic channel measurement response ${id}.`);
  }
  return parts.join("\n\n");
}
const output = mkdtempSync(path.join(tmpdir(), "sqlmeasure-channel-"));
const fixture = path.join(output, "fixture");
mkdirSync(fixture);
type TurnIdentity = { phase: string; turnId: string };
type TurnEvidence = TurnIdentity & {
  key: string;
  messageId: string;
  firstOutboundMs: number;
  finalOutboundMs: number;
  settledMs: number;
  outboundMessages: number;
  cpu?: GatewayCpuUsage;
  result: { status: "ok" };
  outboundId?: string;
  reply: { length: number; sha256: string };
  lastOutboundMs?: number;
  provider?: { methods: string[]; sends: number; rejectedSends: number; digest: string };
};
const evidence: {
  output: string;
  harnessVersion: string;
  workload: { channel: string; replyChars: number };
  phases: { phase: string; start: number; end: number }[];
  turns: TurnEvidence[];
  children: { name: string; pid: number }[];
  ports?: { port: number; mockPort: number };
  ready?: unknown;
  shutdown?: [number | null, NodeJS.Signals | null];
  bus?: unknown;
  resources?: { before: GatewayResourceSnapshot; after: GatewayResourceSnapshot };
  ok?: boolean;
  error?: string;
} = {
  output,
  harnessVersion: "2.0.0-channel.1",
  workload: { channel: values.channel, replyChars },
  phases: [],
  turns: [],
  children: [],
};
const children: ChildProcess[] = [];
const traces: Record<string, TurnIdentity> = {};
const messages: Record<string, TurnIdentity> = {};
let phase = "01.boot";
let phaseStart = Date.now();
let bus: Awaited<ReturnType<typeof startQaBusServer>> | undefined;
let crabline: Awaited<ReturnType<typeof startOpenClawCrablineAdapter>> | undefined;
const providerCalls: {
  method: string;
  body: Record<string, unknown>;
  accepted: boolean;
  at: number;
}[] = [];
let slackApi: ReturnType<typeof createServer> | undefined;
const providerReady = Promise.withResolvers<void>();
let gateway: ChildProcess | undefined;
let interrupted = false;
let cleanupPromise: Promise<void> | undefined;
function save() {
  writeFileSync(path.join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
}
function cleanup() {
  return (cleanupPromise ??= (async () => {
    try {
      await Promise.all(
        children.map((child) => stopChild(child, { teardownGraceMs: 10000, killGraceMs: 2000 })),
      );
    } finally {
      const server = slackApi;
      server?.closeAllConnections();
      const closed = await Promise.allSettled([
        bus?.stop(),
        server &&
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
        crabline?.close(),
      ]);
      const failure = closed.find((result) => result.status === "rejected");
      if (failure) {
        evidence.ok = false;
        evidence.error ??= String(failure.reason);
        process.exitCode = 1;
      }
      evidence.phases.push({ phase, start: phaseStart, end: Date.now() });
      save();
    }
  })());
}
function interrupt(signal: "SIGINT" | "SIGTERM") {
  if (interrupted) {
    return;
  }
  interrupted = true;
  evidence.ok = false;
  evidence.error = `Interrupted by ${signal}`;
  void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
}
const onSigint = () => interrupt("SIGINT");
const onSigterm = () => interrupt("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);
function setPhase(next: string) {
  evidence.phases.push({ phase, start: phaseStart, end: Date.now() });
  phase = next;
  phaseStart = Date.now();
  writeFileSync(path.join(output, "phase.new"), phase);
  renameSync(path.join(output, "phase.new"), path.join(output, "phase"));
  console.log("PHASE", phase);
  save();
}
function launch(args: string[], env: NodeJS.ProcessEnv, name: string, ipc = false) {
  if (interrupted) {
    throw new Error("Benchmark interrupted");
  }
  const out = createWriteStream(path.join(output, name + ".log"));
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env,
    stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout?.pipe(out);
  child.stderr?.pipe(out);
  children.push(child);
  if (child.pid === undefined) {
    throw new Error(`Failed to spawn ${name}`);
  }
  evidence.children.push({ name, pid: child.pid });
  save();
  return child;
}
// Telegram DMs share the sender's id; Slack DMs pair a native D conversation with a U user.
const directPeers = {
  telegram: ["sqlmeasure-user", "sqlmeasure-user"],
  slack: ["DSQLMEASURE", "USQLMEASURE"],
} as const;
async function runProviderTurn(
  adapter: NonNullable<typeof crabline>,
  channel: keyof typeof directPeers,
  turn: number,
  text: string,
  reply: string,
  gatewayPort: number,
  register: (messageId: string) => void,
) {
  const [conversation, senderId] = directPeers[channel];
  const inbound = adapter.createInbound({
    input: {
      conversation: { kind: "direct", id: conversation },
      senderId,
      senderName: "SQL measurement",
      text,
    },
  });
  // Observers key turns by the inbound id the Gateway sees. Telegram ids must grow past the
  // replies already sent to the chat; Slack's ts is known before the bench delivers the event.
  const telegramMessageId = (turn + 1) * 1000;
  if (channel === "telegram") {
    register(String(telegramMessageId));
  }
  const first = providerCalls.length;
  const start = Date.now();
  const response = await fetch(inbound.providerUrl, {
    method: "POST",
    headers: inbound.providerHeaders,
    body: JSON.stringify({
      ...inbound.providerBody,
      ...(channel === "telegram" && { messageId: telegramMessageId }),
    }),
  });
  if (!response.ok) {
    throw new Error(`Crabline ${channel} inbound failed with HTTP ${response.status}`);
  }
  const ingress = (await response.json()) as { event?: unknown; message?: { ts?: string } };
  const messageId = channel === "telegram" ? String(telegramMessageId) : ingress.message?.ts;
  if (!messageId) {
    throw new Error(`Crabline ${channel} inbound returned no message id`);
  }
  const manifest = adapter.manifest;
  if (manifest.provider === "slack") {
    register(messageId);
    // Slack pushes events: sign Crabline's native event and await the Gateway webhook ack.
    const body = JSON.stringify(ingress.event);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", manifest.signingSecret)
      .update(`v0:${timestamp}:${body}`)
      .digest("hex");
    const ack = await fetch(`http://127.0.0.1:${gatewayPort}/slack/events`, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": `v0=${signature}`,
      },
    });
    await ack.arrayBuffer();
    if (!ack.ok) {
      throw new Error(`Slack Gateway webhook failed with HTTP ${ack.status}`);
    }
  }
  // The last message carries the reply's last line; a quiet second covers typing and reactions.
  const lastLine = reply.slice(reply.lastIndexOf("\n") + 1);
  const sendMethod = channel === "telegram" ? "sendMessage" : "chat.postMessage";
  const sends = () => providerCalls.slice(first).filter((call) => call.method === sendMethod);
  const deadline = Date.now() + 180000;
  let last: (typeof providerCalls)[number] | undefined;
  while (!last || Date.now() - (providerCalls.at(-1)?.at ?? 0) < 1000) {
    if (gateway?.exitCode !== null || gateway.signalCode !== null) {
      throw new Error("Gateway exited during turn");
    }
    if (Date.now() >= deadline) {
      throw new Error(`${channel} reply did not settle`);
    }
    await delay(50);
    last ??= sends().find((call) => call.accepted && String(call.body.text).includes(lastLine));
  }
  return {
    key: `${channel}:${inbound.providerTargetKey}`,
    messageId,
    firstOutboundMs: (sends()[0]?.at ?? start) - start,
    lastOutboundMs: last.at - start,
    provider: {
      methods: providerCalls
        .slice(first)
        .map(({ method, accepted }) => (accepted ? method : `${method}:rejected`)),
      sends: sends().length,
      rejectedSends: sends().filter((call) => !call.accepted).length,
      // Reactions and typing interleave freely; the delivered message bodies must not change.
      digest: createHash("sha256")
        .update(JSON.stringify(sends().map(({ body, accepted }) => ({ body, accepted }))))
        .digest("hex"),
    },
  };
}
function publish(file: string, value: unknown) {
  const target = path.join(output, file);
  writeFileSync(target + ".new", JSON.stringify(value));
  renameSync(target + ".new", target);
}
writeFileSync(path.join(output, "phase"), phase);
console.log("OUTPUT", output);
try {
  const port = await getFreePort();
  const mockPort = await getFreePort();
  evidence.ports = { port, mockPort };
  const state = createQaBusState();
  if (crablineChannel) {
    // Loaded here so the default and tool-invocation modes never load Crabline.
    const { startOpenClawCrablineAdapter: startCrabline } = await import("@openclaw/crabline");
    crabline = await startCrabline({
      channel: crablineChannel,
      recorderPath: path.join(output, "provider-api.jsonl"),
      onEvent: (event) => {
        // The Slack front below records Slack's calls itself.
        const method = event.path.split("/").at(-1);
        if (crablineChannel !== "telegram" || event.type !== "api" || !method) {
          return;
        }
        // Crabline's Telegram server marks whether it committed each call.
        const accepted = (event as { accepted?: boolean }).accepted === true;
        // Telegram starts polling only after its startup calls.
        if (method === "getUpdates") {
          if (accepted) {
            providerReady.resolve();
          }
          return;
        }
        providerCalls.push({
          method,
          body: (event.body ?? {}) as Record<string, unknown>,
          accepted,
          at: Date.now(),
        });
      },
    });
  }
  if (crabline?.manifest.provider === "slack") {
    // Every Slack Web API call passes through this front, which records it and whether Slack's
    // `ok` came back. Crabline's Slack server lacks users.info and reactions; real Slack answers
    // them, and the plugin would otherwise retry users.info with backoff on every turn.
    const apiRoot = String(crabline.createProviderReadinessEnv({}).SLACK_API_URL);
    const parseJson = (text: string): unknown => {
      try {
        return JSON.parse(text);
      } catch {
        return undefined;
      }
    };
    slackApi = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const url = new URL(String(request.url), apiRoot);
        const method = url.pathname.replace(/^\/api\//u, "");
        const raw = Buffer.concat(chunks);
        const parsed = String(request.headers["content-type"]).includes("json")
          ? parseJson(raw.toString())
          : Object.fromEntries(new URLSearchParams(raw.toString()));
        const { token: _token, ...body } = (parsed ?? {}) as Record<string, unknown>;
        const record = (accepted: boolean) => {
          providerCalls.push({ method, body, accepted, at: Date.now() });
          if (method === "auth.test" && accepted) {
            providerReady.resolve();
          }
        };
        if (method === "users.info" || method.startsWith("reactions.")) {
          record(true);
          const user = { id: directPeers.slack[1], team_id: "TCRABLINE", name: "sqlmeasure" };
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(method === "users.info" ? { ok: true, user } : { ok: true }));
          return;
        }
        void fetch(new URL(method + url.search, apiRoot), {
          method: request.method,
          headers: Object.fromEntries(
            ["authorization", "content-type"].flatMap((name) =>
              request.headers[name] ? [[name, String(request.headers[name])]] : [],
            ),
          ),
          ...(request.method === "POST" ? { body: raw } : {}),
        })
          .then(async (upstream) => {
            const text = await upstream.text();
            record(upstream.ok && (parseJson(text) as { ok?: unknown } | undefined)?.ok === true);
            const retryAfter = upstream.headers.get("retry-after");
            response.writeHead(upstream.status, {
              "content-type": "application/json",
              ...(retryAfter && { "retry-after": retryAfter }),
            });
            response.end(text);
          })
          .catch(() => {
            record(false);
            if (!response.headersSent) {
              response.writeHead(502);
            }
            response.end();
          });
      });
    });
    const server = slackApi;
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
  }
  const cfg: OpenClawConfig = structuredClone(BASE_GATEWAY_BENCH_CONFIG);
  cfg.tools = { codeMode: false };
  applyMockOpenAiModelConfig(cfg, { mockPort, modelRef: "openai/gpt-4.1" });
  cfg.agents = {
    ...cfg.agents,
    defaults: { ...cfg.agents?.defaults, skipBootstrap: true },
  };
  cfg.agents.entries = { main: { workspace: path.join(fixture, "workspace") } };
  mkdirSync(path.join(fixture, "workspace"));
  cfg.plugins = {
    ...cfg.plugins,
    entries: {
      ...cfg.plugins?.entries,
      "memory-core": { config: { dreaming: { enabled: false } } },
      [values.channel]: { enabled: true },
    },
  };
  if (crabline) {
    const providerConfig = crabline.createGatewayConfig({}) as OpenClawConfig;
    cfg.channels = providerConfig.channels;
    cfg.messages = providerConfig.messages;
  } else {
    bus = await startQaBusServer({ state });
    cfg.channels = {
      "qa-channel": { enabled: true, baseUrl: bus.baseUrl, allowFrom: ["*"], pollTimeoutMs: 100 },
    };
  }
  const configPath = writeGatewayBenchConfig(fixture, cfg, {});
  const control = path.join(output, "mock-control.json");
  publish("channel-turns.json", messages);
  publish("trace-map.json", traces);
  launch(
    ["scripts/e2e/mock-openai-server.mjs"],
    {
      PATH: process.env.PATH,
      HOME: fixture,
      MOCK_PORT: String(mockPort),
      MOCK_RESPONSE_CONTROL: control,
      MOCK_REQUEST_LOG: path.join(output, "provider-requests.jsonl"),
    },
    "mock",
  );
  const mockReady = await waitForInitialProbe({
    port: mockPort,
    path: "/health",
    startAt: performance.now(),
    deadlineAt: performance.now() + 30000,
  });
  if (mockReady.status !== 200) {
    throw new Error("Mock provider not ready");
  }
  const observe = values.resources || values["cpu-profile"];
  const profilePath = path.join(output, "warm.cpuprofile");
  gateway = launch(
    buildGatewayBenchChildArgs(values.entry, port, [
      ...(observe
        ? [
            "--import",
            "./scripts/tsx.mjs",
            "--import",
            "./scripts/lib/gateway-bench-profile-preload.ts",
          ]
        : []),
      ...(values["cpu-profile"] ? ["--cpu-prof", `--cpu-prof-dir=${output}`] : []),
    ]),
    {
      ...createGatewayBenchEnv(fixture, configPath, { caseEnv: {} }),
      // Slack reads its Web API root from the environment.
      ...crabline?.createProviderReadinessEnv({}),
      ...(slackApi && {
        SLACK_API_URL: `http://127.0.0.1:${(slackApi.address() as { port: number }).port}/api/`,
      }),
      OPENAI_API_KEY: "synthetic-sqlmeasure-fixture",
      SQLMEASURE_OUT: output,
      NODE_OPTIONS: process.env.OPENCLAW_CHANNEL_BENCH_NODE_OPTIONS ?? "--enable-source-maps",
      NODE_DISABLE_COMPILE_CACHE: process.env.NODE_DISABLE_COMPILE_CACHE,
    },
    "gateway",
    observe,
  );
  const ready = await waitForInitialProbe({
    port,
    path: "/readyz",
    startAt: performance.now(),
    deadlineAt: performance.now() + 300000,
    isDone: () => gateway != null && (gateway.exitCode !== null || gateway.signalCode !== null),
  });
  evidence.ready = ready;
  if (ready.status !== 200) {
    throw new Error("Gateway not ready");
  }
  if (crabline) {
    if (gateway.exitCode !== null || gateway.signalCode !== null) {
      throw new Error("Gateway exited before the provider started");
    }
    // Telegram's first completed poll or Slack's first accepted auth.test.
    await Promise.race([
      providerReady.promise,
      once(gateway, "exit").then(() => {
        throw new Error("Gateway exited before the provider started");
      }),
      delay(60000, undefined, { ref: false }).then(() => {
        throw new Error(`${crablineChannel} provider did not start`);
      }),
    ]);
  }
  await delay(1000);
  let warmResources: GatewayResourceSnapshot | undefined;
  for (let i = 0; i <= 10; i++) {
    if (i === 1) {
      if (values.resources) {
        warmResources = await readGatewayResources(gateway);
      }
      if (values["cpu-profile"]) {
        await controlGatewayProfile(gateway, "cpu", "start", profilePath, { includeWorkers: true });
      }
    }
    const cpuBefore = observe
      ? await readGatewayCpuUsage(gateway, { includeWorkers: values.resources })
      : undefined;
    setPhase(i === 0 ? "02.first-turn" : `03.turn-${String(i).padStart(2, "0")}`);
    const turnId = createHash("sha256").update(phase).digest("hex").slice(0, 32);
    traces[turnId] = { phase, turnId };
    publish("trace-map.json", traces);
    const register = (id: string) => {
      messages[id] = { phase, turnId };
      publish("channel-turns.json", messages);
    };
    const reply = buildReply(i);
    const replyEvidence = {
      length: reply.length,
      sha256: createHash("sha256").update(reply).digest("hex"),
    };
    publish("mock-control.json", { text: reply, chunkDelayMs: 5 });
    const prompt = `Please give a short synthetic status report for measurement turn ${i}.`;
    if (crabline && crablineChannel) {
      const delivered = await runProviderTurn(
        crabline,
        crablineChannel,
        i,
        prompt,
        reply,
        port,
        register,
      );
      evidence.turns.push({
        phase,
        turnId,
        result: { status: "ok" },
        reply: replyEvidence,
        ...delivered,
      });
      save();
      await delay(1000);
      continue;
    }
    const messageId = `sqlmeasure-${i}`;
    register(messageId);
    const start = Date.now();
    const cursor = state.getSnapshot().cursor;
    const firstOutbound = state
      .waitForCursorAdvance(cursor, 180000, (snapshot) =>
        snapshot.messages.some(
          (message) => message.direction === "outbound" && message.replyToId === messageId,
        ),
      )
      .then(() => Date.now() - start);
    void firstOutbound.catch(() => {});
    state.addInboundMessage(
      {
        accountId: "default",
        conversation: { kind: "direct", id: "sqlmeasure-peer" },
        senderId: "sqlmeasure-user",
        senderName: "SQL measurement",
        text: prompt,
        timestamp: 1800000000000 + i,
      },
      messageId,
    );
    const inboundCursor = state.getSnapshot().cursor;
    await state.waitFor({
      kind: "message-text",
      direction: "outbound",
      textIncludes: reply,
      timeoutMs: 180000,
    });
    const finalOutboundMs = Date.now() - start;
    const firstOutboundMs = await firstOutbound;
    // The poll acknowledgement follows dispatch, preview cleanup and receipt settlement.
    const deadline = Date.now() + 180000;
    while (state.getAcknowledgedPollCursor("default") < inboundCursor) {
      if (gateway.exitCode !== null || gateway.signalCode !== null) {
        throw new Error("Gateway exited during turn");
      }
      if (Date.now() >= deadline) {
        throw new Error("Inbound dispatch did not settle");
      }
      await delay(50);
    }
    const settledMs = Date.now() - start;
    const cpu = cpuBefore
      ? measureGatewayCpuUsage(
          cpuBefore,
          await readGatewayCpuUsage(gateway, { includeWorkers: values.resources }),
        )
      : undefined;
    const result = state
      .getSnapshot()
      .messages.find(
        (message) =>
          message.direction === "outbound" &&
          message.replyToId === messageId &&
          message.text === reply &&
          !message.deleted &&
          !message.isError,
      );
    if (!result) {
      throw new Error("No durable outbound reply after dispatch settled");
    }
    evidence.turns.push({
      phase,
      key: "qa-channel:sqlmeasure-peer",
      turnId,
      messageId,
      firstOutboundMs,
      finalOutboundMs,
      settledMs,
      outboundMessages: state
        .getSnapshot()
        .messages.filter(
          (message) => message.direction === "outbound" && message.replyToId === messageId,
        ).length,
      ...(cpu ? { cpu } : {}),
      result: { status: "ok" },
      outboundId: result.id,
      reply: replyEvidence,
    });
    save();
    if (i === 10) {
      if (values["cpu-profile"]) {
        await controlGatewayProfile(gateway, "cpu", "stop", profilePath);
      }
      if (warmResources) {
        evidence.resources = { before: warmResources, after: await readGatewayResources(gateway) };
      }
    }
    await delay(1000);
  }
  setPhase("08.shutdown");
  const closed = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    gateway?.once("close", (code, signal) => resolve([code, signal]));
  });
  gateway.kill("SIGTERM");
  evidence.shutdown = await Promise.race<[number | null, NodeJS.Signals | null]>([
    closed,
    delay(120000, undefined, { ref: false }).then(() => {
      throw new Error("shutdown timeout");
    }),
  ]);
  evidence.bus = crabline
    ? { providerApi: path.join(output, "provider-api.jsonl") }
    : state.getSnapshot();
  evidence.ok =
    evidence.turns.length === 11 &&
    evidence.turns.every((turn) => !turn.provider?.rejectedSends) &&
    evidence.shutdown[0] === 0;
  setPhase("done");
  console.log("COMPLETE", output, "ok=" + evidence.ok);
  if (!evidence.ok) {
    process.exitCode = 1;
  }
} catch (error) {
  evidence.error = String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  await cleanup();
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
}

/** Measures custody and progress through the real wrapper, harness and subscription handler. */
async function measureToolInvocations() {
  const integerOption = (
    name:
      | "tool-argument-bytes"
      | "tool-progress-events"
      | "tool-calls"
      | "tool-samples"
      | "tool-interval-ms",
    minimum = 1,
  ) => {
    const value = Number(values[name]);
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new Error(`--${name} must be an integer >= ${minimum}`);
    }
    return value;
  };
  const argumentBytes = integerOption("tool-argument-bytes");
  const progressEvents = integerOption("tool-progress-events", 0);
  const calls = integerOption("tool-calls");
  const sampleCount = integerOption("tool-samples");
  const intervalMs = integerOption("tool-interval-ms");
  const gcLog = values["tool-gc-log"];
  if (!globalThis.gc) {
    throw new Error("--tool-invocations requires node --expose-gc");
  }
  if (!gcLog || !process.execArgv.includes("--trace-gc-nvp")) {
    throw new Error("--tool-invocations requires --trace-gc-nvp and --tool-gc-log <stdout-log>");
  }
  // Source imports and fixture construction are deliberately outside all sampling windows.
  const [
    { Session },
    { Type },
    { isRecord },
    { wrapToolWithBeforeToolCallHook },
    { finalizeToolTerminalPresentation },
    { peekAdjustedParamsForToolCall },
    { createAgentHarnessToolExecutionBoundaryRegistry },
    { runAgentHarnessToolInvocation },
    { handleToolExecutionUpdate },
    { EmbeddedAgentSubscribeState },
    { createToolTerminalObserver },
    { setToolTerminalPresentation },
    { startGatewayBenchDiagnostics },
    { GATEWAY_GC_TRACE_MARKER, readGatewayGcTrace },
  ] = await Promise.all([
    import("node:inspector/promises"),
    import("typebox"),
    import("@openclaw/normalization-core/record-coerce"),
    import("../src/agents/agent-tools.before-tool-call.wrapper.js"),
    import("../src/agents/agent-tools.before-tool-call.diagnostics.js"),
    import("../src/agents/agent-tools.before-tool-call.state.js"),
    import("../src/agents/harness/tool-execution.js"),
    import("../src/agents/harness/tool-invocation.js"),
    import("../src/agents/embedded-agent-subscribe.handlers.tools.progress.js"),
    import("../src/agents/embedded-agent-subscribe.run-state.js"),
    import("../src/agents/tool-terminal-outcome.js"),
    import("../src/agents/tool-terminal-presentation.js"),
    import("./lib/gateway-bench-diagnostics.ts"),
    import("./lib/gateway-bench-profile.ts"),
  ]);
  const toolOutput = mkdtempSync(path.join(tmpdir(), "tool-invocations-"));
  const runId = `tool-invocation-benchmark-${process.pid}`;
  const boundaries = createAgentHarnessToolExecutionBoundaryRegistry();
  const observeTerminal = createToolTerminalObserver(runId);
  const toolFixture = {
    benchmarkArgument: true,
    mutation: { executor: false, middleware: false },
    payload: {
      rows: Array.from({ length: Math.ceil(argumentBytes / 1024) }, (_, index) => ({
        index,
        text: "x".repeat(1024),
      })),
    },
  };
  const fixtureJson = JSON.stringify(toolFixture);
  const mutationOf = (args: unknown) => {
    if (!isRecord(args) || !isRecord(args.mutation)) {
      throw new Error("Synthetic tool received malformed nested arguments");
    }
    return args.mutation;
  };
  let updates = 0;
  let presentations = 0;
  let nextCall = 0;
  const noop = () => {};
  const ctx: ToolHandlerContext = {
    params: {
      runId,
      onAgentEvent(event) {
        if (event.stream === "item" && event.data.phase === "update") {
          updates += 1;
        }
      },
    },
    state: new EmbeddedAgentSubscribeState({}),
    log: { debug: noop, info: noop, warn: console.warn },
    flushBlockReplyBuffer: noop,
    shouldEmitToolResult: () => false,
    shouldEmitToolOutput: () => false,
    emitToolSummary: noop,
    emitToolOutput: noop,
    trimMessagingToolSent: noop,
  };
  const source: AnyAgentTool = {
    name: "synthetic_stream",
    label: "Synthetic stream",
    description: "Emit synthetic progress for allocation measurement.",
    parameters: Type.Object({}, { additionalProperties: true }),
    async execute(toolCallId, args) {
      // Real tools may mutate their inputs; snapshots must neither alias nor freeze them.
      mutationOf(args).executor = true;
      for (let index = 0; index < progressEvents; index++) {
        handleToolExecutionUpdate(ctx, {
          type: "tool_execution_update",
          toolName: source.name,
          toolCallId,
          args,
          partialResult: { content: [{ type: "text", text: `progress ${index}` }], details: {} },
        });
      }
      return { content: [{ type: "text", text: "synthetic tool completed" }], details: {} };
    },
  };
  setToolTerminalPresentation(source, (args) => {
    const mutation = mutationOf(args);
    if (mutation.executor !== true || mutation.middleware !== false) {
      throw new Error("Terminal formatter lost its post-execution argument snapshot");
    }
    return { text: "synthetic terminal verified" };
  });
  const tool = wrapToolWithBeforeToolCallHook(
    source,
    {
      runId,
      onToolOutcome: (outcome) => {
        if (
          outcome.presentationOnly &&
          outcome.terminalPresentation === "synthetic terminal verified"
        ) {
          presentations += 1;
        }
      },
    },
    { emitDiagnostics: false },
  );
  const invoke = async () => {
    const toolCallId = `synthetic-call-${nextCall++}`;
    const args: unknown = JSON.parse(fixtureJson);
    const previousUpdates = updates;
    const previousPresentations = presentations;
    await runAgentHarnessToolInvocation({
      tool,
      call: { toolCallId, toolName: source.name, arguments: args },
      runId,
      signal: new AbortController().signal,
      boundaries,
      retainExecutionSnapshot: true,
      applyMiddleware: async (event) => {
        mutationOf(event.args).middleware = true;
        return event.result;
      },
      onResult: (execution) => {
        const mutation = mutationOf(execution.executedArguments);
        if (mutation.executor !== false || mutation.middleware !== false) {
          throw new Error("Executed argument snapshot aliases mutable tool or middleware input");
        }
        observeTerminal({
          toolCallId,
          toolName: source.name,
          arguments: execution.executedArguments,
          result: execution.result,
          outcome: "success",
          executionStarted: execution.boundary.executionStarted,
        });
        finalizeToolTerminalPresentation({
          toolCallId,
          runId,
          result: execution.result,
          isError: execution.isError,
        });
      },
      onError: ({ error }) => {
        throw error;
      },
    });
    const snapshot = boundaries.consume(toolCallId);
    const mutation = mutationOf(args);
    if (
      !snapshot?.executionStarted ||
      peekAdjustedParamsForToolCall(toolCallId, runId) !== undefined ||
      mutation.executor !== true ||
      mutation.middleware !== false ||
      updates - previousUpdates !== progressEvents ||
      presentations - previousPresentations !== 1
    ) {
      throw new Error("Tool invocation, progress, presentation, or cleanup invariant failed");
    }
  };
  const inspector = new Session();
  inspector.connect();
  const markGc = (samplePhase: string, profilePath?: string) => {
    writeSync(
      1,
      `${GATEWAY_GC_TRACE_MARKER}${JSON.stringify({ phase: samplePhase, pid: process.pid, profilePath })}\n`,
    );
  };
  const originalClone = globalThis.structuredClone;
  let clones = 0;
  let argumentClones = 0;
  const percentile = (numbers: number[], fraction: number) =>
    numbers.toSorted((a, b) => a - b)[Math.ceil(numbers.length * fraction) - 1]!;
  const sample = async (samplePhase: string, count: number, cadenceMs: number) => {
    const profilePath = path.join(toolOutput, `${samplePhase}.heapprofile`);
    globalThis.gc?.();
    await delay(0);
    clones = 0;
    argumentClones = 0;
    const startFile = values["tool-start-file"];
    if (samplePhase === "warm-0" && startFile) {
      // Release both prepared processes with the same future capture timestamp.
      writeFileSync(`${startFile}.${process.pid}.ready`, "ready");
      const deadline = Date.now() + 120000;
      while (!existsSync(startFile)) {
        if (Date.now() > deadline) {
          throw new Error("Timed out waiting for the paired measurement barrier");
        }
        await delay(10);
      }
      const startAt = Number(readFileSync(startFile, "utf8"));
      if (!Number.isSafeInteger(startAt) || startAt < Date.now()) {
        throw new Error("Paired measurement barrier needs a future Unix timestamp in milliseconds");
      }
      await delay(startAt - Date.now());
    }
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    const durations: number[] = [];
    let overCadenceCalls = 0;
    let lateStarts = 0;
    let maxStartLatenessMs = 0;
    globalThis.structuredClone = (value, options) => {
      clones += 1;
      if (isRecord(value) && value.benchmarkArgument === true) {
        argumentClones += 1;
      }
      return originalClone(value, options);
    };
    const stopDiagnostics = startGatewayBenchDiagnostics();
    markGc("heap-start", profilePath);
    const windowStart = performance.now();
    let diagnostics: ReturnType<typeof stopDiagnostics>;
    try {
      for (let index = 0; index < count; index++) {
        const scheduledAt = windowStart + index * cadenceMs;
        if (cadenceMs) {
          await delay(Math.max(0, scheduledAt - performance.now()));
        }
        const started = performance.now();
        const latenessMs = Math.max(0, started - scheduledAt);
        maxStartLatenessMs = Math.max(maxStartLatenessMs, latenessMs);
        if (cadenceMs && latenessMs >= cadenceMs) {
          lateStarts += 1;
        }
        await invoke();
        const durationMs = performance.now() - started;
        durations.push(durationMs);
        if (cadenceMs && durationMs > cadenceMs) {
          overCadenceCalls += 1;
        }
      }
      // Keep both sides at the same offered rate and drain observer callbacks naturally.
      await delay(Math.max(0, windowStart + count * cadenceMs - performance.now()));
      await immediate();
    } finally {
      diagnostics = stopDiagnostics();
      markGc("heap-stop", profilePath);
      globalThis.structuredClone = originalClone;
    }
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const trace = readGatewayGcTrace(gcLog, profilePath);
    writeFileSync(profilePath, JSON.stringify(profile));
    const nodes = [profile.head];
    let allocatedBytes = 0;
    while (nodes.length) {
      const node = nodes.pop();
      if (node) {
        allocatedBytes += node.selfSize;
        nodes.push(...node.children);
      }
    }
    return {
      phase: samplePhase,
      calls: count,
      clonesPerTool: clones / count,
      argumentClonesPerTool: argumentClones / count,
      sampledAllocatedBytesPerTool: allocatedBytes / count,
      promotedBytesPerTool: trace.promotedBytes / count,
      gcTrace: trace,
      diagnostics,
      gcSecondsPerMinute: {
        minor: ((diagnostics.gc.minorDurationMs?.total ?? 0) / diagnostics.durationMs) * 60,
        major: ((diagnostics.gc.majorDurationMs?.total ?? 0) / diagnostics.durationMs) * 60,
      },
      pacing: {
        intervalMs: cadenceMs,
        targetDurationMs: count * cadenceMs,
        overCadenceCalls,
        startsAtLeastOneIntervalLate: lateStarts,
        maxStartLatenessMs,
        skippedCalls: 0,
      },
      latencyMs: {
        median: percentile(durations, 0.5),
        p95: percentile(durations, 0.95),
        p99: percentile(durations, 0.99),
        mean: durations.reduce((sum, value) => sum + value, 0) / count,
      },
      profilePath,
    };
  };
  try {
    // Identify the main isolate once; this forced collection is outside every capture.
    markGc("identify-start");
    globalThis.gc();
    markGc("identify-stop");
    const cold = await sample("cold", 1, 0);
    for (let index = 0; index < 3; index++) {
      await invoke();
    }
    const samples = [];
    for (let index = 0; index < sampleCount; index++) {
      samples.push(await sample(`warm-${index}`, calls, intervalMs));
    }
    const result = {
      scenario: "tool-invocations",
      output: toolOutput,
      argumentBytes: Buffer.byteLength(fixtureJson),
      progressEvents,
      samplingIntervalBytes: 32768,
      includesCollectedObjects: true,
      note: "Main-isolate owner workload; imports, forced GC and profiler teardown excluded from warm captures. Tool latency excludes pacing and includes allocation sampling and clone counting. No enabled bundled plugins, Gateway RPC or provider work.",
      cold,
      samples,
      summary: {
        clonesPerTool: percentile(
          samples.map((value) => value.clonesPerTool),
          0.5,
        ),
        argumentClonesPerTool: percentile(
          samples.map((value) => value.argumentClonesPerTool),
          0.5,
        ),
        allocatedBytesPerTool: {
          median: percentile(
            samples.map((value) => value.sampledAllocatedBytesPerTool),
            0.5,
          ),
          p95: percentile(
            samples.map((value) => value.sampledAllocatedBytesPerTool),
            0.95,
          ),
        },
        latencyMs: {
          median: percentile(
            samples.map((value) => value.latencyMs.median),
            0.5,
          ),
          p95: percentile(
            samples.map((value) => value.latencyMs.p95),
            0.95,
          ),
          medianSampleP99: percentile(
            samples.map((value) => value.latencyMs.p99),
            0.5,
          ),
        },
      },
    };
    writeFileSync(path.join(toolOutput, "evidence.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    globalThis.structuredClone = originalClone;
    inspector.disconnect();
  }
}
