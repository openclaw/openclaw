import { streamOpenAICompletions } from "@openclaw/ai/internal/openai";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type { Context, Model } from "../../../llm/types.js";
import { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE } from "../../internal-runtime-context.js";
import type { AgentMessage } from "../../runtime/index.js";
import { convertToLlm } from "../../sessions/messages.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { resolveTranscriptPolicy } from "../../transcript-policy.js";
import { normalizeMessagesForLlmBoundary } from "./attempt-llm-boundary.js";
import { createFakeStream } from "./attempt-stream.test-helpers.js";
import { wrapStreamFnSanitizeMalformedToolCalls } from "./attempt-tool-call-replay-sanitization.js";
import { buildSystemUpdateMessage } from "./runtime-context-prompt.js";

const TS = 1717570800000;
const user = (text: string, minute: number): AgentMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: TS + minute * 60000,
});
const carrier = (text: string, minute: number): AgentMessage => ({
  role: "custom",
  customType: OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
  content: text,
  display: false,
  details: { source: "openclaw-runtime-context", runtimeContextCarrier: true },
  timestamp: TS + minute * 60000,
});
const update = (section: string, minute: number): AgentMessage => ({
  ...buildSystemUpdateMessage(`System prompt update.\n\n${section}`, "prompt-update", false),
  timestamp: TS + minute * 60000,
});
const reply = (text: string, minute: number): AgentMessage =>
  makeAgentAssistantMessage({ content: [{ type: "text", text }], timestamp: TS + minute * 60000 });

// Each route projects prompt updates as plain user text and merges user turns at the stream.
const routes = [
  { family: "custom Chat Completions", provider: "custom-chat", api: "openai-completions" },
  {
    family: "Claude through a custom Responses proxy",
    provider: "custom-proxy",
    api: "openai-responses",
    id: "claude-opus-5",
  },
] as const;
const silentTurns = {
  "a silent NO_REPLY turn after an AGENTS.md edit": [
    user("Reply with exactly NO_REPLY.", 1),
    carrier("turn two context", 1),
    update("## /workspace/AGENTS.md\n# Rules\n- Rule added before the silent turn.", 1),
  ],
  "a silent exec wake that carries a tooling update": [
    user("[OpenClaw exec completion] Exec completed (code 0)", 1),
    carrier("wake context", 1),
    update("## Tooling\n- exec: Run shell commands", 1),
  ],
};

async function send(
  route: { provider: string; api: string; id?: string },
  history: AgentMessage[],
): Promise<unknown[]> {
  const model = {
    id: route.id ?? "fixture-model",
    name: "fixture",
    api: route.api,
    provider: route.provider,
    baseUrl: "https://llm.example.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4096,
  } as Model;
  const policy = resolveTranscriptPolicy({
    provider: route.provider,
    modelApi: route.api,
    modelId: model.id,
    model,
  });
  let sent: unknown[] | undefined;
  const transport = (streamModel: Model, context: Context) => {
    if (streamModel.api !== "openai-completions") {
      sent = JSON.parse(JSON.stringify(context.messages)) as unknown[];
      return createFakeStream({ events: [], resultMessage: reply("done", 9) }) as never;
    }
    return streamOpenAICompletions(streamModel as Model<"openai-completions">, context, {
      apiKey: "fixture-transport-value",
      cacheRetention: "none",
      onPayload(payload) {
        sent = (payload as { messages: unknown[] }).messages;
        throw new Error("stop after payload capture");
      },
    });
  };
  const messages = normalizeMessagesForLlmBoundary(history, {
    timezone: "UTC",
    inHistorySystemUpdates: policy.inHistorySystemUpdates,
    appendOnlyRuntimeContext: policy.appendOnlyRuntimeContext,
  });
  const stream = await wrapStreamFnSanitizeMalformedToolCalls(
    transport,
    undefined,
    policy,
    route.provider,
  )(model, { systemPrompt: "Stable system prompt", messages: convertToLlm(messages) });
  await stream.result();
  return expectDefined(sent, "captured provider messages");
}

const firstTurn = [user("Reply with exactly: OK one", 0), carrier("turn one context", 0)];
const nextTurn = [user("Reply with exactly: OK three", 2), carrier("turn three context", 2)];

describe("prompt updates on routes without in-history system messages", () => {
  for (const route of routes) {
    it.each(Object.entries(silentTurns))(
      `${route.family} keeps earlier messages byte-identical after %s`,
      async (_name, silentTurn) => {
        const history = [...firstTurn, reply("OK one", 0), ...silentTurn];
        const previous = await send(route, history);
        const next = await send(route, [...history, ...nextTurn]);
        expect(JSON.stringify(next.slice(0, previous.length))).toBe(JSON.stringify(previous));
        expect(JSON.stringify(previous.at(-1))).toContain("System prompt update.");
        expect(JSON.stringify(next.at(-2))).toContain("Reply with exactly: OK three");
      },
    );

    it(`${route.family} sends a prompt update before a visible reply as plain user text`, async () => {
      const history = [...firstTurn, update("## Tooling\n- read: Read files", 0)];
      const previous = await send(route, history);
      const next = await send(route, [...history, reply("OK one", 0), ...nextTurn]);
      expect(JSON.stringify(next.slice(0, previous.length))).toBe(JSON.stringify(previous));
      expect(Object.keys(expectDefined(previous.at(-1), "update")).toSorted()).toEqual(
        route.api === "openai-completions" ? ["content", "role"] : ["content", "role", "timestamp"],
      );
    });

    it(`${route.family} still merges unmarked consecutive user text`, async () => {
      const plain = { role: "user", content: "System prompt update.\n\n## Tooling", timestamp: TS };
      const sent = await send(route, [...firstTurn, plain as AgentMessage, ...nextTurn]);
      const merged = sent.find((message) => JSON.stringify(message).includes("## Tooling"));
      expect(JSON.stringify(merged)).toContain("Reply with exactly: OK three");
    });
  }
});
