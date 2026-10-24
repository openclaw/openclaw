import type { AssistantMessage, ProviderReplayState } from "@openclaw/llm-core";
import { expect, it } from "vitest";
import { createZeroUsage } from "../../../../ai/src/usage.test-support.js";
import type { AgentMessage } from "../../types.js";
import { findCutPoint } from "../compaction/compaction.js";
import { convertToLlm } from "../messages.js";
import type { SessionTreeEntry as Entry } from "../types.js";
import { buildSessionContext, projectSessionEntryMessage } from "./session.js";

const timestamp = "2026-07-17T00:00:00.000Z";
const historyPrelude = Symbol.for("openclaw.sessionHistoryPrelude");

function entryBase(id: string, parentId: string | null) {
  return { id, parentId, timestamp };
}

function messageEntry<T extends AgentMessage>(id: string, parentId: string | null, message: T) {
  return { ...entryBase(id, parentId), type: "message" as const, message };
}

function user(id: string, parentId: string | null, content: string): Entry {
  return messageEntry(id, parentId, { role: "user", content, timestamp: Date.parse(timestamp) });
}

function bashEntry(id: string, parentId: string, output: string, excludeFromContext: boolean) {
  return messageEntry(id, parentId, {
    role: "bashExecution",
    command: `print ${output}`,
    output,
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp: Date.parse(timestamp),
    excludeFromContext,
  });
}

function assistant(
  id: string,
  parentId: string | null,
  content: string | AssistantMessage["content"],
  providerReplay?: ProviderReplayState,
) {
  return messageEntry<AssistantMessage>(id, parentId, {
    role: "assistant",
    api: "openai-responses",
    content: typeof content === "string" ? [{ type: "text", text: content }] : content,
    provider: "test-provider",
    model: "test-model",
    usage: {
      ...createZeroUsage(),
      input: 1,
      output: 1,
      totalTokens: 2,
    },
    stopReason: "stop",
    timestamp: Date.parse(timestamp),
    ...(providerReplay ? { providerReplay } : {}),
  });
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
  return messageEntry(id, parentId, {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text: content }],
    isError: false,
    timestamp: Date.parse(timestamp),
  });
}

function custom(
  id: string,
  parentId: string,
  customType: string,
  content: string,
  details: unknown,
): Entry {
  return {
    type: "custom_message",
    ...entryBase(id, parentId),
    customType,
    content,
    display: false,
    details,
  };
}

function expectRoles(messages: AgentMessage[], ...roles: AgentMessage["role"][]) {
  expect(messages.map((message) => message.role)).toEqual(roles);
}

function expectTranscript(messages: AgentMessage[], expected: [AgentMessage["role"], string][]) {
  expect(
    messages.map((message) => [
      message.role,
      "summary" in message ? message.summary : "content" in message ? message.content : undefined,
    ]),
  ).toEqual(
    expected.map(([role, content]) => [
      role,
      role === "assistant" || role === "toolResult" ? [{ type: "text", text: content }] : content,
    ]),
  );
}

function reset(
  id: string,
  parentId: string,
  firstKeptEntryId?: string,
  reason: "new" | "reset" = "new",
): Entry {
  return { type: "reset", id, parentId, timestamp, reason, firstKeptEntryId };
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
    const answer = assistant("answer", null, "Provider answer");
    const artifact = assistant("artifact", "answer", "Delivered reply");
    artifact.message.provider = "openclaw";
    artifact.message.model = "command";
    const context = buildSessionContext([
      answer,
      kind === "reply"
        ? artifact
        : {
            type: "model_change",
            ...entryBase("command-model", "answer"),
            provider: "openclaw",
            modelId: "command",
          },
    ]);
    expect(context.model).toEqual({ provider: "test-provider", modelId: "test-model" });
    if (kind === "reply") {
      expect(context.messages).toContainEqual(artifact.message);
    }
  },
);

