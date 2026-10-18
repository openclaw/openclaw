import type { AssistantMessage, Context, Model, ProviderReplayState } from "@openclaw/llm-core";
import { assert, describe, expect, it } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { convertResponsesMessages as convertProviderResponsesMessages } from "../providers/openai-responses-shared.js";
import {
  buildOpenAIResponsesReasoningReplayMetadata,
  suppressOpenAIResponsesCompaction,
} from "./openai-responses-compaction-replay.js";
import {
  normalizeResponsesFailedEvent,
  summarizeResponsesPayload,
} from "./openai-responses-debug.js";
import * as fixtures from "./openai-responses-prompt-observer.test-support.js";
import { convertResponsesMessages } from "./openai-responses-replay-internal.js";
import {
  processResponsesStream,
  type OpenAIResponsesStreamEvent,
} from "./openai-responses-stream-internal.js";
import { stripCompactionReplayCheckpoint } from "./provider-compaction-replay.js";

const model = fixtures.createReplayModel();
const replayIdentity = { sessionId: "session-a", authProfileId: "profile-a" };

const createOutput = () => fixtures.createAssistant(model);

function compactionState(
  sourceModel: Model = model,
  overrides: Partial<ProviderReplayState> = {},
): ProviderReplayState {
  return fixtures.createReplayState(sourceModel, replayIdentity, {
    type: "openai-responses-compaction",
    id: "cmp_replay",
    data: "opaque-replay-compaction",
    replayIndex: 1,
    ...overrides,
  });
}

async function* events(
  values: Record<string, unknown>[],
): AsyncGenerator<OpenAIResponsesStreamEvent> {
  for (const value of values) {
    yield value as OpenAIResponsesStreamEvent;
  }
}

async function processEvents(
  values: Record<string, unknown>[],
  output = createOutput(),
): Promise<AssistantMessage> {
  await processResponsesStream(events(values), output, { push: () => undefined }, model, {
    reasoningReplayMetadata: buildOpenAIResponsesReasoningReplayMetadata(model, replayIdentity),
  });
  return output;
}

function replayTypes(output: AssistantMessage): string[] {
  return convertTransport({ messages: [output] }).flatMap((item) =>
    typeof item.type === "string" ? [item.type] : [],
  );
}

const convertProvider = (context: Context) =>
  convertProviderResponsesMessages(model, context, new Set(["openai"]), replayIdentity);

const convertTransport = (
  context: Context,
  identity: { sessionId?: string; authProfileId?: string } = replayIdentity,
) => convertResponsesMessages(model, context, new Set(["openai"]), identity);

function createAssistant(
  content: string | AssistantMessage["content"],
  providerReplay?: ProviderReplayState,
): AssistantMessage {
  return fixtures.createAssistant(model, content, providerReplay ? { providerReplay } : {});
}

const responseMessage = (id: string, text: string) => fixtures.outputMessage(text, id);

const compaction = (id: string, encrypted_content: string) => ({
  type: "compaction",
  id,
  encrypted_content,
});
const itemEvent = (output_index: number, item: object, phase = "done") => ({
  type: `response.output_item.${phase}`,
  output_index,
  item,
});

