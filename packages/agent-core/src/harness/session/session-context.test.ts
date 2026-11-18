import type { AssistantMessage, ProviderReplayState } from "@openclaw/llm-core";
import { expect, it } from "vitest";
import type { AgentMessage } from "../../types.js";
import { findCutPoint } from "../compaction/compaction.js";
import {
  assistant as assistantMessage,
  bash,
  custom as customMessage,
  text,
  toolResult as resultMessage,
  user as userMessage,
} from "../compaction/shard-fixtures.test-support.js";
import { convertToLlm } from "../messages.js";
import type { SessionTreeEntry as Entry } from "../types.js";
import { buildSessionContext, projectSessionEntryMessage } from "./session.js";

const timestamp = "2026-07-17T00:00:00.000Z";
const historyPrelude = Symbol.for("openclaw.sessionHistoryPrelude");
const model = { provider: "test-provider", modelId: "test-model" };

const entryBase = (id: string, parentId: string | null) => ({ id, parentId, timestamp });

function messageEntry<T extends AgentMessage>(id: string, parentId: string | null, message: T) {
  return { ...entryBase(id, parentId), type: "message" as const, message };
}

function user(id: string, parentId: string | null, content: string) {
  return messageEntry(id, parentId, userMessage(content));
}

function bashEntry(id: string, parentId: string, output: string, excludeFromContext: boolean) {
  return messageEntry(id, parentId, bash(output, { excludeFromContext }));
}

function assistant(
  id: string,
  parentId: string | null,
  content: string | AssistantMessage["content"],
  providerReplay?: ProviderReplayState,
) {
  return messageEntry(id, parentId, assistantMessage(content, { providerReplay }));
}

function replayState(type: string, data: string): ProviderReplayState {
  return {
    v: 1,
    type,
    data,
    provider: "openai",
    api: "openai-responses",
    model: "gpt-5.6-luna",
    baseUrlHash: "route-a",
  };
}

function toolCall(id: string, parentId: string, toolCallId: string) {
  const entry = assistant(id, parentId, [
    { type: "toolCall", id: toolCallId, name: "read", arguments: {} },
  ]);
  entry.message.stopReason = "toolUse";
  return entry;
}

function toolResult(id: string, parentId: string, toolCallId: string, content: string) {
  return messageEntry(id, parentId, resultMessage(content, { toolCallId }));
}

function custom(id: string, parentId: string, type: string, details: unknown, content = id): Entry {
  return {
    type: "custom_message",
    ...entryBase(id, parentId),
    customType: type,
    content,
    display: false,
    details,
  };
}

function expectTranscript(messages: AgentMessage[], expected: [AgentMessage["role"], unknown][]) {
  expect(
    messages.map((m) => [
      m.role,
      "summary" in m ? m.summary : "content" in m ? m.content : undefined,
    ]),
  ).toEqual(expected);
}

function reset(id: string, parent: string, kept?: string, reason: "new" | "reset" = "new"): Entry {
  return { type: "reset", ...entryBase(id, parent), reason, firstKeptEntryId: kept };
}

function compaction(
  id: string,
  parentId: string,
  firstKeptEntryId: string,
  summary: string,
  tokensBefore: number,
): Entry {
  return { type: "compaction", id, parentId, timestamp, summary, firstKeptEntryId, tokensBefore };
}

function resetContext(entries: [Entry, ...Entry[]], firstKeptEntryId = "kept") {
  return buildSessionContext([
    ...entries,
    reset("reset", (entries.at(-1) ?? entries[0]).id, firstKeptEntryId),
    user("new", "reset", "new turn"),
  ]);
}

it.each(["reply", "model-change"])(
  "ignores a synthetic %s when selecting the inference model",
  (kind) => {
    const artifact = assistant("artifact", "answer", "Delivered reply");
    artifact.message.provider = "openclaw";
    artifact.message.model = "command";
    const context = buildSessionContext([
      assistant("answer", null, "Provider answer"),
      kind === "reply"
        ? artifact
        : {
            type: "model_change",
            ...entryBase("command-model", "answer"),
            provider: "openclaw",
            modelId: "command",
          },
    ]);
    expect(context.model).toEqual(model);
    if (kind === "reply") {
      expect(context.messages).toContainEqual(artifact.message);
    }
  },
);

