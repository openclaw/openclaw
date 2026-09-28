import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { streamOpenAICompletions, streamOpenAIResponses } from "@openclaw/ai/internal/openai";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { resolveResponsesContinuationRequest } from "../../../../packages/ai/src/transports/openai-responses-continuation.js";
import { loadTranscriptEvents } from "../../../config/sessions/session-accessor.js";
import { buildTimestampPrefix } from "../../../gateway/server-methods/agent-timestamp.js";
import type { Model, UserMessage } from "../../../llm/types.js";
import {
  buildLateMediaAttachedProjection,
  createUserTurnTranscriptRecorder,
  mergePreparedUserTurnMessageForRuntime,
  type UserTurnInput,
} from "../../../sessions/user-turn-transcript.js";
import { persistUserTurnTranscript } from "../../../sessions/user-turn-transcript.test-support.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
  OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
  relocateCurrentRuntimeContextCarrierToTail,
} from "../../internal-runtime-context.js";
import type { AgentMessage } from "../../runtime/index.js";
import { convertToLlm } from "../../sessions/messages.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { normalizeMessagesForLlmBoundary } from "./attempt-llm-boundary.js";

const TS = 1717570800000;
const options = { timezone: "UTC" };
const user = (text: string, timestamp = TS): UserMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp,
});
const answer = makeAgentAssistantMessage({
  content: [{ type: "text", text: "I understand." }],
  timestamp: TS + 1,
});
const model = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
} satisfies Model<"openai-completions">;
const carrier = (content: string, timestamp = TS): AgentMessage => ({
  role: "custom",
  customType: OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
  content,
  display: false,
  details: { source: "openclaw-runtime-context", runtimeContextCarrier: true },
  timestamp,
});
function toolRound(round: number, api: "openai-completions" | "openai-responses"): AgentMessage[] {
  const id = `call_${round}`;
  return [
    {
      ...answer,
      api,
      provider: model.provider,
      model: model.id,
      stopReason: "toolUse",
      content: [{ type: "toolCall", id, name: "read", arguments: {} }],
      timestamp: TS + round,
    },
    {
      role: "toolResult",
      toolCallId: id,
      toolName: "read",
      content: [{ type: "text", text: `result ${round}` }],
      isError: false,
      timestamp: TS + round,
    },
  ];
}
async function capture(api: "openai-completions" | "openai-responses", messages: AgentMessage[]) {
  let captured: Record<string, unknown> | undefined;
  const context = {
    systemPrompt: "Stable system prompt",
    messages: convertToLlm(
      relocateCurrentRuntimeContextCarrierToTail(
        normalizeMessagesForLlmBoundary(messages, options),
      ),
    ),
  };
  const streamOptions = {
    apiKey: ["fixture", "transport", "value"].join("-"),
    cacheRetention: "none" as const,
    onPayload(payload: unknown) {
      captured = payload as Record<string, unknown>;
      throw new Error("stop after payload capture");
    },
  };
  const stream =
    api === "openai-completions"
      ? streamOpenAICompletions({ ...model, api }, context, streamOptions)
      : streamOpenAIResponses({ ...model, api }, context, streamOptions);
  expect((await stream.result()).stopReason).toBe("error");
  return expectDefined(captured, "captured provider payload");
}