it.each(["compaction", "reset", "prompt-restart", "prompt-checkpoint"])(
  "retires only operators from an earlier prompt series across %s",
  (boundary) => {
    const operator = (id: string, kind: "prompt-update" | "runtime-context") =>
      custom(id, "user", "openclaw.system-update", id, {
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
    if (boundary === "compaction") {
      expect(context.messages[0]).toMatchObject({
        role: "compactionSummary",
        summary: "Summary",
      });
    }
    expect(
      context.messages
        .filter((message) => message.role === "custom")
        .map((message) => message.content),
    ).toEqual(
      boundary === "prompt-checkpoint"
        ? ["old-update", "old-runtime", "new-update", "new-runtime"]
        : boundary === "reset"
          ? ["new-update", "new-runtime"]
          : ["old-runtime", "new-update", "new-runtime"],
    );
    const conversation = context.messages.filter(
      (m) => m.role === "user" || m.role === "assistant",
    );
    expectTranscript(conversation, [
      ["user", "Kept question"],
      ["assistant", "Kept answer"],
    ]);
    expect(entries.filter((entry) => entry.type === "custom_message")).toHaveLength(4);
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
      custom("entry-1", "entry-0", customType, "metadata ".repeat(100), details),
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
      const firstKeptEntry = entries[cut.firstKeptEntryIndex];
      if (!firstKeptEntry) {
        throw new Error("Expected a retained compaction boundary");
      }
      const replay = buildSessionContext([
        ...entries,
        compaction("compacted", "entry-2", firstKeptEntry.id, "Earlier conversation", 1_000),
      ]);
      expect(replay.messages).toMatchObject([
        { role: "compactionSummary", summary: "Earlier conversation" },
        ...[
          { role: "user", content: "original request" },
          {
            role: "custom",
            customType,
            content: "metadata ".repeat(100),
            details,
          },
          { role: "assistant", content: [{ type: "text", text: "done" }] },
        ].slice(expectedIndex),
      ]);
    }
  },
);

it.each(["activity", "shell"])("keeps excluded %s in history but out of model input", (kind) => {
  const activity = {
    role: "custom" as const,
    customType: "openclaw.context-compaction",
    content: "Context compacted",
    display: true,
    excludeFromContext: true,
    timestamp: Date.parse(timestamp),
  };
  const runtimeContext = {
    role: "custom" as const,
    customType: "openclaw.runtime-context",
    content: "Model-visible runtime context",
    display: false,
    details: { source: "openclaw-runtime-context", runtimeContextCarrier: true },
    timestamp: Date.parse(timestamp),
  };
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
  expectRoles(messages, "user", kind === "activity" ? "custom" : "bashExecution", "user");
  expect(JSON.stringify(messages)).not.toContain(hiddenText);
  expect(JSON.stringify(entries)).toContain(hiddenText);
  if (kind === "shell") {
    expect(JSON.stringify(messages)).toContain("visible shell output");
    return;
  }
  expect(convertToLlm([activity])).toEqual([]);
  expect(JSON.stringify(messages)).toContain("Model-visible runtime context");
  expect(convertToLlm(messages)).toMatchObject([
    { role: "user", content: "original request" },
    {
      role: "user",
      content:
        "OpenClaw runtime context:\nModel-visible runtime context\nEnd OpenClaw runtime context.",
      runtimeContext: {},
    },
    { role: "user", content: "continue" },
  ]);
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
    {
      type: "model_change",
      ...entryBase("model", "suppression"),
      provider: "test-provider",
      modelId: "test-model",
    },
    compaction("compaction", "model", "kept", "older context", 123),
    assistant("post", "compaction", "post-boundary checkpoint", post),
    user("new", "post", "new turn"),
  ]);
  expect(context).toMatchObject({
    thinkingLevel: "off",
    model: { provider: "test-provider", modelId: "test-model" },
  });
  expectTranscript(context.messages, [
    ["compactionSummary", "older context"],
    ["user", "retained"],
    ["assistant", "retained checkpoint"],
    ["assistant", "retained Anthropic checkpoint"],
    ["assistant", "retained suppression"],
    ["assistant", "post-boundary checkpoint"],
    ["user", "new turn"],
  ]);
  const assistants = context.messages.filter((message) => message.role === "assistant");
  expect(assistants[0]).not.toHaveProperty("providerReplay");
  expect(assistants[1]).not.toHaveProperty("providerReplay");
  expect(assistants[2]?.providerReplay).toEqual(suppression);
  expect(assistants[3]?.providerReplay).toEqual(post);
});

it("treats the latest reset as a hard cut with a user/assistant-only kept tail", () => {
  const retainedCheckpoint = replayState("openai-responses-compaction", "reset-checkpoint");
  const { messages } = resetContext([
    user("discarded", null, "discarded"),
    user("kept", "discarded", "kept question"),
    toolResult("kept-tool", "kept", "call-1", "hidden tool result"),
    assistant("kept-assistant", "kept-tool", "kept answer", retainedCheckpoint),
  ]);
  expectTranscript(messages, [
    ["user", "kept question"],
    ["assistant", "kept answer"],
    ["user", "new turn"],
  ]);
  expect(JSON.stringify(messages)).not.toContain("discarded");
  expect(JSON.stringify(messages)).not.toContain("hidden tool result");
  const keptAssistant = messages[1];
  expect(keptAssistant).not.toHaveProperty("providerReplay");
  expect(Object.getOwnPropertyDescriptor(keptAssistant ?? {}, historyPrelude)?.value).toBe(true);
});

it("retains reset tool results by call occurrence while excluding an orphan", () => {
  const { messages } = resetContext([
    user("discarded", null, "discarded"),
    user("kept", "discarded", "kept"),
    toolCall("assistant-1", "kept", "call-1"),
    toolResult("result-1", "assistant-1", "call-1", "first result"),
    toolCall("assistant-2", "result-1", "call-1"),
    toolResult("result-2", "assistant-2", "call-1", "second result"),
    toolResult("orphan", "result-2", "call-1", "orphan result"),
  ]);
  expectRoles(messages, "user", "assistant", "toolResult", "assistant", "toolResult", "user");
  expect(JSON.stringify(messages)).toContain("first result");
  expect(JSON.stringify(messages)).toContain("second result");
  expect(JSON.stringify(messages)).not.toContain("orphan result");
});

it("keeps tool ownership within the latest reset when resets repeat", () => {
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
    toolCall("latest-assistant", "thinking", "latest-call"),
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
  expect(JSON.stringify(context.messages)).not.toContain("discarded conversation");
});

it.each(["local", "displaced"])(
  "preserves %s tool-result ownership and position after reset",
  (kind) => {
    const local = kind === "local";
    const result = toolResult("result", "intervening", "call-1", "owned result");
    const { messages } = resetContext([
      user("kept", null, "kept"),
      toolCall("assistant", "kept", "call-1"),
      local
        ? toolCall("intervening", "assistant", "call-1")
        : user("intervening", "assistant", "intervening"),
      result,
      ...(local ? [toolResult("extra", "result", "call-1", "ambiguous extra")] : []),
    ]);
    const middleRole = local ? "assistant" : "user";
    expectRoles(messages, "user", "assistant", middleRole, "toolResult", "user");
    expect(messages[3]).toBe(result.message);
    expect(JSON.stringify(messages)).not.toContain("ambiguous extra");
  },
);
