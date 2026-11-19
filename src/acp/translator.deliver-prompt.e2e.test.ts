import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { addAbortListener } from "node:events";
import { createServer } from "node:http";
import { Readable, Writable } from "node:stream";
import {
  PROTOCOL_VERSION,
  client as createClientApp,
  methods,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { createOpenAiResponsesModelConfig } from "../../test/helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../test/helpers/openclaw-test-instance.js";

const modelId = "gpt-acp-deliver";
const modelRef = `mock-openai/${modelId}`;
const REPLY = "ACP deliver reply.";

it(
  "streams and settles deliver prompts on a session with an external route",
  { timeout: 180_000 },
  async ({ signal }) => {
    let instance: OpenClawTestInstance | undefined;
    let acpProcess: ChildProcessWithoutNullStreams | undefined;
    let acpClosed = Promise.resolve();
    let providerRequestCount = 0;
    const provider = createServer((request, response) => {
      request.resume();
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      providerRequestCount += 1;
      writeOpenAiResponsesText(response, {
        text: REPLY,
        messageId: `msg_${providerRequestCount}`,
        responseId: `resp_${providerRequestCount}`,
      });
    });

    try {
      const providerUrl = await listenLoopback(provider);
      const config = createOpenAiResponsesModelConfig({
        baseUrl: providerUrl,
        providerId: "mock-openai",
        modelId,
        reasoning: false,
        toolProfile: "minimal",
      });
      const defaults = expectDefined(config.agents?.defaults, "provider fixture agent defaults");
      defaults.workspace = process.cwd();
      defaults.models = { [modelRef]: { params: { transport: "sse", openaiWsWarmup: false } } };
      config.tools = { codeMode: { enabled: false }, toolSearch: false };
      instance = await createOpenClawTestInstance({
        name: "acp-deliver",
        config,
        env: {
          OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
      });
      await instance.startGateway();

      const sessionKey = "agent:main:main";
      // A channel turn records an external reply route; deliver prompts on this
      // session then route to it and leave the operator broadcast.
      const seed = await instance.cli([
        "gateway",
        "call",
        "agent",
        "--json",
        "--expect-final",
        "--params",
        JSON.stringify({
          sessionKey,
          message: "Seed the route.",
          channel: "telegram",
          to: "12345",
          deliver: false,
          idempotencyKey: `seed-${process.pid}`,
        }),
      ]);
      expect(seed.code, seed.stderr).toBe(0);
      const listed = await instance.cli([
        "gateway",
        "call",
        "sessions.list",
        "--json",
        "--params",
        JSON.stringify({}),
      ]);
      expect(listed.code, listed.stderr).toBe(0);
      const rows = (JSON.parse(listed.stdout) as { sessions: Record<string, unknown>[] }).sessions;
      expect(rows.find((row) => row.key === sessionKey)?.deliveryContext).toEqual({
        channel: "telegram",
        to: "12345",
      });

      const child = spawn(process.execPath, [...(await instance.entrypoint()), "acp"], {
        cwd: process.cwd(),
        env: instance.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      acpProcess = child;
      acpClosed = new Promise<void>((resolve) => {
        child.once("close", () => resolve());
      });
      const chunks: string[] = [];
      // SAFETY: Node and DOM ReadableStream types describe the same runtime object here.
      const output = Readable.toWeb(acpProcess.stdout) as Parameters<typeof ndJsonStream>[1];
      const { agent } = createClientApp()
        .onNotification(methods.client.session.update, ({ params: { update } }) => {
          if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
            chunks.push(update.content.text);
          }
        })
        .connect(ndJsonStream(Writable.toWeb(acpProcess.stdin), output));
      await agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION });
      const session = await agent.request(methods.agent.session.new, {
        cwd: process.cwd(),
        mcpServers: [],
        _meta: { sessionKey },
      });

      // The later visible prompt must not duplicate text through the subscription.
      for (const deliver of [true, false]) {
        chunks.length = 0;
        const result = await Promise.race([
          agent.request(methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: `Reply once (deliver=${deliver}).` }],
            _meta: { deliver },
          }),
          new Promise<"timeout">((resolve) => {
            setTimeout(() => resolve("timeout"), 30_000);
          }),
        ]);
        expect({ deliver, result, text: chunks.join("") }).toEqual({
          deliver,
          result: { stopReason: "end_turn" },
          text: REPLY,
        });
      }
    } finally {
      provider.closeAllConnections();
      if (acpProcess && acpProcess.exitCode === null && acpProcess.signalCode === null) {
        const child = acpProcess;
        using _ = addAbortListener(signal, () => child.kill("SIGKILL"));
        child.stdin.end();
        await acpClosed;
      }
      await instance?.cleanup();
      await closeHttpServer(provider);
    }
  },
);
