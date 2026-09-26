import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import type { Model } from "@openclaw/llm-core";
import { Stream } from "openai/core/streaming";
import { describe, expect, it, vi } from "vitest";
import { createOpenAIResponsesAssistantOutput } from "../../packages/ai/src/transports/openai-responses-replay-messages-internal.js";
import { processResponsesStream } from "../../packages/ai/src/transports/openai-responses-stream-internal.js";
import { buildGuardedModelFetch } from "../plugin-sdk/provider-transport-runtime.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { finalizeDebugProxyCaptureAsync } from "../proxy-capture/runtime.js";
import { createDebugProxyCaptureReaderAsync } from "../proxy-capture/store-readonly.async.js";
import { acquireDebugProxyCaptureStoreAsync } from "../proxy-capture/store.async.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { closeProviderTransportDispatcherPool } from "./provider-transport-dispatcher-pool.js";

const model: Model<"openai-responses"> = {
  id: "gpt-5",
  name: "Loopback fixture",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 1024,
};
const usage = {
  input_tokens: 500,
  output_tokens: 9,
  input_tokens_details: { cached_tokens: 300, cache_write_tokens: 100 },
};
const frame = (type: string, response: unknown) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, response })}\n\n`;
const prefix = frame("response.created", { id: "fixture" });
const terminal =
  prefix +
  frame("response.in_progress", { id: "fixture", fixturePadding: "x".repeat(9000) }) +
  frame("response.completed", {
    id: "fixture",
    model: model.id,
    status: "completed",
    usage,
    output: [
      {
        id: "message-fixture",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
      },
    ],
  });

describe("managed provider response capture", () => {
  it.each([
    "terminal-eof",
    "terminal-open",
    "partial-eof",
    "partial-idle",
    "error",
    "cancel",
  ] as const)(
    "keeps raw bytes and caller outcome through %s",
    async (mode) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "managed-capture-test-"));
      const sessionId = `managed-${mode}`;
      vi.stubEnv("OPENCLAW_STATE_DIR", root);
      vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "1");
      vi.stubEnv("OPENCLAW_DEBUG_PROXY_SESSION_ID", sessionId);
      vi.stubEnv("OPENCLAW_DEBUG_PROXY_URL", undefined);
      const lease = await acquireDebugProxyCaptureStoreAsync({ env: process.env });
      const reader = createDebugProxyCaptureReaderAsync({ env: process.env });
      const readCapturedResponse = () =>
        vi.waitFor(
          async () => {
            const events = await lease.store.getSessionEvents(sessionId, 10);
            const captured = events.find(
              (event) => event.kind === "response" || event.kind === "error",
            );
            if (!captured) {
              throw new Error("expected persisted response capture");
            }
            return captured;
          },
          // The partial-idle fixture exercises the production 10-second body deadline.
          mode === "partial-idle" ? { timeout: 15_000 } : undefined,
        );
      const controller = new AbortController();
      const held = createDeferredCore<ServerResponse>();
      const firstEvent = createDeferredCore();
      const isTerminal = mode.startsWith("terminal");
      const body = isTerminal ? terminal : prefix;
      try {
        await withServer(
          (request, response) => {
            request.resume();
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write(body);
            held.resolve(response);
            if (mode.endsWith("eof")) {
              response.end();
            }
          },
          async (baseUrl) => {
            const localModel = { ...model, baseUrl: `${baseUrl}/v1` };
            const response = await buildGuardedModelFetch(localModel, 20_000)(
              `${baseUrl}/v1/responses`,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ model: model.id, stream: true, input: "fixture" }),
                signal: controller.signal,
              },
            );
            try {
              const sdk = Stream.fromSSEResponse(response, controller);
              async function* observed() {
                for await (const event of sdk) {
                  firstEvent.resolve();
                  yield event;
                }
              }
              const output = createOpenAIResponsesAssistantOutput(localModel);
              // The SDK owns its request controller; the runtime's outer run
              // signal is separate from SDK terminal-iteration cleanup.
              const caller = new AbortController();
              const parsed = processResponsesStream(observed(), output, { push() {} }, localModel, {
                signal: caller.signal,
              }).then(
                (value) => ({ value, error: undefined }),
                (error: unknown) => ({ value: undefined, error }),
              );
              await firstEvent.promise;
              const cancelReason = Object.assign(new Error("fixture caller stopped"), {
                code: "FIXTURE_CANCEL",
              });
              if (mode === "partial-idle") {
                await readCapturedResponse();
                caller.abort(cancelReason);
                controller.abort(cancelReason);
              } else if (mode === "cancel") {
                caller.abort(cancelReason);
                controller.abort(cancelReason);
              } else if (mode === "error") {
                (await held.promise).destroy();
              }
              const outcome = await parsed;
              const captured = await readCapturedResponse();
              const rows = await reader.getSessionEvents(sessionId, 10);
              expect(rows.map((row) => row.kind)).toEqual([captured.kind, "request"]);
              expect(captured.status).toBe(200);
              if (typeof captured.dataBlobId !== "string") {
                throw new Error("expected captured response blob");
              }
              const raw = await reader.readBlob(captured.dataBlobId);
              expect(raw).toBe(body);
              const events = [];
              for await (const event of Stream.fromSSEResponse<{
                type: string;
                response: { usage?: typeof usage };
              }>(new Response(raw), new AbortController())) {
                events.push(event);
              }
              if (isTerminal) {
                expect(outcome.error).toBeUndefined();
                expect(output.stopReason).toBe("stop");
                expect(output.usage).toMatchObject({
                  input: 100,
                  output: 9,
                  cacheRead: 300,
                  cacheWrite: 100,
                  totalTokens: 509,
                });
                expect(events.at(-1)).toMatchObject({
                  type: "response.completed",
                  response: { usage },
                });
              } else {
                expect(outcome.error).toBeInstanceOf(Error);
                expect(outcome.value).toBeUndefined();
                expect(events.some((event) => event.type === "response.completed")).toBe(false);
              }
              // A parsed terminal closes the SDK iterator. Its managed cleanup
              // can beat EOF even when the server has already ended the body.
              if (
                mode === "error" ||
                mode === "cancel" ||
                mode === "terminal-open" ||
                (mode === "terminal-eof" && captured.kind === "error")
              ) {
                expect(captured.kind).toBe("error");
                expect(captured.errorText).toBeTruthy();
                expect(JSON.parse(String(captured.metaJson))).toMatchObject({
                  bodyCapture: "failed",
                  stage: "response-body",
                });
              } else if (mode === "partial-idle") {
                expect(captured.kind).toBe("response");
                expect(JSON.parse(String(captured.metaJson))).toMatchObject({
                  bodyCapture: "stalled",
                });
              } else {
                expect(captured.kind).toBe("response");
              }
              if (mode === "cancel" || mode === "partial-idle") {
                expect(outcome.error).toBe(cancelReason);
              }
            } finally {
              controller.abort();
              await response.body?.cancel().catch(() => undefined);
              await finalizeDebugProxyCaptureAsync();
            }
          },
        );
      } finally {
        await finalizeDebugProxyCaptureAsync();
        await lease.release();
        await closeProviderTransportDispatcherPool();
        await closeOpenClawStateDatabaseAsync();
        vi.unstubAllEnvs();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
