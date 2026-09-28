import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenAIResponsesOptions } from "../../../packages/ai/src/transports/openai-responses-contracts.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { isLiveTestEnabled } from "../live-test-helpers.js";
import { createOpenAIResponsesTransportStreamFn } from "../openai-transport-stream.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import type { AgentSessionEvent } from "./agent-session-types.js";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";
import { createAgentSession } from "./sdk.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

const apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
const describeLive = isLiveTestEnabled() && apiKey ? describe : describe.skip;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function truncateAfterToolArguments(response: Response, onCut: (callId: string) => void): Response {
  if (!response.body) {
    throw new Error("Live Responses request returned no stream body");
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let buffered = "";
      let callId = "";
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) {
            throw new Error("Live Responses stream ended before a function argument delta");
          }
          buffered += decoder.decode(chunk.value, { stream: true });
          let separator: RegExpExecArray | null;
          while ((separator = /\r?\n\r?\n/.exec(buffered))) {
            const end = separator.index + separator[0].length;
            const frame = buffered.slice(0, end);
            buffered = buffered.slice(end);
            controller.enqueue(encoder.encode(frame));
            const data = frame
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (!data || data === "[DONE]") {
              continue;
            }
            const event = JSON.parse(data) as ResponseStreamEvent;
            if (
              event.type === "response.output_item.added" &&
              event.item.type === "function_call"
            ) {
              callId = event.item.call_id;
            }
            if (event.type === "response.function_call_arguments.delta") {
              onCut(callId);
              controller.close();
              await reader.cancel();
              return;
            }
          }
        }
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return new Response(body, { status: response.status, headers: response.headers });
}

describeLive("AgentSession Responses EOF live", () => {
  it("recovers after a real unfinished tool call while retaining a completed result", async () => {
    const modelId = process.env.OPENCLAW_LIVE_RESPONSES_MODEL || "gpt-5.6-luna";
    const model = {
      id: modelId,
      name: modelId,
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 1024,
    } satisfies Model<"openai-responses">;
    const root = tempDirs.make("openclaw-responses-eof-live-");
    const receipt = `RECEIPT_${randomUUID()}`;
    const record = vi.fn(async () => ({
      content: [{ type: "text" as const, text: receipt }],
      details: {},
    }));
    const inspect = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "inspected" }],
      details: {},
    }));
    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey("openai", apiKey);
    const { session } = await createAgentSession({
      cwd: root,
      agentDir: join(root, "agent"),
      model,
      thinkingLevel: "low",
      noTools: "builtin",
      customTools: [
        {
          name: "record_receipt",
          label: "Record receipt",
          description:
            "Record once and return a receipt. Preserve its result without repeating it.",
          parameters: Type.Object({}),
          execute: record,
        },
        {
          name: "inspect_receipt",
          label: "Inspect receipt",
          description: "Inspect the receipt returned by record_receipt.",
          parameters: Type.Object({ receipt: Type.String() }),
          execute: inspect,
        },
      ],
      resourceLoader: createResourceLoader(),
      authStorage,
      modelRegistry: ModelRegistry.inMemory(authStorage),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
      }),
    });
    const requests: Context[] = [];
    const events: AgentSessionEvent[] = [];
    session.subscribe((event) => events.push(event));
    const transport = createOpenAIResponsesTransportStreamFn();
    session.agent.streamFn = (activeModel, context, options) => {
      requests.push({ ...context, messages: [...context.messages] });
      const requestOptions = {
        ...options,
        apiKey,
        transport: "sse",
        timeoutMs: 30_000,
        maxTokens: 1024,
        reasoning: "low",
        toolChoice:
          requests.length <= 2
            ? {
                type: "function",
                name: requests.length === 1 ? "record_receipt" : "inspect_receipt",
              }
            : "none",
      } satisfies OpenAIResponsesOptions;
      return transport(activeModel, context, requestOptions);
    };
    const host = getAiTransportHost();
    let httpRequests = 0;
    let unfinishedCallId = "";
    configureAiTransportHost({
      ...host,
      buildModelFetch: (...args) => {
        const fetch = host.buildModelFetch(...args) ?? globalThis.fetch;
        return async (input, init) => {
          const requestNumber = ++httpRequests;
          if (requestNumber > 3) {
            throw new Error("Live EOF probe exceeded three Responses requests");
          }
          const response = await fetch(input, init);
          // End a genuine provider stream locally; keep request policy and parsing unchanged.
          return requestNumber === 2 && response.ok
            ? truncateAfterToolArguments(response, (callId) => {
                unfinishedCallId = callId;
              })
            : response;
        };
      },
    });
    try {
      await session.prompt(
        "Call record_receipt once, then inspect_receipt with its receipt. " +
          "If inspection is interrupted, preserve the completed record. " +
          "Finish by reporting the exact receipt returned by record_receipt.",
      );

      expect(unfinishedCallId).not.toBe("");
      expect(record).toHaveBeenCalledOnce();
      expect(inspect).not.toHaveBeenCalled();
      expect(events.filter((event) => event.type === "auto_retry_start")).toMatchObject([
        { errorMessage: "Responses stream ended with unresolved tool calls" },
      ]);
      expect(events.filter((event) => event.type === "auto_retry_end")).toMatchObject([
        { success: true },
      ]);
      expect(httpRequests).toBe(3);
      expect(requests).toHaveLength(3);
      expect(
        requests[2]?.messages.filter((message) => message.role === "toolResult"),
      ).toMatchObject([{ toolName: "record_receipt", content: [{ type: "text", text: receipt }] }]);
      expect(session.getLastAssistantText()).toContain(receipt);
    } finally {
      await session.abort();
      session.dispose();
      configureAiTransportHost(host);
    }
  }, 120_000);
});
