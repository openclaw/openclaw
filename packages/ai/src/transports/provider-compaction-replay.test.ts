import type { AssistantMessage, Context, Model, ProviderReplayState } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { createZeroUsage } from "../usage.test-support.js";
import {
  createCompactionCapture,
  buildAnthropicReplayPlan,
} from "./anthropic-compaction-replay.js";
import {
  buildOpenAIResponsesReasoningReplayMetadata,
  captureOpenAIResponsesCompaction as captureCompaction,
  suppressOpenAIResponsesCompaction as suppressCompaction,
} from "./openai-responses-compaction-replay.js";
import type { OpenAIResponsesCompactionOutput } from "./openai-responses-compaction-window.js";
import { convertResponsesMessages } from "./openai-responses-replay-internal.js";
import {
  CompactionReplayRefreshRequiredError,
  preserveCompactionReplayWindow as preserveWindow,
  replaceCompactionReplayOwnerContent as replaceOwnerContent,
  requiresCompactionReplayRefresh as requiresRefresh,
  resolveCompactionReplayEligibility as resolveEligibility,
  resolveCompactionReplayPressure as measurePressure,
} from "./provider-compaction-replay.js";

const model = {
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 8192,
} satisfies Model<"openai-responses">;
const replayIdentity = { sessionId: "session-a", authProfileId: "profile-a" };
const replayMetadata = buildOpenAIResponsesReasoningReplayMetadata(model, replayIdentity);
const wire = (messages: Context["messages"]) =>
  convertResponsesMessages(model, { messages }, new Set(["openai"]), replayIdentity);
const replayPressure = (messages: Context["messages"]) =>
  measurePressure(messages, model, replayIdentity, estimator);
function project(source: Context["messages"], windowed: Context["messages"]) {
  return preserveWindow(source, windowed, model, replayIdentity);
}

const text = (value: string) => ({ type: "text" as const, text: value });

type ReplayOwner = AssistantMessage & { providerReplay: ProviderReplayState };
function createAssistant(content: AssistantMessage["content"], replayIndex: number): ReplayOwner {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: createZeroUsage(),
    stopReason: "toolUse",
    timestamp: 0,
    providerReplay: {
      v: 1,
      type: "openai-responses-compaction",
      id: "cmp_replay",
      data: "opaque-replay-compaction",
      replayIndex,
      provider: replayMetadata.provider,
      api: replayMetadata.api,
      model: replayMetadata.model,
      baseUrlHash: replayMetadata.baseUrlHash,
      sessionHash: replayMetadata.sessionHash,
      authProfileHash: replayMetadata.authProfileHash,
    } satisfies ProviderReplayState,
  };
}

function captureWindow(
  owner: AssistantMessage,
  output: OpenAIResponsesCompactionOutput,
  tokens?: number,
) {
  const item = output.at(-1);
  if (!item || item.type !== "compaction") {
    throw new Error("Expected trailing compaction");
  }
  captureCompaction(owner, item, "retained-users", model, replayMetadata, output, tokens);
}

describe("compaction replay owner rewrites", () => {
  it("uses persisted V2 output usage rather than ciphertext length for checkpoint pressure", () => {
    const owner = createAssistant([], 0);
    const item = { type: "compaction" as const, encrypted_content: "opaque".repeat(100_000) };
    captureWindow(
      owner,
      [{ type: "message", role: "user", content: [{ type: "input_text", text: "keep" }] }, item],
      123,
    );
    const serializedOwner = JSON.stringify(owner);
    const restored: AssistantMessage = JSON.parse(serializedOwner);
    const pressure = measurePressure([restored], model, replayIdentity, {
      text: (value) => value.length,
      image: () => 2000,
      json: () => 1,
    });
    // 123 provider output tokens + 4 plaintext chars + three metadata allowances.
    expect(pressure?.prefixTokens).toBe(130);
    expect(pressure?.measuredTokens).toBeUndefined();
  });

  it("invalidates a checkpoint when replacing content in its covered prefix", () => {
    const covered = { type: "text" as const, text: "covered" };
    const suffix = { type: "toolCall" as const, id: "call_1", name: "read", arguments: {} };
    const owner = createAssistant([covered, suffix], 1);
    const rewritten = replaceOwnerContent(owner, [{ ...covered, text: "rewritten" }, suffix]);

    expect(rewritten.providerReplay).toBeUndefined();
    expect(owner.providerReplay?.replayIndex).toBe(1);
  });

  it("keeps a reindexed call paired with its output", () => {
    const toolCall = { type: "toolCall" as const, id: "call_1", name: "read", arguments: {} };
    const owner = createAssistant([{ type: "text", text: "" }, toolCall], 1);
    const reindexed = replaceOwnerContent(owner, [toolCall]);
    const input = wire([reindexed, makeTextToolResult("call_1", "read", "ok", false, 1)]);

    expect(reindexed.providerReplay?.replayIndex).toBe(0);
    expect(input.map((item) => item.type)).toEqual([
      "compaction",
      "function_call",
      "function_call_output",
    ]);
  });

  it("falls back to full history when owner content is emptied", () => {
    const stripped = replaceOwnerContent(createAssistant([text("removed")], 0), []);
    const input = wire([
      { role: "user", content: "full history prefix", timestamp: 1 },
      stripped,
      { role: "user", content: "current turn", timestamp: 2 },
    ]);

    expect(stripped.providerReplay).toBeUndefined();
    expect(input.some((item) => item.type === "compaction")).toBe(false);
    expect(JSON.stringify(input)).toContain("full history prefix");
  });

  it("keeps a compaction-only checkpoint through an unchanged empty-content projection", () => {
    const owner = createAssistant([], 0);
    expect(replaceOwnerContent(owner, []).providerReplay).toBe(owner.providerReplay);
  });

  it("keeps retained-user checkpoints independent of owner content indexes", () => {
    const retained = createAssistant([text("removed owner output")], 0);
    retained.providerReplay = {
      ...retained.providerReplay,
      type: "openai-responses-retained-compaction",
    };
    delete retained.providerReplay.replayIndex;

    const rewritten = replaceOwnerContent(retained, []);

    expect(rewritten.providerReplay).toMatchObject({
      type: "openai-responses-retained-compaction",
      data: "opaque-replay-compaction",
    });
    expect(rewritten.providerReplay).not.toHaveProperty("replayIndex");
  });
});

