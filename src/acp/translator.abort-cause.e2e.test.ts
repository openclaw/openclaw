import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { addAbortListener } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { createOpenAiResponsesModelConfig } from "../../test/helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesSse } from "../../test/helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../test/helpers/openclaw-test-instance.js";

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
  writeOpenAiResponsesSse(response, [
    { type: "response.output_item.done", output_index: 0, item: call },
    { type: "response.completed", response: { id: "resp_abort_cause", status: "completed" } },
  ]);
}

it(
  "shows the carried tool-validation cause before cancelled settlement",
  { timeout: 120_000 },
  async ({ signal }) => {
    let instance: OpenClawTestInstance | undefined;
    let acpProcess: ChildProcessWithoutNullStreams | undefined;
    let acpClosed = Promise.resolve();
    let providerRequestCount = 0;
    let failedToolUpdate = false;
    const provider = createServer((request, response) => {
      request.resume();
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
      } else if (++providerRequestCount === 1) {
        writeToolCall(response);
      }
    });

    try {
      const providerUrl = await listenLoopback(provider);
      const config = createOpenAiResponsesModelConfig({
        baseUrl: providerUrl,
        providerId: "mock-openai",
        modelId,
        reasoning: false,
        toolProfile: "full",
      });
      const defaults = expectDefined(config.agents?.defaults, "provider fixture agent defaults");
      defaults.workspace = process.cwd();
      defaults.models = { [modelRef]: { params: { transport: "sse", openaiWsWarmup: false } } };
      // This provider emits a direct call, not a Tool Search lookup.
      config.tools = { codeMode: { enabled: false }, toolSearch: false };
      instance = await createOpenClawTestInstance({
        name: "acp-abort-cause",
        config,
        env: {
          OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
      });
      await instance.startGateway();

      const child = spawn(process.execPath, [...(await instance.entrypoint()), "acp"], {
        cwd: process.cwd(),
        env: instance.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      acpProcess = child;
      acpClosed = new Promise<void>((resolve) => {
        child.once("close", () => resolve());
      });
      const timeline: string[] = [];
      // SAFETY: Node and DOM ReadableStream types describe the same runtime object here.
      const output = Readable.toWeb(acpProcess.stdout) as Parameters<typeof ndJsonStream>[1];
      const client = new ClientSideConnection(
        () => ({
          sessionUpdate: async ({ update }) => {
            if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
              timeline.push(update.content.text);
            }
            if (update.sessionUpdate === "tool_call_update" && update.status === "failed") {
              failedToolUpdate = true;
            }
          },
          requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        }),
        ndJsonStream(Writable.toWeb(acpProcess.stdin), output),
      );
      await client.initialize({ protocolVersion: PROTOCOL_VERSION });
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
        .poll(() => [failedToolUpdate, providerRequestCount], { timeout: 30_000, interval: 25 })
        .toEqual([true, 2]);
      const abort = await instance.cli([
        "gateway",
        "call",
        "chat.abort",
        "--json",
        "--params",
        JSON.stringify({ sessionKey }),
      ]);
      expect(abort.code, abort.stderr).toBe(0);
      expect(JSON.parse(abort.stdout)).toMatchObject({ aborted: true });
      timeline.push((await prompt).stopReason);

      expect(timeline).toContain(`[OpenClaw interruption] ${ABORT_CAUSE}`);
      expect(timeline.at(-1)).toBe("cancelled");
    } finally {
      provider.closeAllConnections();
      if (acpProcess && acpProcess.exitCode === null && acpProcess.signalCode === null) {
        const child = acpProcess;
        // EOF owns normal shutdown; an aborted test gets a signal-bound rescue.
        using _ = addAbortListener(signal, () => child.kill("SIGKILL"));
        child.stdin.end();
        await acpClosed;
      }
      await instance?.cleanup();
      await closeHttpServer(provider);
    }
  },
);
