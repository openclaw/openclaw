/**
 * Isolated Gateway proof of how much provider prompt prefix an Advisor fork shares
 * with the main run it reviews. A loopback Anthropic Messages model records each
 * request body; the main turn calls a tool three times and Advisor reviews after
 * every call. No credentials, Team data, or live state.
 * node --import ./scripts/tsx.mjs scripts/perf/advisor-fork-prefix-gateway.ts --output <new-dir>
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { listKnownProviderAuthEnvVarNamesCore } from "../../src/secrets/provider-env-vars.ts";
import { connectRestartClient } from "../../test/gateway-restart.test-support.ts";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.ts";

const { values } = parseArgs({ options: { output: { type: "string" } } });
assert(values.output);
const output = path.resolve(values.output);
await mkdir(output);

type Body = Record<string, unknown> & {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  tools?: unknown[];
  system?: unknown;
};
const requests: Array<{ kind: "main" | "fork"; body: Body }> = [];
const TOOL_CALLS = 3;

function writeAnthropic(response: ServerResponse, model: string, block: Record<string, unknown>) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const id = `msg_${randomUUID()}`;
  const events: Array<Record<string, unknown> & { type: string }> = [
    {
      type: "message_start",
      message: {
        id,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
  ];
  if (block.type === "tool_use") {
    events.push(
      { type: "content_block_start", index: 0, content_block: { ...block, input: {} } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
      },
    );
  } else {
    events.push(
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: block.text } },
    );
  }
  events.push(
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: block.type === "tool_use" ? "tool_use" : "end_turn" },
      usage: { output_tokens: 5 },
    },
    { type: "message_stop" },
  );
  for (const event of events) {
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
}

const server = createServer((request, response) => {
  void (async () => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Body;
    const fork = JSON.stringify(body.messages.at(-1) ?? null).includes(
      "You are an advisor reading this conversation",
    );
    requests.push({ kind: fork ? "fork" : "main", body });
    if (fork) {
      writeAnthropic(response, body.model, { type: "text", text: "NO_CHANGE" });
      return;
    }
    const results = body.messages
      .flatMap((m): unknown[] => (Array.isArray(m.content) ? m.content : []))
      .filter((b) => (b as { type?: unknown } | null)?.type === "tool_result").length;
    // Leave time for the due review to fork while this run is still active.
    await delay(results === 0 ? 0 : 2_500);
    writeAnthropic(
      response,
      body.model,
      results < TOOL_CALLS
        ? {
            type: "tool_use",
            id: `toolu_${randomUUID().slice(0, 8)}`,
            name: "session_status",
            input: {},
          }
        : { type: "text", text: "Synthetic work complete." },
    );
  })().catch((error: unknown) => {
    response.writeHead(500);
    response.end(String(error));
  });
});
await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert(address && typeof address !== "string");
const modelId = "claude-probe-5";
const modelRef = `probe-anthropic/${modelId}`;

const instance = await createOpenClawTestInstance({
  name: "advisor-fork-prefix",
  // Run source directly; the default entrypoint publishes runtime artifacts.
  entrypoint: ["--import", "./scripts/tsx.mjs", "src/entry.ts"],
  startTimeoutMs: 180_000,
  env: {
    ...Object.fromEntries(listKnownProviderAuthEnvVarNamesCore().map((name) => [name, undefined])),
    OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
    OPENCLAW_AGENT_RUNTIME: undefined,
    OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
  },
});
let client: Awaited<ReturnType<typeof connectRestartClient>> | undefined;
try {
  await instance.state.writeConfig({
    gateway: {
      mode: "local",
      auth: { mode: "token", token: instance.gatewayToken },
      controlUi: { enabled: false },
    },
    agents: {
      defaults: {
        workspace: instance.state.workspaceDir,
        skipBootstrap: true,
        model: { primary: modelRef },
        modelPolicy: { allow: [modelRef] },
        models: {
          [modelRef]: { agentRuntime: { id: "openclaw" }, params: { cacheRetention: "short" } },
        },
        thinkingDefault: "off",
        timeoutSeconds: 120,
      },
      entries: { main: { workspace: instance.state.workspaceDir } },
    },
    models: {
      providers: {
        "probe-anthropic": {
          baseUrl: `http://127.0.0.1:${address.port}`,
          apiKey: "test",
          api: "anthropic-messages",
          models: [
            {
              id: modelId,
              name: modelId,
              api: "anthropic-messages",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 200_000,
              maxTokens: 4096,
            },
          ],
        },
      },
    },
    plugins: {
      enabled: true,
      allow: ["advisor"],
      entries: { advisor: { enabled: true, config: { everyToolCalls: 1, everyMinutes: 0 } } },
    },
    skills: { load: { watch: false } },
    tools: { allow: ["session_status"], codeMode: { enabled: false }, toolSearch: false },
  });
  await instance.startGateway();
  client = await connectRestartClient(instance, { env: instance.env, deviceIdentity: null });
  const session = await client.request<{ key: string }>(
    "sessions.create",
    { agentId: "main", label: "Advisor fork prefix", idempotencyKey: "fork-prefix" },
    { timeoutMs: 120_000 },
  );
  const runId = randomUUID();
  await client.request("agent", {
    sessionKey: session.key,
    message: "Check session status three times, then finish.",
    deliver: false,
    idempotencyKey: runId,
  });
  const result = await client.request<{ status: string }>("agent.wait", {
    runId,
    timeoutMs: 110_000,
  });
  assert.equal(result.status, "ok", JSON.stringify(result));
  await delay(1_000);
} finally {
  client?.stop();
  await writeFile(path.join(output, "gateway.log"), instance.logs());
  await writeFile(path.join(output, "requests.json"), `${JSON.stringify(requests, null, 2)}\n`);
  await instance.cleanup();
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

// Anthropic reads a cached prefix only if every byte up to a prior breakpoint matches.
const canon = (value: unknown) => JSON.stringify(value);
const strip = (value: unknown): unknown =>
  JSON.parse(canon(value), (key, v) => (key === "cache_control" ? undefined : v));
const report = [];
for (const [index, entry] of requests.entries()) {
  if (entry.kind !== "fork") {
    continue;
  }
  const main = requests.slice(0, index).findLast((r) => r.kind === "main")?.body;
  assert(main, "fork without a preceding main request");
  const fork = entry.body;
  const mainMessages = main.messages;
  const forkMessages = fork.messages;
  let firstDiff = -1;
  for (let i = 0; i < mainMessages.length; i++) {
    if (canon(strip(mainMessages[i])) !== canon(strip(forkMessages[i]))) {
      firstDiff = i;
      break;
    }
  }
  const diffDetail =
    firstDiff >= 0
      ? { main: strip(mainMessages[firstDiff]), fork: strip(forkMessages[firstDiff]) }
      : undefined;
  report.push({
    forkIndex: index,
    toolsEqual: canon(strip(main.tools)) === canon(strip(fork.tools)),
    systemEqual: canon(strip(main.system)) === canon(strip(fork.system)),
    systemExact: canon(main.system) === canon(fork.system),
    mainMessages: mainMessages.length,
    forkMessages: forkMessages.length,
    firstDifferingMessage: firstDiff,
    diffDetail,
    mainBreakpoints: canon(main).split('"cache_control"').length - 1,
    forkBreakpoints: canon(fork).split('"cache_control"').length - 1,
    otherKeys: Object.keys(fork)
      .filter((k) => !["messages", "system", "tools"].includes(k))
      .map((k) => [
        k,
        canon(main[k]) === canon(fork[k]) ? "same" : { main: main[k], fork: fork[k] },
      ]),
  });
}
await writeFile(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ requests: requests.map((r) => r.kind), report }, null, 2));