describe("bounded compaction replay projection", () => {
  const latest: Context["messages"][number] = { role: "user", content: "latest", timestamp: 10 };

  it("projects only the newest evicted owner without old content or source mutation", () => {
    const prelude = { role: "user" as const, content: "covered history prelude", timestamp: 0 };
    const old = createAssistant([text("older owner")], 1);
    captureCompaction(
      old,
      { type: "compaction", encrypted_content: "older opaque state" },
      1,
      model,
      replayMetadata,
    );
    const newest = createAssistant([text("covered owner")], 1);
    const replay = newest.providerReplay;
    const projected = project([prelude, old, newest, latest], [prelude, latest]);
    expect(projected[0]).toMatchObject({ content: [], providerReplay: { replayIndex: 0 } });
    expect(newest.providerReplay).toBe(replay);
    expect(newest.providerReplay?.replayIndex).toBe(1);
    expect(newest.content).toEqual([{ type: "text", text: "covered owner" }]);
    expect(project(projected, projected)).toBe(projected);
    const input = wire(projected);
    expect(input[0]).toMatchObject({
      type: "compaction",
      encrypted_content: "opaque-replay-compaction",
    });
    const pressure = replayPressure(projected);
    expect({
      wireContainsCoveredPrelude: JSON.stringify(input).includes(prelude.content),
      pressureContainsCoveredPrelude: JSON.stringify(pressure?.messages).includes(prelude.content),
    }).toEqual({ wireContainsCoveredPrelude: false, pressureContainsCoveredPrelude: false });
    expect(pressure?.prefixTokens).toBe("opaque-replay-compaction".length);
    expect(projected).toHaveLength(2);
    expect(JSON.stringify(input)).not.toContain("owner");
  });

  it.each(["malformed", "mismatched", "suppressed"])("honors the newest %s barrier", (kind) => {
    const old = createAssistant([], 0);
    const barrier = createAssistant([], 0);
    if (kind === "malformed") {
      barrier.providerReplay = { ...barrier.providerReplay, data: "" };
    } else if (kind === "mismatched") {
      barrier.providerReplay = { ...barrier.providerReplay, model: "different-model" };
    } else {
      suppressCompaction(barrier, model, replayIdentity);
    }
    const windowed = [latest];
    expect(project([old, barrier, latest], windowed)).toBe(windowed);
    expect(replayPressure([old, barrier, latest])).toBeUndefined();
  });

  it("keeps missing retained-user windows as refresh barriers without an invented index", () => {
    const owner = createAssistant([], 0);
    const { replayIndex: _index, ...replay } = owner.providerReplay;
    owner.providerReplay = { ...replay, type: "openai-responses-retained-compaction" };
    const projected = project([owner, latest], [latest]);
    expect(projected[0]).toMatchObject({
      providerReplay: { type: "openai-responses-retained-compaction" },
    });
    expect(projected[0]).not.toHaveProperty("providerReplay.replayIndex");
    expect(requiresRefresh(projected, model, replayIdentity)).toBe(true);
    expect(() => replayPressure(projected)).toThrow(CompactionReplayRefreshRequiredError);
  });

  it.each([
    ["openclaw-anthropic-messages-transport", true, "https://api.anthropic.com/v1"],
    ["anthropic-messages", undefined, model.baseUrl],
  ] as const)("projects %s summaries only with enabled replay: %s", (api, enabled, baseUrl) => {
    const anthropic = { ...model, api, provider: "anthropic", id: "claude-sonnet-4-6", baseUrl };
    const identity = { ...replayIdentity, enabled };
    const owner = createAssistant([text("covered")], 1);
    const capture = createCompactionCapture(owner, anthropic, replayIdentity);
    capture.begin(0, { type: "compaction", content: "complete summary" }, 1);
    capture.complete(0);
    const window = [latest];
    const projected = preserveWindow([owner, latest], window, anthropic, identity);
    if (enabled) {
      const pressure = measurePressure(projected, anthropic, identity, estimator);
      expect(buildAnthropicReplayPlan(projected, anthropic, identity).compaction).toEqual({
        type: "compaction",
        content: "complete summary",
      });
      expect(pressure?.prefixTokens).toBe("complete summary".length);
    } else {
      expect(projected).toBe(window);
      expect(measurePressure([owner, latest], anthropic, identity, estimator)).toBeUndefined();
    }
  });
});

