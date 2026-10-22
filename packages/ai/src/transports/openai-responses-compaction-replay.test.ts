import type { AssistantMessage, Context, Model, ProviderReplayState } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { convertResponsesMessages as convertProviderResponsesMessages } from "../providers/openai-responses-shared.js";
import {
  buildOpenAIResponsesReasoningReplayMetadata,
  suppressOpenAIResponsesCompaction,
} from "./openai-responses-compaction-replay.js";
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

function expectTranscript(input: unknown, retained: string[], removed: string[] = []) {
  const encoded = JSON.stringify(input);
  for (const text of retained) {
    expect(encoded).toContain(text);
  }
  for (const text of removed) {
    expect(encoded).not.toContain(text);
  }
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
    const laterAssistant = createAssistant("later assistant");

    const input = convertProvider({
      systemPrompt: "current system instructions",
      messages: [
        fixtures.userMessage("prefix user", 1),
        createAssistant("prefix assistant"),
        prefixCall,
        makeTextToolResult("call_prefix|fc_prefix", "lookup", "prefix tool result", false, 2),
        owner,
        makeTextToolResult("call_after|fc_after", "lookup", "after tool result", false, 3),
        fixtures.userMessage("later user", 4),
        laterAssistant,
        fixtures.userMessage("active current user prompt", 5),
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
    expectTranscript(
      input,
      [
        "current system instructions",
        "owner text after compaction",
        "after tool result",
        "later user",
        "later assistant",
        "active current user prompt",
      ],
      ["prefix user", "prefix assistant", "prefix tool result", "owner text before compaction"],
    );
  });

  it.each<[string, Partial<ProviderReplayState>, { sessionId?: string; authProfileId?: string }]>([
    ["model", { model: "other-model" }, replayIdentity],
    ["base route", { baseUrlHash: "0000000000000000" }, replayIdentity],
    ["session", {}, { ...replayIdentity, sessionId: "session-b" }],
    ["auth profile", {}, { ...replayIdentity, authProfileId: "profile-b" }],
    ["missing identity", {}, {}],
  ])("leaves the full transcript unchanged for incompatible %s", (_name, overrides, identity) => {
    const older = createAssistant("older assistant", compactionState(model, { replayIndex: 0 }));
    const incompatible = createAssistant(
      "newer incompatible assistant",
      compactionState(model, { replayIndex: 0, ...overrides }),
    );
    const input = convertTransport(
      {
        messages: [
          fixtures.userMessage("first user", 1),
          older,
          fixtures.userMessage("second user", 2),
          incompatible,
          fixtures.userMessage("active user", 3),
        ],
      },
      identity,
    );

    expect(input.some((item) => item.type === "compaction")).toBe(false);
    expectTranscript(input, [
      "first user",
      "older assistant",
      "second user",
      "newer incompatible assistant",
      "active user",
    ]);
  });

  it("ignores a newer foreign-route suppression tombstone", () => {
    const compatible = createAssistant(
      [
        { type: "text", text: "pruned before compaction" },
        { type: "text", text: "retained after compaction" },
      ],
      compactionState(model, { replayIndex: 1 }),
    );
    const foreignSuppression = createAssistant("foreign route recovered");
    suppressOpenAIResponsesCompaction(
      foreignSuppression,
      { ...model, baseUrl: "https://route-b.example/v1" },
      replayIdentity,
    );

    const input = convertTransport({
      messages: [
        fixtures.userMessage("pruned prefix", 1),
        compatible,
        fixtures.userMessage("route B retry", 2),
        foreignSuppression,
        fixtures.userMessage("current route A turn", 3),
      ],
    });

    expect(input.filter((item) => item.type === "compaction")).toEqual([
      expect.objectContaining({ id: "cmp_replay" }),
    ]);
    expectTranscript(
      input,
      ["retained after compaction", "foreign route recovered", "current route A turn"],
      ["pruned prefix", "pruned before compaction"],
    );
  });
});
