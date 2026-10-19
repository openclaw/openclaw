import { setImmediate } from "node:timers/promises";
import OpenAI from "openai";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { CompactionReplayRejection } from "../provider-options.js";
import type { OpenAIResponsesRequestParams } from "./openai-responses-contracts.js";
import { createModel, sseResponse } from "./openai-responses-prompt-observer.test-support.js";
import { createResponsesStreamWithRecovery } from "./openai-responses-replay-internal.js";
import { createOpenAIProviderAcceptanceHook } from "./openai-transport-shared.js";
import { withProviderResponseHook } from "./transport-stream-shared.js";
const model = createModel({
  id: "gpt-5.6-luna",
  baseUrl: "https://responses.example.test/v1",
});
it.each(["streamed", "HTTP"])(
  "Responses recovery closes prior streams before retry (%s)",
  async (secondFailure) => {
    const order: string[] = [];
    let firstResponse: Response | undefined;
    const controller = new AbortController();
    const [cleanupStarted, releaseCleanup] = [createDeferred(), createDeferred()];
    let consuming: Promise<void> | undefined;
    let attempt = 0;
    const client = new OpenAI({
      apiKey: "fixture-key",
      baseURL: model.baseUrl,
      organization: null,
      project: null,
      maxRetries: 0,
      fetch: async () => {
        const error = {
          code: "invalid_encrypted_content",
          message: "could not decrypt the provided encrypted_content",
          type: "invalid_request_error",
        };
        if (attempt === 2 && secondFailure === "HTTP") {
          return Response.json({ error }, { status: 400 });
        }
        const response = { id: `resp_${attempt}`, output: [] };
        const events = [
          { type: "response.created", response: { ...response, status: "in_progress" } },
          attempt === 3
            ? { type: "response.completed", response: { ...response, status: "completed" } }
            : { type: "response.failed", response: { ...response, status: "failed", error } },
        ];
        const httpResponse = sseResponse(events, { "x-request-id": `req_${attempt}` });
        firstResponse ??= httpResponse;
        return httpResponse;
      },
    });
    const send = client.responses.create.bind(client.responses);
    const create = vi.spyOn(client.responses, "create").mockImplementation((body, options) => {
      order.push(`create:${++attempt}`);
      return send(body, options);
    });
    const reasoning = { type: "reasoning" as const, id: "rs_prior", summary: [] };
    const encrypted = { ...reasoning, encrypted_content: "reasoning-data" };
    const checkpoint = {
      type: "compaction" as const,
      id: "cmp_prior",
      encrypted_content: "compaction-data",
    };
    const after = { role: "user" as const, content: "After checkpoint" };
    const before = { role: "user" as const, content: "Before checkpoint" };
    const request: OpenAIResponsesRequestParams = {
      model: model.id,
      stream: true,
      input: structuredClone([encrypted, checkpoint, after]),
    };
    const buildFullHistoryRequest = vi.fn((): OpenAIResponsesRequestParams => ({
      ...request,
      input: [structuredClone(before), ...request.input],
    }));
    const rejected = vi.fn((_item: CompactionReplayRejection) => void order.push("commit"));
    try {
      const result = await createResponsesStreamWithRecovery({
        client,
        request,
        requestOptions: { signal: controller.signal },
        model,
        canRetryStream: () => true,
        buildFullHistoryRequest,
        onCompactionRejected: rejected,
        async *wrapStream({ stream, response }) {
          try {
            yield* withProviderResponseHook({
              stream,
              signal: controller.signal,
              abort: (reason) => controller.abort(reason),
              hook: createOpenAIProviderAcceptanceHook(
                {
                  signal: controller.signal,
                  onResponse: ({ headers }) => void order.push(`hook:${headers["x-request-id"]}`),
                },
                response,
                model,
              ),
            });
          } finally {
            if (response === firstResponse) {
              order.push("cleanup:req_1");
              cleanupStarted.resolve();
              await releaseCleanup.promise;
            }
            order.push(`close:${response.headers.get("x-request-id")}`);
          }
        },
      });
      expect(order).toEqual(["create:1"]);
      const events: unknown[] = [];
      consuming = (async () => {
        for await (const event of result.stream) {
          events.push(event);
        }
      })();
      await Promise.race([cleanupStarted.promise, consuming]);
      await setImmediate();
      expect(order).toEqual(["create:1", "hook:req_1", "cleanup:req_1"]);
      releaseCleanup.resolve();
      await consuming;
      expect(events).toMatchObject([
        { type: "response.created", response: { id: "resp_1" } },
        ...(secondFailure === "streamed"
          ? [{ type: "response.created", response: { id: "resp_2" } }]
          : []),
        { type: "response.created", response: { id: "resp_3" } },
        { type: "response.completed", response: { id: "resp_3", status: "completed" } },
      ]);
      expect(order).toEqual([
        "create:1",
        "hook:req_1",
        "cleanup:req_1",
        "close:req_1",
        "create:2",
        ...(secondFailure === "streamed" ? ["hook:req_2", "close:req_2"] : []),
        "create:3",
        "commit",
        "hook:req_3",
        "close:req_3",
      ]);
      expect(create.mock.calls[0]?.[0]).toBe(request);
      expect(create.mock.calls.slice(1).map(([body]) => body.input)).toEqual([
        [reasoning, checkpoint, after],
        [before, reasoning, after],
      ]);
      expect(buildFullHistoryRequest).toHaveBeenCalledOnce();
      expect(rejected).toHaveBeenCalledExactlyOnceWith({
        id: "cmp_prior",
        data: "compaction-data",
      });
    } finally {
      releaseCleanup.resolve();
      controller.abort();
      await Promise.allSettled([consuming]);
      create.mockRestore();
    }
  },
);
