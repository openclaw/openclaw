/**
 * Ephemeral-Gateway proof that Slack conversation budgets stay isolated per channel.
 * Run: node --import ./scripts/tsx.mjs scripts/proof-117734-slack-gateway-isolation.ts
 *
 * Real: a spawned OpenClaw Gateway process with its own state dir, config and
 * loopback port; its real Slack plugin HTTP route; Bolt's real HTTPReceiver
 * signature verification; the real Slack event and message handlers; the real
 * inbound turn dispatch; and the real process-wide channel bot-pair loop guard.
 * Edge stubs, both on one loopback HTTP server: the Slack Web API, reached
 * through the production SLACK_API_URL seam, and an OpenAI-completions model
 * endpoint. Nothing between HTTP ingress and those two edges is replaced.
 *
 * Signal: the guard drops a suppressed event before any agent dispatch, so a
 * model request carrying an event's marker is a positive admission observation
 * and its absence at the settle deadline is a suppression observation. The
 * deadline is validated against the slowest admission actually measured in the
 * same run, so a broken pipeline cannot read as suppression.
 *
 * Scenarios, each on a fresh Gateway so the guard starts empty: pair budget
 * only (new setting absent); conversation burst budget enabled; cross-thread
 * upgrade compatibility (setting absent, so one channel's pair budget must
 * still span its threads exactly as the shipped release does); and cross-thread
 * opt-in scope (setting present, so each thread carries its own pair budget).
 * The last two differ only by the presence of the shared default, which is the
 * upgrade boundary an existing installation crosses.
 * No credentials, no public requests, no live state, no Vitest, no mocks.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";

const SIGNING_SECRET = "proof-117734-signing-secret";
const MODEL_KEY_ENV = "PROOF_117734_MODEL_KEY";
const WEBHOOK_PATH = "/slack/events";
const RECEIVER_BOT_ID = "BSELF";
const RECEIVER_BOT_USER = "USELF";
const PEER_BOT_ID = "BPEER";
const OTHER_BOT_ID = "BOTHER";
const SETTLE_MS = 20_000;
const GATEWAY_READY_TIMEOUT_MS = 120_000;

const heartbeat = new Worker(
  'setInterval(() => process.stdout.write("proof-117734-slack: gateway proof still active\\n"), 30000)',
  { eval: true },
);

let assertions = 0;
function check(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
  assertions++;
  console.log(`ok ${assertions}: ${message}`);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(res: ServerResponse, payload: unknown): void {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

type StubEdges = {
  url: string;
  slackCalls: Array<{ method: string; body: string }>;
  modelRequests: string[];
  close: () => Promise<void>;
};

function slackApiPayload(method: string, body: string): unknown {
  switch (method) {
    case "auth.test":
      return {
        ok: true,
        user_id: RECEIVER_BOT_USER,
        bot_id: RECEIVER_BOT_ID,
        app_id: "ATEST",
        team_id: "TTEST",
        url: "https://proof.invalid/",
        team: "Proof",
        user: "openclaw",
        is_enterprise_install: false,
      };
    case "team.info":
      return { ok: true, team: { id: "TTEST", name: "Proof", domain: "proof" } };
    case "conversations.info":
      return {
        ok: true,
        channel: {
          id: new URLSearchParams(body).get("channel") ?? "C_UNKNOWN",
          name: "proof-channel",
          is_channel: true,
          is_private: false,
          is_im: false,
        },
      };
    case "conversations.replies":
    case "conversations.history":
      return { ok: true, messages: [], has_more: false };
    case "conversations.members":
      return { ok: true, members: [] };
    case "users.info":
      return {
        ok: true,
        user: {
          id: new URLSearchParams(body).get("user") ?? RECEIVER_BOT_USER,
          name: "proof-user",
          team_id: "TTEST",
          profile: { team: "TTEST", display_name: "Proof" },
        },
      };
    case "bots.info":
      return { ok: true, bot: { id: PEER_BOT_ID, name: "peer-bot", app_id: "APEER" } };
    case "chat.postMessage":
    case "chat.update":
      return {
        ok: true,
        channel: new URLSearchParams(body).get("channel") ?? "C_UNKNOWN",
        ts: `${Math.floor(Date.now() / 1000)}.000100`,
        message: { text: "proof reply", ts: `${Math.floor(Date.now() / 1000)}.000100` },
      };
    default:
      return { ok: true };
  }
}

function modelChunk(content: string | null, finish: string | null): string {
  return JSON.stringify({
    id: "chatcmpl-proof-117734",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "proof-model",
    choices: [
      {
        index: 0,
        delta: content === null ? {} : { role: "assistant", content },
        finish_reason: finish,
      },
    ],
  });
}

async function startStubEdges(): Promise<StubEdges> {
  const slackCalls: Array<{ method: string; body: string }> = [];
  const modelRequests: string[] = [];
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const body = await readBody(req);
      if (url.pathname.startsWith("/api/")) {
        const method = url.pathname.slice("/api/".length);
        slackCalls.push({ method, body });
        json(res, slackApiPayload(method, body));
        return;
      }
      if (url.pathname.startsWith("/v1/")) {
        if (url.pathname === "/v1/chat/completions") {
          modelRequests.push(body);
          if (/"stream"\s*:\s*true/u.test(body)) {
            res.setHeader("content-type", "text/event-stream");
            res.write(`data: ${modelChunk("proof reply", null)}\n\n`);
            res.write(`data: ${modelChunk(null, "stop")}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }
          json(res, {
            id: "chatcmpl-proof-117734",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "proof-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "proof reply" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          });
          return;
        }
        json(res, { object: "list", data: [] });
        return;
      }
      res.statusCode = 404;
      json(res, { ok: false, error: "unexpected_proof_request" });
    })().catch((err: unknown) => {
      res.statusCode = 500;
      res.end(String(err));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    slackCalls,
    modelRequests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => {
    probe.listen(0, "127.0.0.1", resolve);
  });
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    probe.close(() => resolve());
  });
  return port;
}

type ScenarioConfigParams = {
  gatewayPort: number;
  stubUrl: string;
  workspaceDir: string;
  maxEventsPerWindow: number;
  maxConversationBotEvents?: number;
};

function buildConfig(params: ScenarioConfigParams): Record<string, unknown> {
  const modelRef = "openai/proof-model";
  return {
    gateway: {
      port: params.gatewayPort,
      bind: "loopback",
      auth: { mode: "token", token: "proof-117734-gateway-token" },
      controlUi: { enabled: false },
    },
    messages: { inbound: { debounceMs: 0 } },
    channels: {
      defaults: {
        botLoopProtection: {
          enabled: true,
          maxEventsPerWindow: params.maxEventsPerWindow,
          windowSeconds: 60,
          cooldownSeconds: 60,
          ...(params.maxConversationBotEvents !== undefined
            ? { maxConversationBotEvents: params.maxConversationBotEvents }
            : {}),
        },
      },
      slack: {
        enabled: true,
        mode: "http",
        botToken: "xoxb-proof-117734",
        signingSecret: SIGNING_SECRET,
        webhookPath: WEBHOOK_PATH,
        allowBots: true,
        groupPolicy: "open",
        requireMention: false,
        // Peer bots reach a room turn through the per-channel allowlist. Both
        // channels carry the identical entry so only the channel id differs.
        channels: {
          C_FIRST: { requireMention: false, users: [PEER_BOT_ID, OTHER_BOT_ID] },
          C_SECOND: { requireMention: false, users: [PEER_BOT_ID, OTHER_BOT_ID] },
        },
      },
    },
    models: {
      mode: "merge",
      providers: {
        openai: {
          api: "openai-completions",
          apiKey: { source: "env", provider: "default", id: MODEL_KEY_ENV },
          baseUrl: `${params.stubUrl}/v1`,
          agentRuntime: { id: "openclaw" },
          timeoutSeconds: 30,
          models: [
            {
              id: "proof-model",
              name: "proof-model",
              api: "openai-completions",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              contextTokens: 32000,
              maxTokens: 256,
            },
          ],
        },
      },
    },
    agents: {
      defaults: {
        model: { primary: modelRef, fallbacks: [] },
        models: { [modelRef]: { agentRuntime: { id: "openclaw" } } },
        workspace: params.workspaceDir,
        skipBootstrap: true,
        timeoutSeconds: 30,
        contextTokens: 32000,
      },
    },
    skills: { allowBundled: [] },
  };
}

type GatewayProcess = ChildProcessByStdio<null, Readable, Readable>;

type GatewayHandle = {
  child: GatewayProcess;
  port: number;
  logs: () => string;
  stop: () => Promise<void>;
};

async function startGateway(params: {
  cwd: string;
  homeDir: string;
  stateDir: string;
  configPath: string;
  stubUrl: string;
  port: number;
}): Promise<GatewayHandle> {
  const chunks: string[] = [];
  const child = spawn(
    process.execPath,
    [
      "dist/index.js",
      "gateway",
      "--port",
      String(params.port),
      "--bind",
      "loopback",
      "--allow-unconfigured",
      // Verbose logging keeps the admission reason readable when a scenario fails.
      "--verbose",
    ],
    {
      cwd: params.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: params.homeDir,
        OPENCLAW_STATE_DIR: params.stateDir,
        OPENCLAW_CONFIG_PATH: params.configPath,
        SLACK_API_URL: `${params.stubUrl}/api/`,
        [MODEL_KEY_ENV]: "proof-117734-model-key",
        OPENCLAW_DISABLE_UPDATE_CHECK: "1",
      },
    },
  ) as GatewayProcess;
  child.stdout.on("data", (chunk) => chunks.push(String(chunk)));
  child.stderr.on("data", (chunk) => chunks.push(String(chunk)));
  const logs = () => chunks.join("");
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    const exited = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
    });
    child.kill("SIGTERM");
    await Promise.race([exited, delay(10_000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await Promise.race([exited, delay(5_000)]);
    }
  };

  const deadline = Date.now() + GATEWAY_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      await stop();
      throw new Error(`gateway exited before readiness\n${logs()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${params.port}/readyz`);
      const readiness = (await response.json()) as { ready?: unknown };
      if (response.ok && readiness.ready === true) {
        return { child, port: params.port, logs, stop };
      }
    } catch {
      // keep polling
    }
    await delay(250);
  }
  await stop();
  throw new Error(`gateway readiness timed out\n${logs()}`);
}

type SlackEventParams = {
  channel: string;
  ts: string;
  threadTs: string;
  botId: string;
  marker: string;
};

function slackEnvelope(params: SlackEventParams): string {
  return JSON.stringify({
    token: "proof-117734",
    team_id: "TTEST",
    api_app_id: "ATEST",
    type: "event_callback",
    event_id: `Ev${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`,
    event_time: Math.floor(Number(params.ts)),
    authorizations: [
      {
        enterprise_id: null,
        team_id: "TTEST",
        user_id: RECEIVER_BOT_USER,
        is_bot: true,
        is_enterprise_install: false,
      },
    ],
    event: {
      type: "message",
      subtype: "bot_message",
      channel: params.channel,
      channel_type: "channel",
      ts: params.ts,
      event_ts: params.ts,
      thread_ts: params.threadTs,
      text: `proof marker ${params.marker}`,
      bot_id: params.botId,
      username: "peer-bot",
      team: "TTEST",
    },
  });
}

async function postSlackEvent(params: {
  gatewayPort: number;
  body: string;
  signature?: string;
}): Promise<Response> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature =
    params.signature ??
    `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${timestamp}:${params.body}`).digest("hex")}`;
  return await fetch(`http://127.0.0.1:${params.gatewayPort}${WEBHOOK_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body: params.body,
  });
}

type Admission = { admitted: boolean; latencyMs: number };

async function driveEvent(params: {
  gateway: GatewayHandle;
  edges: StubEdges;
  event: SlackEventParams;
}): Promise<Admission> {
  const startedAt = Date.now();
  const response = await postSlackEvent({
    gatewayPort: params.gateway.port,
    body: slackEnvelope(params.event),
  });
  if (response.status !== 200) {
    throw new Error(`slack webhook rejected a signed event: HTTP ${response.status}`);
  }
  const deadline = startedAt + SETTLE_MS;
  while (Date.now() < deadline) {
    if (params.edges.modelRequests.some((body) => body.includes(params.event.marker))) {
      return { admitted: true, latencyMs: Date.now() - startedAt };
    }
    await delay(100);
  }
  return { admitted: false, latencyMs: Date.now() - startedAt };
}

type ScenarioResult = {
  label: string;
  observations: Array<{ marker: string; channel: string; admitted: boolean; latencyMs: number }>;
  slowestAdmissionMs: number;
};

async function runScenario(params: {
  label: string;
  cwd: string;
  rootDir: string;
  maxEventsPerWindow: number;
  maxConversationBotEvents?: number;
  events: Array<SlackEventParams & { expectAdmitted: boolean }>;
  verifySignatureRejection?: boolean;
}): Promise<ScenarioResult> {
  const edges = await startStubEdges();
  const homeDir = path.join(params.rootDir, params.label, "home");
  const stateDir = path.join(params.rootDir, params.label, "state");
  const workspaceDir = path.join(params.rootDir, params.label, "workspace");
  const configPath = path.join(homeDir, ".openclaw", "openclaw.json");
  await mkdir(path.dirname(configPath), { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  const gatewayPort = await freePort();
  await writeFile(
    configPath,
    `${JSON.stringify(
      buildConfig({
        gatewayPort,
        stubUrl: edges.url,
        workspaceDir,
        maxEventsPerWindow: params.maxEventsPerWindow,
        ...(params.maxConversationBotEvents !== undefined
          ? { maxConversationBotEvents: params.maxConversationBotEvents }
          : {}),
      }),
      null,
      2,
    )}\n`,
  );

  const gateway = await startGateway({
    cwd: params.cwd,
    homeDir,
    stateDir,
    configPath,
    stubUrl: edges.url,
    port: gatewayPort,
  });
  try {
    check(
      edges.slackCalls.some((call) => call.method === "auth.test"),
      `${params.label}: real Slack transport started against the loopback Web API`,
    );
    if (params.verifySignatureRejection) {
      const rejected = await postSlackEvent({
        gatewayPort,
        body: slackEnvelope({
          channel: "C_SIGCHECK",
          ts: "1700000000.000001",
          threadTs: "1700000000.000001",
          botId: PEER_BOT_ID,
          marker: "proof-signature-check",
        }),
        signature: "v0=deadbeef",
      });
      check(
        rejected.status === 401,
        `${params.label}: Bolt rejected a bad-signature event at the real HTTP boundary (401)`,
      );
      check(
        !edges.modelRequests.some((body) => body.includes("proof-signature-check")),
        `${params.label}: the rejected event never reached an agent turn`,
      );
    }

    const observations: ScenarioResult["observations"] = [];
    let slowestAdmissionMs = 0;
    for (const event of params.events) {
      const admission = await driveEvent({ gateway, edges, event });
      observations.push({
        marker: event.marker,
        channel: event.channel,
        admitted: admission.admitted,
        latencyMs: admission.latencyMs,
      });
      if (admission.admitted) {
        slowestAdmissionMs = Math.max(slowestAdmissionMs, admission.latencyMs);
      }
      check(
        admission.admitted === event.expectAdmitted,
        `${params.label}: ${event.channel} ${event.marker} ${
          event.expectAdmitted ? "admitted" : "suppressed"
        } (observed ${admission.admitted ? "admitted" : "suppressed"} in ${admission.latencyMs}ms)`,
      );
    }
    check(
      observations.some((observation) => observation.admitted),
      `${params.label}: at least one admission proved the whole ingress-to-model path live`,
    );
    check(
      slowestAdmissionMs * 4 < SETTLE_MS,
      `${params.label}: slowest measured admission ${slowestAdmissionMs}ms leaves the ${SETTLE_MS}ms ` +
        "suppression deadline unambiguous",
    );
    return { label: params.label, observations, slowestAdmissionMs };
  } catch (err) {
    // A proof that fails silently is as useless as the bug it chases: name the
    // Slack Web API calls, model calls and Gateway log tail that were observed.
    console.error(`--- ${params.label} diagnostics ---`);
    console.error(`slack api calls: ${edges.slackCalls.map((call) => call.method).join(", ")}`);
    console.error(`model requests: ${edges.modelRequests.length}`);
    console.error(gateway.logs().split("\n").slice(-160).join("\n"));
    throw err;
  } finally {
    await gateway.stop();
    await edges.close();
  }
}

const rootDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-proof-117734-slack-"));
const cwd = process.cwd();
try {
  // Slack message timestamps drive the guard clock, so a fixed recent base keeps
  // every event inside the 60s pair window while staying deterministic.
  const base = Math.floor(Date.now() / 1000) - 45;
  const ts = (offset: number) => `${base + offset}.000100`;
  const thread = ts(0);
  // A second thread in the SAME channel. Whether these two threads share one
  // pair budget is exactly the upgrade question the compatibility scenarios ask.
  const otherThread = ts(3);

  const pairOnly = await runScenario({
    label: "pair-budget-only",
    cwd,
    rootDir,
    maxEventsPerWindow: 2,
    verifySignatureRejection: true,
    events: [
      {
        channel: "C_FIRST",
        ts: ts(1),
        threadTs: thread,
        botId: PEER_BOT_ID,
        marker: "pa1",
        expectAdmitted: true,
      },
      {
        channel: "C_FIRST",
        ts: ts(6),
        threadTs: thread,
        botId: PEER_BOT_ID,
        marker: "pa2",
        expectAdmitted: true,
      },
      {
        channel: "C_FIRST",
        ts: ts(11),
        threadTs: thread,
        botId: PEER_BOT_ID,
        marker: "pa3",
        expectAdmitted: false,
      },
      // Same account, same peer bot, same receiving bot, same thread timestamp:
      // only the channel differs, so this must start with a fresh pair budget.
      {
        channel: "C_SECOND",
        ts: ts(16),
        threadTs: thread,
        botId: PEER_BOT_ID,
        marker: "pa4",
        expectAdmitted: true,
      },
    ],
  });

  const burstEnabled = await runScenario({
    label: "conversation-burst-budget",
    cwd,
    rootDir,
    maxEventsPerWindow: 100,
    maxConversationBotEvents: 3,
    events: [
      {
        channel: "C_FIRST",
        ts: ts(1),
        threadTs: thread,
        botId: PEER_BOT_ID,
        marker: "cb1",
        expectAdmitted: true,
      },
      {
        channel: "C_FIRST",
        ts: ts(6),
        threadTs: thread,
        botId: OTHER_BOT_ID,
        marker: "cb2",
        expectAdmitted: true,
      },
      {
        channel: "C_FIRST",
        ts: ts(11),
        threadTs: thread,
        botId: PEER_BOT_ID,
        marker: "cb3",
        expectAdmitted: true,
      },
      {
        channel: "C_FIRST",
        ts: ts(16),
        threadTs: thread,
        botId: OTHER_BOT_ID,
        marker: "cb4",
        expectAdmitted: false,
      },
      // The burst cooldown belongs to C_FIRST only.
      {
        channel: "C_SECOND",
        ts: ts(21),
        threadTs: thread,
        botId: PEER_BOT_ID,
        marker: "cb5",
        expectAdmitted: true,
      },
      {
        channel: "C_SECOND",
        ts: ts(26),
        threadTs: thread,
        botId: OTHER_BOT_ID,
        marker: "cb6",
        expectAdmitted: true,
      },
    ],
  });

  // Upgrade compatibility: no burst setting anywhere, so this Gateway behaves
  // like the shipped release. Two unique messages in one thread plus a third in
  // another thread of the same channel must exhaust ONE pair budget of two.
  const crossThreadUpgrade = await runScenario({
    label: "cross-thread-upgrade-compatibility",
    cwd,
    rootDir,
    maxEventsPerWindow: 2,
    events: [
      {
        channel: "C_FIRST",
        ts: ts(1),
        threadTs: thread,
        botId: PEER_BOT_ID,
        marker: "xu1",
        expectAdmitted: true,
      },
      {
        channel: "C_FIRST",
        ts: ts(6),
        threadTs: thread,
        botId: PEER_BOT_ID,
        marker: "xu2",
        expectAdmitted: true,
      },
      // Different thread, same channel: the shipped release suppresses this
      // third message, so an installation that never opted in must too.
      {
        channel: "C_FIRST",
        ts: ts(11),
        threadTs: otherThread,
        botId: PEER_BOT_ID,
        marker: "xu3",
        expectAdmitted: false,
      },
    ],
  });

  // The same traffic with the shared default present. This is the opt-in the
  // operator asked for: each thread now carries its own pair budget, and that
  // budget is still enforced inside the thread.
  const crossThreadOptIn = await runScenario({
    label: "cross-thread-opt-in-scope",
    cwd,
    rootDir,
    maxEventsPerWindow: 2,
    maxConversationBotEvents: 50,
    events: [
      {
        channel: "C_FIRST",
        ts: ts(1),
        threadTs: thread,
        botId: PEER_BOT_ID,
        marker: "xo1",
        expectAdmitted: true,
      },
      {
        channel: "C_FIRST",
        ts: ts(6),
        threadTs: thread,
        botId: PEER_BOT_ID,
        marker: "xo2",
        expectAdmitted: true,
      },
      {
        channel: "C_FIRST",
        ts: ts(11),
        threadTs: otherThread,
        botId: PEER_BOT_ID,
        marker: "xo3",
        expectAdmitted: true,
      },
      // The opted-in thread budget is real, not merely wider.
      {
        channel: "C_FIRST",
        ts: ts(16),
        threadTs: thread,
        botId: PEER_BOT_ID,
        marker: "xo4",
        expectAdmitted: false,
      },
    ],
  });

  for (const scenario of [pairOnly, burstEnabled, crossThreadUpgrade, crossThreadOptIn]) {
    console.log(
      `${scenario.label}: ${scenario.observations
        .map((o) => `${o.channel}/${o.marker}=${o.admitted ? "admitted" : "suppressed"}`)
        .join(" ")}`,
    );
  }
  console.log(`All ${assertions} runtime assertions passed.`);
} finally {
  await heartbeat.terminate();
  await rm(rootDir, { recursive: true, force: true });
}