const estimator = {
  text: (value: string) => value.length,
  image: () => 100,
  json: (value: unknown) => JSON.stringify(value).length,
};

describe("prepared compaction replay eligibility", () => {
  const anthropic = {
    ...model,
    api: "anthropic-messages",
    provider: "anthropic",
    id: "claude-sonnet-4-6",
    baseUrl: "https://api.anthropic.com",
  };

  it.each([
    { apiKey: "test-key", extraParams: {}, expected: true },
    { apiKey: "test-sk-ant-oat-fixture", extraParams: {}, expected: false },
  ])(
    "requires known eligible authentication and an enabled model: $expected",
    ({ expected, ...options }) => {
      expect(resolveEligibility(anthropic, options)).toBe(expected);
    },
  );

  it("keeps Responses checkpoint replay independent of new compaction generation", () => {
    expect(resolveEligibility(model, { extraParams: { responsesServerCompaction: false } })).toBe(
      true,
    );
    const owner = createAssistant([], 0);
    expect(
      measurePressure([owner], model, { ...replayIdentity, enabled: false }, estimator),
    ).toBeUndefined();
  });
});

describe("canonical compaction replay pressure", () => {
  it("counts the returned prefix once after restart and an auth A to B to A round trip", () => {
    const owner = createAssistant([text("covered")], 1);
    const output = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "canonical" }] },
      { type: "compaction", encrypted_content: "opaque" },
    ] satisfies OpenAIResponsesCompactionOutput;
    captureWindow(owner, output);
    const later: AssistantMessage = createAssistant([text("later")], 0);
    delete later.providerReplay;
    owner.usage.contextUsage = { state: "available", promptTokens: 90_000, totalTokens: 90_001 };
    later.usage.contextUsage = { state: "available", promptTokens: 2_000, totalTokens: 2_001 };
    const source: Context["messages"] = [
      { role: "user", content: "raw".repeat(100_000), timestamp: 1 },
      owner,
    ];
    const requestB = convertResponsesMessages(model, { messages: source }, new Set(["openai"]), {
      ...replayIdentity,
      authProfileId: "profile-b",
    });
    expect(requestB.some((item) => item.type === "compaction")).toBe(false);
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercise persisted JSON reload, not an in-memory clone.
    const resumed: Context["messages"] = JSON.parse(JSON.stringify([...source, later]));
    expect(wire(resumed).slice(0, output.length)).toEqual(output);
    const plan = replayPressure(resumed);
    expect(plan?.prefixTokens).toBe(89); // 15 text/ciphertext characters + 74 metadata characters.
    expect(plan?.messages).toMatchObject([
      { content: [] },
      { content: later.content, usage: { cost: later.usage.cost } },
    ]);
    expect(plan?.messages[0]).not.toHaveProperty("usage.contextUsage");
    expect(plan?.messages[1]).not.toHaveProperty("usage.contextUsage");
    expect(owner.usage.contextUsage.totalTokens).toBe(90_001);
    expect(later.usage.contextUsage.totalTokens).toBe(2_001);
  });

  it("accounts for image metadata and file data without charging base64 image bytes twice", () => {
    const owner = createAssistant([], 0);
    const image = {
      type: "input_image" as const,
      detail: "high" as const,
      image_url:
        "data:image/jpeg;base64," +
        Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(10_000)]).toString("base64"),
    };
    const remoteImage = { ...image, image_url: "https://media.example/image.png?signature=test" };
    const file = { type: "input_file" as const, file_data: "file-data", filename: "source.txt" };
    const output: OpenAIResponsesCompactionOutput = [
      { type: "message", role: "user", content: [image, remoteImage, file] },
      { type: "compaction", encrypted_content: "opaque" },
    ];
    captureWindow(owner, output);
    expect(replayPressure([owner])?.prefixTokens).toBe(465); // Images + file, URL and metadata.
  });
});
