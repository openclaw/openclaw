import { channel } from "node:diagnostics_channel";
import type { ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Model } from "@openclaw/llm-core";
import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { cleanupSessionResources } from "../../packages/ai/src/session-resources.js";
import { createResponsesStreamWithRecovery } from "../../packages/ai/src/transports/openai-responses-replay-internal.js";
import { createOpenAIResponsesAssistantOutput } from "../../packages/ai/src/transports/openai-responses-replay-messages-internal.js";
import { processResponsesStream } from "../../packages/ai/src/transports/openai-responses-stream-internal.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeProviderTransportDispatcherPool } from "./provider-transport-dispatcher-pool.js";
import { buildGuardedModelFetch } from "./provider-transport-fetch.js";

const model: Model<"openai-responses"> = {
  id: "fixture-model",
  name: "Loopback fixture",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 256,
};

describe("Responses trailing HTTP body", () => {
  it("delivers terminal before EOF and reuses sockets across five sequential turns", async () => {
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "0");
    const sockets = new Map<Socket, number>();
    const socketIds: number[] = [];
    let response: ServerResponse | undefined;
    let settled = createDeferredCore();
    const onSettled = () => settled.resolve();
    const trailers = channel("undici:request:trailers");
    const errors = channel("undici:request:error");
    trailers.subscribe(onSettled);
    errors.subscribe(onSettled);
    try {
      await withServer(
        (request, reply) => {
          request.resume();
          response = reply;
          const socketId = sockets.get(request.socket) ?? sockets.size + 1;
          sockets.set(request.socket, socketId);
          socketIds.push(socketId);
          reply.writeHead(200, { "content-type": "text/event-stream" });
          reply.write(
            `data: ${JSON.stringify({
              type: "response.completed",
              response: { id: "fixture", status: "completed", output: [] },
            })}\n\n`,
          );
        },
        async (baseUrl) => {
          const localModel = { ...model, baseUrl: `${baseUrl}/v1` };
          const client = new OpenAI({
            apiKey: "fixture-key",
            baseURL: localModel.baseUrl,
            maxRetries: 0,
            fetch: buildGuardedModelFetch(localModel),
          });
          for (let turn = 0; turn < 5; turn += 1) {
            settled = createDeferredCore();
            const request = {
              model: model.id,
              stream: true,
              input: [{ role: "user", content: "fixture" }],
            } satisfies Parameters<typeof createResponsesStreamWithRecovery>[0]["request"];
            const { stream } = await createResponsesStreamWithRecovery({
              client,
              request,
              buildFullHistoryRequest: () => request,
              requestOptions: undefined,
              model: localModel,
            });
            const output = createOpenAIResponsesAssistantOutput(localModel);
            await processResponsesStream(stream, output, { push() {} }, localModel);
            expect(output.stopReason).toBe("stop");
            if (!response) {
              throw new Error("missing fixture response");
            }
            expect(response.writableEnded).toBe(false);
            response.end();
            await settled.promise;
          }
          expect(new Set(socketIds).size).toBeLessThan(5);
        },
      );
    } finally {
      cleanupSessionResources();
      trailers.unsubscribe(onSettled);
      errors.unsubscribe(onSettled);
      await closeProviderTransportDispatcherPool();
      vi.unstubAllEnvs();
    }
  });
});
