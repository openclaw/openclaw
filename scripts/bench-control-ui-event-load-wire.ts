// Ground event-load fixtures in the real Gateway, tools and transcript publisher.
// Only the loopback model is scripted; captures contain synthetic events, never auth frames.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { isRecord } from "../packages/normalization-core/src/record-coerce.ts";
import type { GatewayClient } from "../src/gateway/client.ts";
import type { GatewayServer } from "../src/gateway/server.ts";
import { createOpenClawTestState } from "../src/test-utils/openclaw-test-state.ts";
import { reserveTestPortListener } from "../src/test-utils/port-claims.ts";
import { writeOpenAiResponsesSse } from "../test/helpers/openai-responses-sse.ts";
import { runQaGatewayFixture } from "../test/helpers/qa-gateway-cleanup.ts";
import { BASE_GATEWAY_BENCH_CONFIG } from "./lib/gateway-bench-runtime.ts";

const { values } = parseArgs({ options: { output: { type: "string" } } });
assert(values.output, "--output must name a new directory");
const output = path.resolve(values.output);
await mkdir(output);
const state = await createOpenClawTestState({
  // The existing helper joins this prefix to os.tmpdir(); keep TMPDIR unchanged.
  prefix: path.relative(os.tmpdir(), path.join(output, "state-")),
  applyEnv: true,
});
const failures: string[] = [];
const pending = new Set<Promise<void>>();
let modelRequests = 0;
let toolCalls = 0;
let modelServer: ReturnType<typeof createServer> | undefined;
let model: Awaited<ReturnType<typeof reserveTestPortListener>> | undefined;
let reservation: Awaited<ReturnType<typeof reserveTestPortListener>> | undefined;
let gateway: GatewayServer | undefined;
let observer: GatewayClient | undefined;
await runQaGatewayFixture(
  async () => {
    model = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        (modelServer = createServer((request, response) => {
          const task = (async () => {
            assert.equal(request.url, "/v1/responses");
            const chunks: Buffer[] = [];
            for await (const chunk of request) {
              chunks.push(Buffer.from(chunk));
            }
            const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            assert(isRecord(body) && Array.isArray(body.input));
            modelRequests++;
            const completedTools = body.input.filter(
              (entry) => isRecord(entry) && entry.type === "function_call_output",
            ).length;
            const id = `synthetic-${modelRequests}`;
            if (completedTools < 2) {
              toolCalls++;
              const item = {
                type: "function_call",
                id: `fc_${id}`,
                call_id: `call_${id}`,
                name: "read",
                arguments: JSON.stringify({ path: path.join(state.workspaceDir, "fixture.txt") }),
                status: "completed",
              };
              writeOpenAiResponsesSse(response, [
                {
                  type: "response.output_item.added",
                  output_index: 0,
                  item: { ...item, status: "in_progress", arguments: "" },
                },
                {
                  type: "response.function_call_arguments.done",
                  item_id: item.id,
                  output_index: 0,
                  arguments: item.arguments,
                },
                { type: "response.output_item.done", output_index: 0, item },
                {
                  type: "response.completed",
                  response: {
                    id: `resp_${id}`,
                    status: "completed",
                    output: [item],
                    usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
                  },
                },
              ]);
              return;
            }
            const text = "Synthetic event-load result. ".repeat(8);
            const item = {
              type: "message",
              id: `msg_${id}`,
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text, annotations: [] }],
            };
            response.writeHead(200, {
              "content-type": "text/event-stream",
              "cache-control": "no-store",
            });
            const send = (event: unknown) => response.write(`data: ${JSON.stringify(event)}\n\n`);
            send({
              type: "response.output_item.added",
              output_index: 0,
              item: { ...item, status: "in_progress", content: [] },
            });
            for (let index = 0; index < 8; index++) {
              send({
                type: "response.output_text.delta",
                item_id: item.id,
                output_index: 0,
                content_index: 0,
                delta: "Synthetic event-load result. ",
              });
              await delay(80);
            }
            send({
              type: "response.output_text.done",
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              text,
            });
            send({ type: "response.output_item.done", output_index: 0, item });
            send({
              type: "response.completed",
              response: {
                id: `resp_${id}`,
                status: "completed",
                output: [item],
                usage: { input_tokens: 20, output_tokens: 20, total_tokens: 40 },
              },
            });
            response.end("data: [DONE]\n\n");
          })().catch((error: unknown) => {
            failures.push(String(error));
            response.destroy();
          });
          pending.add(task);
          void task.finally(() => pending.delete(task));
        })),
    });
    reservation = await reserveTestPortListener({
      offsets: [0],
      createListener: () => createServer(),
    });
    const port = reservation.claim.port;
    await reservation.releaseListener();
    await writeFile(
      path.join(state.workspaceDir, "fixture.txt"),
      "Synthetic tool output.\n".repeat(20),
    );
    await state.writeConfig({
      ...BASE_GATEWAY_BENCH_CONFIG,
      gateway: {
        ...BASE_GATEWAY_BENCH_CONFIG.gateway,
        port,
        controlUi: { enabled: false, allowedOrigins: [`http://127.0.0.1:${port}`] },
      },
      agents: {
        ownership: "explicit",
        defaults: {
          model: "openai/synthetic-event-load",
          models: {
            "openai/synthetic-event-load": {
              agentRuntime: { id: "openclaw" },
              params: { transport: "sse", openaiWsWarmup: false },
            },
          },
          maxConcurrent: 4,
          skipBootstrap: true,
          skills: [],
        },
        entries: { main: { workspace: state.workspaceDir } },
      },
      models: {
        catalogRefresh: { enabled: false },
        providers: {
          openai: {
            api: "openai-responses",
            apiKey: "synthetic-loopback-only",
            baseUrl: `http://127.0.0.1:${model.claim.port}/v1`,
            agentRuntime: { id: "openclaw" },
            request: { allowPrivateNetwork: true },
            models: [
              {
                id: "synthetic-event-load",
                name: "Synthetic event load",
                reasoning: false,
                input: ["text"],
                contextWindow: 128000,
                maxTokens: 4096,
              },
            ],
          },
        },
      },
      tools: { profile: "full", codeMode: false, toolSearch: false },
      plugins: {
        enabled: true,
        allow: ["openai"],
        slots: { memory: "none" },
        load: { paths: [path.resolve("extensions/openai")] },
      },
      cron: { enabled: false },
      logging: { level: "error", file: path.join(output, "gateway.log"), consoleLevel: "silent" },
    });
    const { ensureCanonicalGatewayOwnerProfile } =
      await import("../src/state/user-profile-writes.ts");
    await ensureCanonicalGatewayOwnerProfile("Synthetic event-load operator", { env: process.env });
    const { startGatewayServer } = await import("../src/gateway/server.ts");
    const { connectGatewayClient } = await import("../src/gateway/test-helpers.e2e.ts");
    const events: Array<{
      atMs: number;
      audience: string;
      event: string;
      phase?: string;
      reason?: string;
      stream?: string;
      bytes: number;
      fields: string[];
      rowFields?: string[];
      changedFields?: string[];
      fullFields?: string[];
      sessionFieldRefs?: unknown;
      dataFields?: string[];
      message: boolean;
      messageRole?: string;
      messageBytes?: number;
      rowEncoding?: string;
    }> = [];
    const samples = new Map<string, unknown>();
    const completed = new Set<string>();
    const keys = Array.from({ length: 3 }, (_, index) => `agent:main:event-load-${index}`);
    let started = 0;
    let capture = false;

    gateway = await startGatewayServer(port, { bind: "loopback", controlUiEnabled: false });
    await gateway.startupSettled;
    observer = await connectGatewayClient({
      url: `ws://127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      clientName: "openclaw-control-ui",
      mode: "webchat",
      scopes: ["operator.admin"],
      caps: [
        "session-scoped-events",
        "chat-only-assistant-text",
        "tool-events",
        "session-row-deltas",
        "session-event-field-refs",
        "roster-message-bodies-optional",
      ],
      onEvent(event) {
        if (!capture || !isRecord(event.payload)) {
          return;
        }
        const payload = event.payload;
        const key = typeof payload.sessionKey === "string" ? payload.sessionKey : "";
        if (key && !keys.includes(key)) {
          return;
        }
        if (
          event.event === "sessions.changed" &&
          (payload.phase === "end" || payload.phase === "error")
        ) {
          completed.add(key);
        }
        const row = isRecord(payload.session) ? payload.session : undefined;
        const audience =
          key === keys[0]
            ? "foreground"
            : key === keys[1]
              ? "narration"
              : key
                ? "background"
                : "shared";
        const stream = typeof payload.stream === "string" ? payload.stream : undefined;
        const reason = typeof payload.reason === "string" ? payload.reason : undefined;
        const phase =
          typeof payload.phase === "string"
            ? payload.phase
            : isRecord(payload.data) && typeof payload.data.phase === "string"
              ? payload.data.phase
              : typeof payload.state === "string"
                ? payload.state
                : undefined;
        const sampleKey = `${audience}:${event.event}:${stream ?? "-"}:${reason ?? phase ?? "-"}`;
        if (!samples.has(sampleKey)) {
          samples.set(sampleKey, event);
        }
        events.push({
          atMs: Date.now() - started,
          audience,
          reason,
          stream,
          event: event.event ?? "unknown",
          phase,
          bytes: Buffer.byteLength(JSON.stringify(event)),
          fields: Object.keys(payload),
          rowFields: row && Object.keys(row),
          changedFields: row && isRecord(row.set) ? Object.keys(row.set) : undefined,
          fullFields: row && isRecord(row.full) ? Object.keys(row.full) : undefined,
          sessionFieldRefs: payload.sessionFieldRefs,
          dataFields: isRecord(payload.data) ? Object.keys(payload.data) : undefined,
          rowEncoding: row && ("full" in row ? "full" : "set" in row ? "patch" : "plain"),
          message: Object.hasOwn(payload, "message"),
          messageRole:
            isRecord(payload.message) && typeof payload.message.role === "string"
              ? payload.message.role
              : undefined,
          messageBytes: Object.hasOwn(payload, "message")
            ? Buffer.byteLength(JSON.stringify(payload.message))
            : undefined,
        });
      },
    });
    await observer.request("sessions.subscribe", {});
    for (const key of keys) {
      await observer.request("sessions.create", { key, label: `Synthetic event load ${key}` });
    }
    await observer.request("sessions.messages.subscribe", {
      key: keys[0],
      subscriptionId: "event-load-foreground",
    });
    await observer.request("sessions.messages.subscribe", {
      key: keys[1],
      subscriptionId: "event-load-sidebar",
      mode: "narration",
    });
    capture = true;
    started = Date.now();
    await Promise.all(
      keys.map((sessionKey, index) =>
        observer!.request("chat.send", {
          sessionKey,
          message: "Read fixture.txt twice, then reply with the synthetic result.",
          idempotencyKey: `event-load-${index}`,
        }),
      ),
    );
    const deadline = Date.now() + 60_000;
    while (completed.size < keys.length && failures.length === 0 && Date.now() < deadline) {
      await delay(100);
    }
    assert.equal(failures.length, 0, failures.join("\n"));
    assert.equal(
      completed.size,
      keys.length,
      "all real turns must reach terminal session lifecycle",
    );
    assert.equal(toolCalls, 6, "the model must drive two real reads per session");
    await delay(1_000);
    const groups = new Map<
      string,
      { count: number; bytes: number; minBytes: number; maxBytes: number }
    >();
    for (const event of events) {
      const key = `${event.audience}:${event.event}:${event.phase ?? "-"}`;
      const group = groups.get(key) ?? { count: 0, bytes: 0, minBytes: Infinity, maxBytes: 0 };
      group.count++;
      group.bytes += event.bytes;
      group.minBytes = Math.min(group.minBytes, event.bytes);
      group.maxBytes = Math.max(group.maxBytes, event.bytes);
      groups.set(key, group);
    }
    const report = {
      kind: "real-gateway-synthetic-model-event-load",
      sessions: 3,
      toolsPerSession: 2,
      modelRequests,
      toolCalls,
      durationMs: Date.now() - started,
      groups: Object.fromEntries(groups),
      events,
      samples: Object.fromEntries(samples),
      backgroundLiveEvents: events.filter(
        (event) =>
          event.audience === "background" &&
          ["agent", "chat", "session.tool"].includes(event.event),
      ).length,
    };
    await writeFile(path.join(output, "wire.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ ...report, events: undefined, samples: undefined }, null, 2));
  },
  () => observer?.stopAndWait(),
  () => gateway?.close(),
  async () => {
    modelServer?.closeAllConnections();
    await model?.releaseListener();
    await Promise.all(pending);
    await model?.claim.release();
  },
  () => reservation?.claim.release(),
  () => state.cleanup(),
);
