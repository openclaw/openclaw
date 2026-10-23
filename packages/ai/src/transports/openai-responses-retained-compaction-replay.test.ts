import type { AssistantMessage, Context, ProviderReplayState } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import {
  buildOpenAIResponsesCompactionReplayPlan,
  buildOpenAIResponsesReasoningReplayMetadata,
  captureOpenAIResponsesCompaction,
  CompactionReplayRefreshRequiredError,
  type OpenAIResponsesReplayMode,
} from "./openai-responses-compaction-replay.js";
import {
  isOpenAIResponsesCompactionOutput,
  readOpenAIResponsesCompactionWindow,
  type OpenAIResponsesCompactionOutput,
} from "./openai-responses-compaction-window.js";
import { resolveResponsesContinuationRequest } from "./openai-responses-continuation.js";
import * as fixtures from "./openai-responses-prompt-observer.test-support.js";
import { convertResponsesMessages } from "./openai-responses-replay-internal.js";

const model = fixtures.createReplayModel();
const replayIdentity = { sessionId: "session-a", authProfileId: "profile-a" };
const COMPACTION_WINDOW_MAX_BYTES = 16 * 1024 * 1024;
const replayMetadata = buildOpenAIResponsesReasoningReplayMetadata(model, replayIdentity);
const inputMessage = (text: string) => ({
  ...fixtures.inputMessage(text),
  status: "completed" as const,
});
const capture = (
  owner: AssistantMessage,
  item: Parameters<typeof captureOpenAIResponsesCompaction>[1],
  boundary: number | "retained-users",
  output: OpenAIResponsesCompactionOutput,
) => captureOpenAIResponsesCompaction(owner, item, boundary, model, replayMetadata, output);

function createAssistant(
  content: string | AssistantMessage["content"],
  providerReplay?: ProviderReplayState,
): AssistantMessage {
  return fixtures.createAssistant(model, content, providerReplay ? { providerReplay } : {});
}

function compactionState(
  type: "openai-responses-compaction" | "openai-responses-retained-compaction",
): ProviderReplayState {
  return fixtures.createReplayState(model, replayIdentity, {
    type,
    id: type === "openai-responses-compaction" ? "cmp_previous" : "cmp_retained",
    data: type === "openai-responses-compaction" ? "opaque-previous" : "opaque-retained",
    ...(type === "openai-responses-compaction" ? { replayIndex: 1 } : {}),
  });
}

const convert = (context: Context, replayMode: OpenAIResponsesReplayMode = "checkpoint") =>
  convertResponsesMessages(model, context, new Set(["openai"]), {
    ...replayIdentity,
    replayMode,
  });