it.each([
  ["compaction", ["old-runtime", "new-update", "new-runtime"]],
  ["reset", ["new-update", "new-runtime"]],
  ["prompt-restart", ["old-runtime", "new-update", "new-runtime"]],
  ["prompt-checkpoint", ["old-update", "old-runtime", "new-update", "new-runtime"]],
] as const)(
  "retires only operators from an earlier prompt series across %s",
  (boundary, expectedOperators) => {
    const operator = (id: string, kind: "prompt-update" | "runtime-context") =>
      custom(id, "user", "openclaw.system-update", {
        kind,
        turnScoped: kind === "runtime-context",
      });
    const entries: Entry[] = [
      ...(boundary === "compaction"
        ? [user("old", null, "old"), reset("prior-reset", "old", undefined, "reset")]
        : []),
      user("user", boundary === "compaction" ? "prior-reset" : null, "Kept question"),
      operator("old-update", "prompt-update"),
      operator("old-runtime", "runtime-context"),
      assistant("answer", "old-runtime", "Kept answer"),
      boundary === "compaction"
        ? compaction("boundary", "answer", "user", "Summary", 1_000)
        : boundary === "reset"
          ? reset("boundary", "answer", "user")
          : {
              type: "custom",
              ...entryBase("boundary", "answer"),
              customType: "openclaw.system-prompt",
              data: { restart: boundary === "prompt-restart" },
            },
      operator("new-update", "prompt-update"),
      operator("new-runtime", "runtime-context"),
    ];
    const context = buildSessionContext(entries);
    expect(
      context.messages
        .filter((message) => message.role === "custom")
        .map((message) => message.content),
    ).toEqual(expectedOperators);
    const chat = context.messages.filter((m) => m.role === "user" || m.role === "assistant");
    expectTranscript(chat, [
      ["user", "Kept question"],
      ["assistant", [text("Kept answer")]],
    ]);
  },
);

it.each([
  ["extension-context", { runtimeContextCarrier: false }, false],
  [
    "openclaw.runtime-context",
    { source: "openclaw-runtime-context", runtimeContextCarrier: true },
    true,
  ],
  ["openclaw.system-update", { kind: "runtime-context", turnScoped: true }, true],
] as const)(
  "keeps runtime carriers with their user at compaction boundaries (carrier=%s)",
  (customType, details, runtimeContextCarrier) => {
    const entries: Entry[] = [
      user("entry-0", null, "original request"),
      custom("entry-1", "entry-0", customType, details, "metadata ".repeat(100)),
      assistant("entry-2", "entry-1", "done"),
    ];
    for (const keepRecentTokens of [100, 1, 1_000]) {
      const cut = findCutPoint(entries, 0, entries.length, keepRecentTokens);
      const expectedIndex =
        keepRecentTokens === 1_000 ? 0 : keepRecentTokens === 1 || runtimeContextCarrier ? 2 : 1;
      expect(cut).toEqual({
        firstKeptEntryIndex: expectedIndex,
        turnStartIndex: expectedIndex === 2 ? (runtimeContextCarrier ? 0 : 1) : -1,
        isSplitTurn: expectedIndex === 2,
      });
      const replay = buildSessionContext([
        ...entries,
        compaction("compacted", "entry-2", `entry-${expectedIndex}`, "Earlier conversation", 1_000),
      ]);
      expect(replay.messages).toMatchObject([
        { role: "compactionSummary", summary: "Earlier conversation" },
        ...[
          { role: "user", content: "original request" },
          { role: "custom", customType, content: "metadata ".repeat(100), details },
          { role: "assistant", content: [{ type: "text", text: "done" }] },
        ].slice(expectedIndex),
      ]);
    }
  },
);

it.each(["activity", "shell"])("keeps excluded %s in history but out of model input", (kind) => {
  const activity = customMessage("Context compacted", {
    customType: "openclaw.context-compaction",
    excludeFromContext: true,
  });
  const runtimeContext = customMessage("Model-visible runtime context", {
    customType: "openclaw.runtime-context",
    display: false,
    details: { source: "openclaw-runtime-context", runtimeContextCarrier: true },
  });
  const hidden =
    kind === "activity"
      ? messageEntry("hidden", "initial", activity)
      : bashEntry("hidden", "initial", "private shell output", true);
  const visible =
    kind === "activity"
      ? messageEntry("visible", "hidden", runtimeContext)
      : bashEntry("visible", "hidden", "visible shell output", false);
  const hiddenText = kind === "activity" ? "Context compacted" : "private shell output";
  const entries = [
    user("initial", null, "original request"),
    hidden,
    visible,
    user("latest", "visible", "continue"),
  ];
  const messages = buildSessionContext(entries).messages;
  expect(projectSessionEntryMessage(hidden)).toBeUndefined();
  expect(projectSessionEntryMessage(visible)).toBe(visible.message);
  expect(messages).toEqual([entries[0]?.message, visible.message, entries[3]?.message]);
  expect(JSON.stringify(entries)).toContain(hiddenText);
  if (kind === "activity") {
    expect(convertToLlm([activity])).toEqual([]);
  }
});

