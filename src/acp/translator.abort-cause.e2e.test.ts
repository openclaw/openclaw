import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { acquireGatewayTestClient } from "../../test/helpers/gateway-client.js";
import {
  closeHttpServer,
  listenLoopback,
  readRequestText,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesSse } from "../../test/helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../test/helpers/openclaw-test-instance.js";
import { withinTest } from "../../test/helpers/promise.js";
import type { GatewayClient } from "../gateway/client.js";

const ABORT_CAUSE = "session_status tool validation failed: invalid arguments";
const modelId = "gpt-acp-abort-cause";
const modelRef = `mock-openai/${modelId}`;

function writeToolCall(response: ServerResponse): void {
  const call = {
    type: "function_call",
    id: "fc_abort_cause",
    call_id: "call_abort_cause",
    name: "session_status",
    arguments: JSON.stringify({ changesSince: "not-a-number" }),
  };
  const events = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...call, arguments: "" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: call.id,
      output_index: 0,
      delta: call.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item: call },
    {
      type: "response.completed",
      response: {
        id: "resp_abort_cause",
        status: "completed",
        output: [call],
        usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
      },
    },
  ];
  writeOpenAiResponsesSse(response, events);
}

async function connectOperator(instance: OpenClawTestInstance, signal: AbortSignal) {
  return acquireGatewayTestClient(
    {
      url: instance.url,
      token: instance.gatewayToken,
      clientName: "cli",
      mode: "cli",
      role: "operator",
      scopes: ["operator.write", "operator.admin"],
      deviceIdentity: null,
      env: instance.env,
      sharedStateMode: "read-only",
    },
    {
      timeoutMs: 120_000,
      signal,
      timeoutMessage: "operator connection timed out",
      closeMessage: "operator connection closed",
    },
  );
}

async function stopChild(
  child: ChildProcessWithoutNullStreams | undefined,
  closed: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.stdin.end();
  try {
    await withinTest(closed, signal);
  } catch (error) {
    if (!signal.aborted) {
      throw error;
    }
    // EOF owns normal shutdown; only an aborted test needs the cleanup rescue.
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await closed;
  }
}

it(
  "shows the carried tool-validation cause before cancelled settlement",
  { timeout: 120_000 },
  async ({ signal }) => {
    let instance: OpenClawTestInstance | undefined;
    let operator: GatewayClient | undefined;
    let acpProcess: ChildProcessWithoutNullStreams | undefined;
    let acpClosed = Promise.resolve();
    const stalledResponses = new Set<ServerResponse>();
    let providerRequestCount = 0;
    let failedToolUpdate = false;
    const provider = createServer((request, response) => {
      void (async () => {
        const text = await readRequestText(request);
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        providerRequestCount += 1;
        const body: unknown = JSON.parse(text);
        const tools = isRecord(body) && Array.isArray(body.tools) ? body.tools : [];
        if (!tools.some((tool) => isRecord(tool) && tool.name === "session_status")) {
          throw new Error("session_status tool missing from provider request");
        }
        if (providerRequestCount > 1) {
          stalledResponses.add(response);
          request.once("close", () => stalledResponses.delete(response));
          return;
        }
        writeToolCall(response);
      })().catch((error: unknown) => response.writeHead(500).end(String(error)));
    });

    try {
      const providerUrl = await listenLoopback(provider);
      instance = await createOpenClawTestInstance({
        name: "acp-abort-cause",
        config: {
          agents: {
            defaults: {
              workspace: process.cwd(),
              skipBootstrap: true,
              model: { primary: modelRef },
              models: { [modelRef]: { params: { transport: "sse", openaiWsWarmup: false } } },
            },
          },
          tools: {
            codeMode: { enabled: false },
            // This provider fixture emits a direct call, not a Tool Search lookup.
            toolSearch: false,
          },
          models: {
            mode: "replace",
            providers: {
              "mock-openai": {
                baseUrl: `${providerUrl}/v1`,
                apiKey: "test",
                api: "openai-responses",
                models: [{ id: modelId, name: modelId }],
              },
            },
          },
          plugins: { slots: { memory: "none" } },
        },
        env: {
          OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
      });
      await instance.startGateway();
      operator = await connectOperator(instance, signal);

      const entrypoint = await instance.entrypoint();
      const child = spawn(
        process.execPath,
        [...entrypoint, "acp", "--url", instance.url, "--token", instance.gatewayToken],
        { cwd: process.cwd(), env: instance.env, stdio: ["pipe", "pipe", "pipe"] },
      );
      acpProcess = child;
      acpClosed = new Promise<void>((resolve) => {
        child.once("close", () => resolve());
      });
      const timeline: string[] = [];
      // SAFETY: Node and DOM ReadableStream types describe the same runtime object here.
      const output = Readable.toWeb(acpProcess.stdout) as Parameters<typeof ndJsonStream>[1];
      const stream = ndJsonStream(Writable.toWeb(acpProcess.stdin), output);
      const client = new ClientSideConnection(
        () => ({
          sessionUpdate: async (notification: SessionNotification) => {
            const update = notification.update;
            if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
              timeline.push(update.content.text);
            }
            if (update.sessionUpdate === "tool_call_update" && update.status === "failed") {
              failedToolUpdate = true;
            }
          },
          requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        }),
        stream,
      );
      await client.initialize({
        protocolVersion: PROTOCOL_VERSION,
      });
      const sessionKey = `agent:main:acp-abort-cause-${process.pid}`;
      const session = await client.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        _meta: { sessionKey },
      });
      const prompt = client.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "Call session_status now." }],
      });

      await expect
        .poll(() => ({ failedToolUpdate, providerRequestCount }), {
          timeout: 30_000,
          interval: 25,
        })
        .toEqual({ failedToolUpdate: true, providerRequestCount: 2 });
      await expect(operator.request("chat.abort", { sessionKey })).resolves.toMatchObject({
        aborted: true,
      });
      const result = await prompt;
      timeline.push(result.stopReason);

      expect(timeline).toContain(`[OpenClaw interruption] ${ABORT_CAUSE}`);
      expect(timeline.at(-1)).toBe("cancelled");
    } finally {
      for (const response of stalledResponses) {
        response.destroy();
      }
      await stopChild(acpProcess, acpClosed, signal);
      await operator?.stopAndWait({ timeoutMs: 1_000 }).catch(() => operator?.stop());
      await instance?.cleanup();
      await closeHttpServer(provider);
    }
  },
);