describe("prompt-cache boundary regressions", () => {
  it("rejects unknown session projection versions before submitting history", () => {
    expect(() => normalizeMessagesForLlmBoundary([], { sessionVersion: 99 })).toThrow(
      "Unsupported session prompt projection version",
    );
  });

  it("escapes literal delimiter mentions by session version without rewriting transcript bytes", () => {
    const text = `Quote ${INTERNAL_RUNTIME_CONTEXT_BEGIN} and ${INTERNAL_RUNTIME_CONTEXT_END} literally.`;
    const input: AgentMessage[] = [{ role: "user", content: text, timestamp: TS }];
    for (const sessionVersion of [3, 4]) {
      const boundaryOptions = {
        sessionVersion,
        appendOnlyRuntimeContext: true,
        includeTimestamp: false,
      };
      const expected =
        sessionVersion === 4
          ? "Quote [[OPENCLAW_INTERNAL_CONTEXT_BEGIN]] and [[OPENCLAW_INTERNAL_CONTEXT_END]] literally."
          : text;
      const current = normalizeMessagesForLlmBoundary(input, boundaryOptions);
      const history = normalizeMessagesForLlmBoundary(
        [...input, user("next", TS + 60000)],
        boundaryOptions,
      );
      expect(current[0]).toMatchObject({ role: "user", content: expected });
      expect(history[0]).toMatchObject({ role: "user", content: expected });
      expect(normalizeMessagesForLlmBoundary(current, boundaryOptions)).toEqual(current);
    }
    expect(input).toEqual([{ role: "user", content: text, timestamp: TS }]);
  });

  it("preserves an existing timestamp envelope when a channel turn becomes history", () => {
    const stamped = "[Sat 2026-06-05 10:30 UTC+8] Hello from Discord";
    const output = normalizeMessagesForLlmBoundary(
      [{ role: "user", content: stamped, timestamp: TS }, answer, user("next", TS + 60000)],
      options,
    );
    expect(output[0]).toMatchObject({ content: stamped });
  });

  it("keeps every sent fingerprint stable and appends one late-media turn", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-99495-boundary-"));
    const target = {
      agentId: "main",
      cwd: dir,
      sessionEntry: undefined,
      sessionId: "session-99495",
      sessionKey: "agent:main:cache-99495",
      storePath: path.join(dir, "sessions.json"),
    };
    const input = { text: "describe this", timestamp: TS, idempotencyKey: "cache-99495:user" };
    let resolveMedia!: (input: UserTurnInput) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const media = new Promise<UserTurnInput>((resolve) => {
      resolveMedia = resolve;
    });
    try {
      const recorder = createUserTurnTranscriptRecorder({
        input,
        target,
        resolveInput: async () => {
          markStarted();
          return await media;
        },
      });
      const persistence = recorder.persistFallback();
      await started;
      await persistUserTurnTranscript({ ...target, input });
      recorder.markRuntimePersisted(recorder.message);
      const runtimeMessage = mergePreparedUserTurnMessageForRuntime({
        runtimeMessage: user(input.text),
        preparedMessage: recorder.message,
      });
      const sent = normalizeMessagesForLlmBoundary([runtimeMessage], options);
      recorder.markSentToProvider?.();
      const mediaPath = path.join(dir, "image.png");
      resolveMedia({ ...input, media: [{ path: mediaPath, contentType: "image/png" }] });
      await persistence;
      const persisted = (await loadTranscriptEvents(target))
        .map((entry) => entry as { message?: AgentMessage })
        .flatMap((entry) => (entry.message ? [entry.message] : []));
      const next = normalizeMessagesForLlmBoundary(persisted, options);
      const late = expectDefined(persisted.at(-1), "persisted late-media turn");
      expect(next).toHaveLength(sent.length + 1);
      expect(next.slice(0, sent.length)).toEqual(sent);
      expect(late).toMatchObject({ content: "", __openclaw: { lateMedia: true } });
      expect(next.at(-1)).toMatchObject({
        content: `${buildTimestampPrefix(new Date(TS), options)}[media attached: ${mediaPath}]`,
      });
      const projection = buildLateMediaAttachedProjection(late);
      expect(projection.text).toBe(`[media attached: ${mediaPath}]`);
      expect(projection.media).toEqual([
        expect.objectContaining({ path: mediaPath, contentType: "image/png", kind: "image" }),
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves the full-history provider prefix through a completed tool loop on the next user turn", async () => {
    const active = [
      carrier("sender=Bob"),
      user("Check the deployment."),
      ...toolRound(1, "openai-completions"),
    ];
    const previous = await capture("openai-completions", active);
    const next = await capture("openai-completions", [
      ...active,
      answer,
      carrier("new metadata", TS + 60000),
      user("next request", TS + 60000),
    ]);
    const previousMessages = previous.messages as unknown[];
    const nextMessages = next.messages as unknown[];
    expect(nextMessages.slice(0, previousMessages.length - 1)).toEqual(
      previousMessages.slice(0, -1),
    );
    expect(JSON.stringify(previousMessages.at(-1))).toContain("sender=Bob");
    expect(JSON.stringify(nextMessages)).not.toContain("sender=Bob");
  });

  it("continues Responses tool rounds without moving or losing cron prompt context", async () => {
    const metadata = "Conversation info:\nsender=Bob";
    const memory = "Context:\n<active_memory_plugin>\nsaved preference\n</active_memory_plugin>";
    const messages = [
      carrier(metadata),
      user(`${memory}\n\nCurrent time: 2026-06-05 10:30. Check the deployment.`),
    ];
    let previous = await capture("openai-responses", messages);
    expect(JSON.stringify(previous.input)).toContain("saved preference");
    expect(JSON.stringify(previous.input)).toContain(metadata.replaceAll("\n", "\\n"));
    for (const round of [1, 2]) {
      const callId = `call_${round}`;
      messages.push(...toolRound(round, "openai-responses"));
      const request = await capture("openai-responses", messages);
      const continuation = resolveResponsesContinuationRequest(
        {
          lastRequest: previous,
          lastResponseId: `resp_${round}`,
          lastResponseItems: [
            { type: "function_call", call_id: callId, name: "read", arguments: "{}" },
          ],
        },
        request,
      );
      expect(continuation.continuationStatus).toBe("continued");
      expect(continuation.request.input).toEqual([
        { type: "function_call_output", call_id: callId, output: `result ${round}` },
      ]);
      previous = request;
    }
    messages.push(answer, user("next request", TS + 60000));
    const next = await capture("openai-responses", messages);
    expect(JSON.stringify(next.input)).not.toContain("saved preference");
    expect(JSON.stringify(next.input)).not.toContain("sender=Bob");
    expect(
      resolveResponsesContinuationRequest(
        { lastRequest: previous, lastResponseId: "resp_final", lastResponseItems: [] },
        next,
      ).continuationStatus,
    ).toBe("history_changed");
  });

  it("keeps persisted group sender bytes identical from the active array form to historical replay", () => {
    const runtimeMessage = user("The launch is Friday");
    const transcriptMessage = {
      ...runtimeMessage,
      content: "The launch is Friday",
      __openclaw: { senderId: "alice-id", senderName: "Alice", senderUsername: "alice" },
    };
    const boundaryOptions = {
      ...options,
      userTranscriptContexts: [{ runtimeMessage, transcriptMessage }],
    };
    const current = normalizeMessagesForLlmBoundary([runtimeMessage], boundaryOptions);
    const historical = normalizeMessagesForLlmBoundary(
      [transcriptMessage, answer, user("Who said that?", TS + 60000)],
      options,
    );
    const currentContent = current[0]?.role === "user" ? current[0].content : undefined;
    const historicalContent = historical[0]?.role === "user" ? historical[0].content : undefined;
    expect(currentContent).toEqual(historicalContent);
    expect(current[0]).toMatchObject({ content: expect.stringContaining('"name":"Alice"') });
    expect(normalizeMessagesForLlmBoundary(current, boundaryOptions)).toEqual(current);
  });
});