describe("Responses retained-user compaction replay", () => {
  it("requires rebuilding legacy retained-user state", () => {
    const context: Context = {
      systemPrompt: "current system instructions",
      messages: [
        fixtures.userMessage("user absorbed by older checkpoint", 0),
        createAssistant("older checkpoint owner", compactionState("openai-responses-compaction")),
        fixtures.userMessage("first retained user", 1),
        createAssistant("discarded assistant"),
        fixtures.userMessage("second retained user", 2),
        createAssistant(
          "assistant content absorbed by compaction",
          compactionState("openai-responses-retained-compaction"),
        ),
        fixtures.userMessage("new user after compaction", 3),
      ],
    };
    expect(() => convert(context)).toThrow(CompactionReplayRefreshRequiredError);
    expect(
      buildOpenAIResponsesCompactionReplayPlan(context.messages, model, {
        ...replayIdentity,
        mode: "full-history",
      }).messages,
    ).toBe(context.messages);
  });

  it("captures and replays SDK media and optional metadata without conversion", () => {
    const item = {
      type: "compaction" as const,
      id: "cmp_retained",
      encrypted_content: "opaque-retained",
      created_by: "compactor",
    };
    const output = [
      {
        type: "message",
        role: "user",
        status: "completed",
        content: [
          { type: "input_text", text: "saved", prompt_cache_breakpoint: { mode: "explicit" } },
          { type: "input_image", detail: "original", image_url: "https://media.example/image.png" },
          { type: "input_image", detail: "auto", file_id: "file_image", image_url: null },
          { type: "input_file", file_id: "file_pdf", filename: "source.pdf", detail: "high" },
        ],
      },
      fixtures.outputMessage("Retained answer."),
      item,
    ] satisfies OpenAIResponsesCompactionOutput;
    const owner = createAssistant("covered text");
    capture(owner, item, "retained-users", output);
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercise persisted JSON reload, not an in-memory clone.
    const saved: AssistantMessage = JSON.parse(JSON.stringify(owner));
    expect(saved.providerReplay).not.toHaveProperty("replayIndex");
    expect(
      convertResponsesMessages(model, { messages: [saved] }, new Set(["openai"]), replayIdentity),
    ).toEqual(output);
  });

  it("replays compact-endpoint assistants without dangling provider item IDs after reload", () => {
    // Captured compact endpoint shape; text, item IDs, and encrypted bytes are redacted.
    const item = { type: "compaction" as const, id: "cmp_canonical", encrypted_content: "opaque" };
    const output = [
      inputMessage("first"),
      fixtures.outputMessage("first answer", "msg_first"),
      inputMessage("second"),
      fixtures.outputMessage("second answer", "msg_second"),
      item,
    ] satisfies OpenAIResponsesCompactionOutput;
    const owner = createAssistant("covered");
    capture(owner, item, "retained-users", output);
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercise persisted JSON reload.
    const saved: AssistantMessage = JSON.parse(JSON.stringify(owner));
    expect(saved.providerReplay).toMatchObject({
      v: 1,
      compactedWindow: { output: JSON.stringify(output) },
    });
    const next = convert({ messages: [saved] });
    expect(next).toStrictEqual([
      output[0],
      fixtures.outputMessage("first answer"),
      output[2],
      fixtures.outputMessage("second answer"),
      item,
    ]);
    expect(isOpenAIResponsesCompactionOutput(next, model)).toBe(true);
  });

  it("preserves the compacted prefix and current context across tool rounds", () => {
    const owner = createAssistant([], compactionState("openai-responses-compaction"));
    const item = {
      type: "compaction" as const,
      id: "cmp_retained",
      encrypted_content: "opaque-retained",
      created_by: "compactor",
    };
    capture(owner, item, "retained-users", [
      fixtures.inputMessage("active request before compaction"),
      item,
    ]);
    const messages: Context["messages"] = [
      fixtures.userMessage("active request before compaction"),
      owner,
    ];
    const carrier = {
      role: "user",
      content: "OpenClaw runtime context:\ncurrent request metadata",
      timestamp: 3,
      runtimeContext: {},
    } satisfies Context["messages"][number];
    const prefix = convert({ messages });
    let input = convert({ messages: [...messages, carrier] });
    expect(input.slice(0, prefix.length)).toEqual(prefix);
    expect(input.at(-1)).toMatchObject({
      role: "developer",
      content: [{ type: "input_text", text: carrier.content }],
    });

    for (const round of [1, 2]) {
      const callId = `call_${round}`;
      const itemId = `fc_${round}`;
      messages.push(
        createAssistant([
          { type: "toolCall", id: `${callId}|${itemId}`, name: "lookup", arguments: {} },
        ]),
        makeTextToolResult(`${callId}|${itemId}`, "lookup", `result ${round}`, false, round + 3),
      );
      const nextInput = convert({ messages: [...messages, carrier] });
      const continued = resolveResponsesContinuationRequest(
        {
          lastRequest: { model: model.id, store: true, input },
          lastResponseId: `resp_${round}`,
          lastResponseItems: [
            {
              type: "function_call",
              id: itemId,
              call_id: callId,
              name: "lookup",
              arguments: "{}",
              status: "completed",
            },
          ],
        },
        { model: model.id, store: true, input: nextInput },
      );
      expect(continued.continuationStatus, `round ${round}`).toBe("continued");
      expect(continued.request.input).toEqual([
        { type: "function_call_output", call_id: callId, output: `result ${round}` },
      ]);
      input = nextInput;
    }
  });

  it.each([
    { state: "ready", output: "not JSON" },
    {
      state: "ready",
      output: JSON.stringify([{ type: "compaction", encrypted_content: "wrong" }]),
    },
  ])("does not fall back past an invalid complete window: %j", (compactedWindow) => {
    const replay = {
      ...compactionState("openai-responses-retained-compaction"),
      compactedWindow,
    };
    const owner = createAssistant("covered", replay);
    expect(() =>
      buildOpenAIResponsesCompactionReplayPlan(
        [createAssistant("old", compactionState("openai-responses-compaction")), owner],
        model,
        replayIdentity,
      ),
    ).toThrow(CompactionReplayRefreshRequiredError);
  });

  it("rejects invalid depth before capture and counts duplicated opaque bytes in the envelope", () => {
    let metadata: unknown = "nested";
    for (let index = 0; index < 65; index += 1) {
      metadata = { child: metadata };
    }
    expect(
      isOpenAIResponsesCompactionOutput([
        { type: "compaction", encrypted_content: "opaque", metadata },
      ]),
    ).toBe(false);
    const owner = createAssistant("unchanged", compactionState("openai-responses-compaction"));
    const previous = owner.providerReplay;
    const item = {
      type: "compaction" as const,
      encrypted_content: "a".repeat(COMPACTION_WINDOW_MAX_BYTES / 2),
    };
    expect(() => capture(owner, item, 1, [item])).toThrow("exceeds 16 MiB");
    expect(owner.providerReplay).toBe(previous);
    expect(
      readOpenAIResponsesCompactionWindow({
        data: item.encrypted_content,
        compactedWindow: { state: "ready", output: " ".repeat(COMPACTION_WINDOW_MAX_BYTES + 1) },
      }),
    ).toBeUndefined();
  });

  it("refuses capture and persisted windows that the current route would mutate", () => {
    const route = { ...model, provider: "xai", baseUrl: "https://api.x.ai/v1" };
    const item = {
      type: "compaction" as const,
      id: "cmp_route",
      encrypted_content: "opaque",
      status: "completed",
    };
    const owner = createAssistant("covered");
    const metadata = buildOpenAIResponsesReasoningReplayMetadata(route, replayIdentity);
    expect(() => captureOpenAIResponsesCompaction(owner, item, 1, route, metadata, [item])).toThrow(
      "checkpoint is invalid",
    );
    expect(owner.providerReplay).toBeUndefined();
    const replay = {
      type: "openai-responses-compaction",
      id: item.id,
      data: item.encrypted_content,
      replayIndex: 1,
      ...metadata,
      compactedWindow: { state: "ready", output: JSON.stringify([item]) },
    };
    const savedOwner = createAssistant("covered", replay);
    expect(() =>
      buildOpenAIResponsesCompactionReplayPlan([savedOwner], route, replayIdentity),
    ).toThrow(CompactionReplayRefreshRequiredError);
    // The same SDK metadata is valid on the native route that retains it.
    capture(owner, item, 1, [item]);
    expect(
      buildOpenAIResponsesCompactionReplayPlan([owner], model, replayIdentity).compactedWindow,
    ).toEqual([item]);
  });

  it("keeps imported escaped plaintext over the envelope limit as a refresh barrier", () => {
    const data = "opaque-retained";
    const output = JSON.stringify([
      fixtures.inputMessage('"'.repeat(5 * 1024 * 1024)),
      { type: "compaction", id: "cmp_retained", encrypted_content: data },
    ]);
    const replay = {
      ...compactionState("openai-responses-retained-compaction"),
      data,
      compactedWindow: { state: "ready", output },
    };
    expect(Buffer.byteLength(data)).toBeLessThan(COMPACTION_WINDOW_MAX_BYTES);
    expect(Buffer.byteLength(output)).toBeLessThan(COMPACTION_WINDOW_MAX_BYTES);
    expect(Buffer.byteLength(data) + Buffer.byteLength(output)).toBeLessThan(
      COMPACTION_WINDOW_MAX_BYTES,
    );
    expect(Buffer.byteLength(JSON.stringify(replay))).toBeGreaterThan(COMPACTION_WINDOW_MAX_BYTES);
    expect(readOpenAIResponsesCompactionWindow(replay, model)).toBeUndefined();
    expect(() =>
      buildOpenAIResponsesCompactionReplayPlan(
        [
          createAssistant("older", compactionState("openai-responses-compaction")),
          createAssistant("oversized import", replay),
        ],
        model,
        replayIdentity,
      ),
    ).toThrow(CompactionReplayRefreshRequiredError);
  });
});