it("replays only the retained tail and newer entries after compaction", () => {
  const checkpoint = replayState("openai-responses-compaction", "retained-checkpoint");
  const anthropic = replayState("anthropic-compaction", "retained-anthropic-checkpoint");
  const suppression = replayState("openai-responses-compaction-suppression", "rejected");
  const post = replayState("openai-responses-compaction", "post-boundary-checkpoint");
  const context = buildSessionContext([
    user("old", null, "discarded"),
    user("kept", "old", "retained"),
    assistant("checkpoint", "kept", "retained checkpoint", checkpoint),
    assistant("anthropic", "checkpoint", "retained Anthropic checkpoint", anthropic),
    assistant("suppression", "anthropic", "retained suppression", suppression),
    { type: "model_change", ...entryBase("model", "suppression"), ...model },
    compaction("compaction", "model", "kept", "older context", 123),
    assistant("post", "compaction", "post-boundary checkpoint", post),
    user("new", "post", "new turn"),
  ]);
  expect(context).toMatchObject({ thinkingLevel: "off", model });
  expectTranscript(context.messages, [
    ["compactionSummary", "older context"],
    ["user", "retained"],
    ["assistant", [text("retained checkpoint")]],
    ["assistant", [text("retained Anthropic checkpoint")]],
    ["assistant", [text("retained suppression")]],
    ["assistant", [text("post-boundary checkpoint")]],
    ["user", "new turn"],
  ]);
  const assistants = context.messages.filter((message) => message.role === "assistant");
  expect(assistants[0]).not.toHaveProperty("providerReplay");
  expect(assistants[1]).not.toHaveProperty("providerReplay");
  expect(assistants[2]?.providerReplay).toEqual(suppression);
  expect(assistants[3]?.providerReplay).toEqual(post);
});

it.each([
  ["completed occurrences", ["call", "result", "call", "result", "result"], [0, 1, 2, 3]],
  ["local ownership", ["call", "call", "result", "result"], [0, 1, 2]],
  ["displaced ownership", ["call", "user", "result"], [0, 1, 2]],
] as const)("preserves reset tool results by %s", (_name, sequence, retained) => {
  const initial = user("kept", null, "kept");
  const entries = sequence.map((kind, i) => {
    const id = `entry-${i}`;
    const parent = i === 0 ? "kept" : `entry-${i - 1}`;
    return kind === "call"
      ? toolCall(id, parent, "call-1")
      : kind === "result"
        ? toolResult(id, parent, "call-1", id)
        : user(id, parent, id);
  });
  const { messages } = resetContext([initial, ...entries]);
  expect(messages).toEqual([
    initial.message,
    ...retained.map((i) => entries[i]?.message),
    user("new", "reset", "new turn").message,
  ]);
  for (const i of retained) {
    if (sequence[i] === "result") {
      expect(messages).toContain(entries[i]?.message);
    }
  }
});

it("keeps tool ownership within the latest reset when resets repeat", () => {
  const retained = toolCall("latest-assistant", "thinking", "latest-call");
  retained.message.providerReplay = replayState("openai-responses-compaction", "reset-checkpoint");
  const context = buildSessionContext([
    user("first-user", null, "first conversation"),
    toolCall("first-assistant", "first-user", "first-call"),
    toolResult("first-result", "first-assistant", "first-call", "first result"),
    reset("first-reset", "first-result", "first-user"),
    toolCall("discarded-assistant", "first-reset", "discarded-call"),
    user("latest-kept", "discarded-assistant", "latest conversation"),
    toolResult("orphan", "latest-kept", "discarded-call", "discarded conversation"),
    {
      type: "thinking_level_change",
      ...entryBase("thinking", "orphan"),
      thinkingLevel: "high",
    },
    retained,
    toolResult("latest-result", "latest-assistant", "latest-call", "latest result"),
    reset("latest-reset", "latest-result", "latest-kept", "reset"),
    user("new", "latest-reset", "new turn"),
  ]);
  expect(context.thinkingLevel).toBe("high");
  expect(context.messages).toMatchObject([
    { role: "user", content: "latest conversation" },
    { role: "assistant", content: [{ id: "latest-call" }] },
    { role: "toolResult", toolCallId: "latest-call" },
    { role: "user", content: "new turn" },
  ]);
  const keptAssistant = context.messages[1];
  expect(keptAssistant).not.toHaveProperty("providerReplay");
  expect(Object.getOwnPropertyDescriptor(keptAssistant ?? {}, historyPrelude)?.value).toBe(true);
  expect(JSON.stringify(context.messages)).not.toContain("discarded conversation");
});
