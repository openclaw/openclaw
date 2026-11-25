// Synthetic restart workload for bench-gateway-startup.ts; no external inference.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { buildMockOpenAiResponsesProvider } from "../../src/gateway/test-openai-responses-model.ts";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.ts";
import { createGatewayWsClient } from "./gateway-ws-client.ts";

export const STARTUP_RESUME_SKIPPED = 155;
export const STARTUP_RESUME_AGENT = "incident-agent-01";

export function startupResumeConfig(baseUrl = "http://127.0.0.1:1/v1") {
  const model = buildMockOpenAiResponsesProvider(baseUrl, "synthetic-restart");
  return {
    models: {
      mode: "replace" as const,
      providers: {
        [model.providerId]: { ...model.config, request: { allowPrivateNetwork: true } },
      },
    },
    agents: {
      defaults: {
        model: { primary: model.modelRef },
        modelPolicy: { allow: [model.modelRef] },
        models: {
          [model.modelRef]: {
            agentRuntime: { id: "openclaw" },
            params: { transport: "sse", openaiWsWarmup: false },
          },
        },
        skipBootstrap: true,
        skills: [],
        maxConcurrent: 12,
        compaction: { memoryFlush: { enabled: false } },
      },
    },
  };
}

export async function startStartupResumeProvider() {
  const resumes: number[] = [];
  const errors: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.url, "/v1/responses");
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        body.stream !== false &&
        JSON.stringify(body.input).includes("The Gateway restarted while you were working.")
      ) {
        resumes.push(performance.now());
      }
      const text = "Synthetic restart work complete.";
      if (body.stream === false) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: `resp_${randomUUID()}`,
            object: "response",
            status: "completed",
            output: [
              { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
            ],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }),
        );
      } else {
        writeOpenAiResponsesText(response, {
          text,
          messageId: `msg_${randomUUID()}`,
          responseId: `resp_${randomUUID()}`,
        });
      }
    })().catch((error: unknown) => {
      errors.push(String(error));
      response.destroy();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    config: startupResumeConfig(`http://127.0.0.1:${address.port}/v1`),
    resumes,
    errors,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export type StartupReadProbe = {
  connectMs?: number;
  methods: Record<
    string,
    {
      attempts: number;
      unavailable: number;
      startupUnavailable: number;
      startupUnavailableMs: number[];
      firstSuccessMs?: number;
      errors: string[];
    }
  >;
};

/** One connected dashboard, fixed 500 ms retry cadence, without hidden transport retries. */
export async function probeStartupReads(params: {
  port: number;
  token: string;
  startAt: number;
  deadlineAt: number;
  isDone: () => boolean;
}): Promise<StartupReadProbe> {
  const methods = ["models.list", "mentions.list", "sessions.github.options"];
  const result: StartupReadProbe = {
    methods: Object.fromEntries(
      methods.map((method) => [
        method,
        {
          attempts: 0,
          unavailable: 0,
          startupUnavailable: 0,
          startupUnavailableMs: [],
          errors: [],
        },
      ]),
    ),
  };
  while (performance.now() < params.deadlineAt && !params.isDone()) {
    const client = createGatewayWsClient({ url: `ws://127.0.0.1:${params.port}` });
    try {
      await client.waitOpen();
      const connected = await client.request("connect", {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: "gateway-client",
          displayName: "startup-read-benchmark",
          version: "1.0.0",
          platform: process.platform,
          mode: "backend",
        },
        auth: { token: params.token },
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
        caps: [],
      });
      if (!connected.ok) {
        await delay(500);
        continue;
      }
      result.connectMs = performance.now() - params.startAt;
      await Promise.all(
        methods.map(async (method) => {
          const observation = result.methods[method]!;
          while (performance.now() < params.deadlineAt && !params.isDone()) {
            observation.attempts++;
            const response = await client.request(
              method,
              method === "sessions.github.options"
                ? { sessionKey: `agent:${STARTUP_RESUME_AGENT}:bench-0` }
                : {},
              Math.max(1, params.deadlineAt - performance.now()),
            );
            if (response.ok) {
              observation.firstSuccessMs = performance.now() - params.startAt;
              return;
            }
            const error = response.error;
            if (isRecord(error) && error.code === "UNAVAILABLE") {
              observation.unavailable++;
              if (isRecord(error.details) && error.details.reason === "startup-sidecars") {
                observation.startupUnavailable++;
                observation.startupUnavailableMs.push(performance.now() - params.startAt);
              }
            } else {
              observation.errors.push(JSON.stringify(error));
              return;
            }
            await delay(500);
          }
        }),
      );
      return result;
    } catch (error) {
      if (result.connectMs !== undefined) {
        for (const observation of Object.values(result.methods)) {
          observation.errors.push(String(error));
        }
        return result;
      }
      await delay(500);
    } finally {
      client.close();
    }
  }
  return result;
}