describe("OpenAI Responses compaction replay", () => {
  it("provider-owned skips invalid reasoning signatures", () => {
    const invalidSignatures = [
      ["truncated JSON", '{"type":"reasoning"'],
      ["null", "null"],
      ["array", "[]"],
      ["wrong item type", '{"type":"message"}'],
    ] as const;

    for (const [caseName, thinkingSignature] of invalidSignatures) {
      const input = convertProvider({
        messages: [
          createAssistant([
            { type: "thinking", thinking: "invalid", thinkingSignature },
            { type: "text", text: "session continues" },
          ]),
        ],
      });

      expect(input, caseName).toEqual([
        expect.objectContaining({ type: "message", role: "assistant" }),
      ]);
    }
  });

  it("strips only exact compaction checkpoints with structural sharing", () => {
    const unchanged = createOutput();
    expect(stripCompactionReplayCheckpoint(unchanged)).toBe(unchanged);

    const checkpoint = createAssistant("checkpoint owner", compactionState());
    const stripped = stripCompactionReplayCheckpoint(checkpoint);
    expect(stripped).not.toBe(checkpoint);
    expect(stripped.content).toBe(checkpoint.content);
    expect(stripped).not.toHaveProperty("providerReplay");
    expect(checkpoint.providerReplay).toEqual(compactionState());

    const suppression = createOutput();
    suppressOpenAIResponsesCompaction(suppression, model, replayIdentity);
    expect(stripCompactionReplayCheckpoint(suppression)).toBe(suppression);

    const unrelated = createAssistant([], compactionState(model, { type: "future-replay" }));
    expect(stripCompactionReplayCheckpoint(unrelated)).toBe(unrelated);
  });

  it("replaces an idless compaction when its encrypted payload changes", async () => {
    const output = createOutput();
    const existingReplay = compactionState(model, {
      id: undefined,
      data: "opaque-terminal-idless-old",
      replayIndex: 0,
    });
    delete existingReplay.id;
    output.providerReplay = existingReplay;

    await processEvents(
      [
        fixtures.completedResponse("resp_terminal_idless_changed", [
          { type: "compaction", encrypted_content: "opaque-terminal-idless-new" },
        ]),
      ],
      output,
    );

    expect(output.providerReplay).not.toBe(existingReplay);
    expect(output.providerReplay).toMatchObject({
      type: "openai-responses-compaction",
      data: "opaque-terminal-idless-new",
      replayIndex: 0,
    });
    expect(output.providerReplay).not.toHaveProperty("id");
    expect(
      convertTransport({ messages: [output] }).find((item) => item.type === "compaction"),
    ).toEqual({ type: "compaction", encrypted_content: "opaque-terminal-idless-new" });
  });

  it("orders reasoning, compaction, and message by normalized replay content", async () => {
    const output = await processEvents([
      itemEvent(0, { type: "reasoning", id: "rs_before", summary: [], content: [] }, "added"),
      itemEvent(0, {
        type: "reasoning",
        id: "rs_before",
        summary: [{ type: "summary_text", text: "thought" }],
        content: [],
        encrypted_content: "opaque-reasoning",
      }),
      itemEvent(1, compaction("cmp_middle", "opaque-middle"), "added"),
      itemEvent(1, compaction("cmp_middle", "opaque-middle")),
      itemEvent(2, responseMessage("msg_after", "answer")),
      fixtures.completedResponse("resp_ordered"),
    ]);

    expect(output.providerReplay?.replayIndex).toBe(1);
    expect(replayTypes(output)).toEqual(["compaction", "message"]);
  });

  it.each([
    ["separate outputs", "first answer", "second answer", 1],
    ["collapsed message", "answer", "answer extended", 0],
  ] as const)(
    "places terminal compaction at the normalized boundary for %s",
    async (_name, firstText, secondText, index) => {
      const first = responseMessage("msg_first", firstText);
      const second = responseMessage("msg_second", secondText);
      const output = await processEvents([
        itemEvent(0, first),
        itemEvent(2, second),
        fixtures.completedResponse("resp_terminal", [
          first,
          compaction("cmp_terminal", "opaque-terminal"),
          second,
        ]),
      ]);

      expect(output.providerReplay?.replayIndex).toBe(index);
      expect(replayTypes(output)).toEqual(["compaction", "message"]);
      if (index === 1) {
        expect(output.content).toHaveLength(2);
        expect(JSON.stringify(convertTransport({ messages: [output] }))).not.toContain(firstText);
      } else {
        expect(output.content).toEqual([
          expect.objectContaining({ type: "text", text: secondText }),
        ]);
      }
    },
  );

  it("provider-owned keeps instructions, owner output after compaction, and later messages", () => {
    const prefixCall = createAssistant([
      {
        type: "toolCall",
        id: "call_prefix|fc_prefix",
        name: "lookup",
        arguments: { prefix: true },
      },
    ]);
    const owner = createAssistant(
      [
        { type: "text", text: "owner text before compaction" },
        {
          type: "thinking",
          thinking: "reasoning after compaction",
          thinkingSignature: JSON.stringify({
            type: "reasoning",
            id: "rs_after_compaction",
            summary: [],
          }),
        },
        { type: "text", text: "owner text after compaction" },
        {
          type: "toolCall",
          id: "call_after|fc_after",
          name: "lookup",
          arguments: { after: true },
        },
      ],
      compactionState(model, { replayIndex: 1 }),
    );
    const laterAssistant = createAssistant([{ type: "text", text: "later assistant" }]);

    const input = convertProvider({
      systemPrompt: "current system instructions",
      messages: [
        { role: "user", content: "prefix user", timestamp: 1 },
        createAssistant([{ type: "text", text: "prefix assistant" }]),
        prefixCall,
        makeTextToolResult("call_prefix|fc_prefix", "lookup", "prefix tool result", false, 2),
        owner,
        makeTextToolResult("call_after|fc_after", "lookup", "after tool result", false, 3),
        { role: "user", content: "later user", timestamp: 4 },
        laterAssistant,
        { role: "user", content: "active current user prompt", timestamp: 5 },
      ],
    });

    expect(input.map((item) => item.type)).toEqual([
      "message",
      "compaction",
      "reasoning",
      "message",
      "function_call",
      "function_call_output",
      "message",
      "message",
      "message",
    ]);
    expect(input[0]).toMatchObject({ type: "message", role: "developer" });
    expect(input[1]).toMatchObject({ type: "compaction", id: "cmp_replay" });
    const encoded = JSON.stringify(input);
    expect(encoded).toContain("current system instructions");
    expect(encoded).toContain("owner text after compaction");
    expect(encoded).toContain("after tool result");
    expect(encoded).toContain("later user");
    expect(encoded).toContain("later assistant");
    expect(encoded).toContain("active current user prompt");
    expect(encoded).not.toContain("prefix user");
    expect(encoded).not.toContain("prefix assistant");
    expect(encoded).not.toContain("prefix tool result");
    expect(encoded).not.toContain("owner text before compaction");
  });

  it("leaves the full transcript unchanged when compaction is incompatible", () => {
    const older = createAssistant(
      [{ type: "text", text: "older assistant" }],
      compactionState(model, { replayIndex: 0 }),
    );
    const incompatible = createAssistant(
      [{ type: "text", text: "newer incompatible assistant" }],
      compactionState(model, { model: "other-model", replayIndex: 0 }),
    );
    const input = convertTransport({
      messages: [
        { role: "user", content: "first user", timestamp: 1 },
        older,
        { role: "user", content: "second user", timestamp: 2 },
        incompatible,
        { role: "user", content: "active user", timestamp: 3 },
      ],
    });

    expect(input.some((item) => item.type === "compaction")).toBe(false);
    const encoded = JSON.stringify(input);
    expect(encoded).toContain("first user");
    expect(encoded).toContain("older assistant");
    expect(encoded).toContain("second user");
    expect(encoded).toContain("newer incompatible assistant");
    expect(encoded).toContain("active user");
  });

  it("does not replay or prune across a different or missing request identity", () => {
    for (const identity of [
      { sessionId: "session-b", authProfileId: replayIdentity.authProfileId },
      { sessionId: replayIdentity.sessionId, authProfileId: "profile-b" },
      {},
    ]) {
      const assistant = createAssistant(
        [{ type: "text", text: "must remain without compatible replay" }],
        compactionState(model, { replayIndex: 0 }),
      );
      const input = convertTransport({ messages: [assistant] }, identity);

      expect(input.some((item) => item.type === "compaction")).toBe(false);
      expect(JSON.stringify(input)).toContain("must remain without compatible replay");
    }
  });

  it("does not replay across an incompatible base route", () => {
    const assistant = createOutput();
    assistant.providerReplay = compactionState(model, { baseUrlHash: "0000000000000000" });
    const input = convertTransport({
      messages: [{ role: "user", content: "first", timestamp: 1 }, assistant],
    });

    expect(input.some((item) => item.type === "compaction")).toBe(false);
  });

  it("ignores a newer foreign-route suppression tombstone", () => {
    const compatible = createAssistant(
      [
        { type: "text", text: "pruned before compaction" },
        { type: "text", text: "retained after compaction" },
      ],
      compactionState(model, { replayIndex: 1 }),
    );
    const foreignSuppression = createAssistant([{ type: "text", text: "foreign route recovered" }]);
    suppressOpenAIResponsesCompaction(
      foreignSuppression,
      { ...model, baseUrl: "https://route-b.example/v1" },
      replayIdentity,
    );

    const input = convertTransport({
      messages: [
        { role: "user", content: "pruned prefix", timestamp: 1 },
        compatible,
        { role: "user", content: "route B retry", timestamp: 2 },
        foreignSuppression,
        { role: "user", content: "current route A turn", timestamp: 3 },
      ],
    });

    expect(input.filter((item) => item.type === "compaction")).toEqual([
      expect.objectContaining({ id: "cmp_replay" }),
    ]);
    const encoded = JSON.stringify(input);
    expect(encoded).not.toContain("pruned prefix");
    expect(encoded).not.toContain("pruned before compaction");
    expect(encoded).toContain("retained after compaction");
    expect(encoded).toContain("foreign route recovered");
    expect(encoded).toContain("current route A turn");
  });

  it("omits encrypted compaction bytes from request and failure diagnostics", () => {
    const secret = "opaque-preview-compaction";
    const value = { input: [{ type: "compaction", encrypted_content: secret }] };

    const previous = process.env.OPENCLAW_DEBUG_MODEL_PAYLOAD;
    process.env.OPENCLAW_DEBUG_MODEL_PAYLOAD = "full-redacted";
    try {
      const payload = summarizeResponsesPayload(value);
      expect(payload).not.toContain(secret);
      const failure = normalizeResponsesFailedEvent({ response: { error_details: value } }, model);
      assert(failure.observation);
      expect(JSON.stringify(failure.observation)).not.toContain(secret);
      expect(failure.observation.failureFieldNames).toEqual(["error_details"]);
    } finally {
      if (previous === undefined) {
        delete process.env.OPENCLAW_DEBUG_MODEL_PAYLOAD;
      } else {
        process.env.OPENCLAW_DEBUG_MODEL_PAYLOAD = previous;
      }
    }
  });
});
