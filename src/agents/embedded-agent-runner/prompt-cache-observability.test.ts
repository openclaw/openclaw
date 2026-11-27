import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { publishRuntimeToolInputSchema } from "@openclaw/ai/internal/tool-schema";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import type { Usage } from "../../llm/types.js";
import { expectCollected } from "../../test-utils/retention.js";
import {
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "../test-helpers/agent-message-fixtures.js";
import { normalizeUsage } from "../usage.js";
import { log } from "./logger.js";
import * as promptCacheFacts from "./prompt-cache-facts.js";
import {
  collectPromptCacheTools,
  completePromptCacheObservation,
  declarePromptSystemPromptRebuild,
  recordAggregateTruncation,
  recordRuntimeContextProjection,
} from "./prompt-cache-observability.js";
import {
  beginAnthropicObservation,
  beginOpenAIObservation,
} from "./prompt-cache-observability.test-support.js";
import { createPromptCacheRequestObserver } from "./prompt-cache-request-observer.js";
import { prepareProviderPrompt } from "./provider-prompt-serialization.js";
import {
  prepareSessionSystemPrompt,
  retainEmbeddedSessionPromptState,
} from "./session-prompt-state.js";

// These tests change the prefix on purpose to exercise the production drop diagnostics and
// warnings; the suite-wide prefix assertion stays on only where a test opts in.
beforeEach(() => {
  vi.stubEnv("OPENCLAW_PROMPT_CACHE_ASSERT", "0");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

let testScope = 0;

function scopedKey(value: string): string {
  return `${value}:${testScope}`;
}

function observation(name: string, begin = beginOpenAIObservation) {
  const sessionId = scopedKey(name);
  return {
    sessionId,
    begin: (params: Omit<Parameters<typeof begin>[0], "sessionId"> = {}) =>
      begin({ sessionId, ...params }),
    complete: (cacheRead: number) =>
      completePromptCacheObservation({ sessionId, usage: { cacheRead } }),
  };
}

function seedObservation(params: Parameters<typeof beginOpenAIObservation>[0], cacheRead = 8_000) {
  beginOpenAIObservation(params);
  completePromptCacheObservation({ ...params, usage: { cacheRead } });
}

describe("prompt cache observability", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports the bounded personal-profile restart reason and subsequent pinned reuse on drops", async () => {
    const sessionId = scopedKey("personal-profile-series");
    using lease = retainEmbeddedSessionPromptState(sessionId);
    const model = { provider: "openai", id: "gpt-5.4", api: "openai-responses" as const };
    let status: ReturnType<typeof prepareSessionSystemPrompt>["seriesStatus"];
    const observer = createPromptCacheRequestObserver(
      { sessionId, streamStrategy: "test", getSystemPromptSeries: () => status },
      () => {},
    );
    for (const [profile, cacheRead, expected] of [
      ["selected-human", 10_000, "restarted:new"],
      [undefined, 7_000, "restarted:route:personalProfile"],
      [undefined, 3_000, "pinned"],
    ] as const) {
      const prepared = prepareSessionSystemPrompt({
        state: lease.state,
        routeKey: JSON.stringify([model.provider, model.id, model.api, null, true, profile]),
        systemPrompt: "Synthetic instructions",
        entries: [],
      });
      status = prepared.seriesStatus;
      prepared.commit();
      await observer.onModelRequest(model, { systemPrompt: prepared.systemPrompt, messages: [] });
      observer.onModelUsage({ cacheRead });
      expect(observer.getObservation()).toMatchObject({
        broke: cacheRead < 10_000,
        systemPromptSeries: expected,
      });
      expect(JSON.stringify(observer.getObservation())).not.toContain("selected-human");
    }
  });

  it("attributes the request after a provider compaction checkpoint to compaction", async () => {
    const observer = createPromptCacheRequestObserver(
      { sessionId: scopedKey("provider-compaction"), streamStrategy: "test" },
      () => {},
    );
    const model = { provider: "openai", id: "gpt-5.4", api: "openai-responses" as const };
    const user = makeAgentUserMessage({ content: "run the probe" });
    const checkpoint = makeAgentAssistantMessage({
      content: [{ type: "text", text: "compacted" }],
      providerReplay: {
        v: 1,
        type: "openai-responses-compaction",
        id: "cmp_1",
        data: "encrypted",
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.4",
      },
    });
    const next = makeAgentUserMessage({ content: "continue", timestamp: 1 });
    const later = makeAgentUserMessage({ content: "again", timestamp: 2 });
    const requests = [[user], [user, checkpoint, next], [user, checkpoint, next, later]];
    const causes = [];
    for (const [index, messages] of requests.entries()) {
      await observer.onModelRequest(model, { systemPrompt: "stable", messages });
      observer.onModelUsage({ cacheRead: [40_000, 2_000, 0][index]!, input: 10 });
      const { dropCause, changes } = observer.getObservation()!;
      causes.push([dropCause, changes?.map(({ code }) => code) ?? null]);
    }
    // The checkpoint request is a compaction rebuild; a later drop is not attributed to it.
    expect(causes).toEqual([
      [undefined, null],
      ["tracked-input-change", ["compaction"]],
      ["unattributed:provider-prompt-unavailable", null],
    ]);
  });

  it("bounds field details while detecting later item and tail changes", () => {
    const identity = { sessionId: scopedKey("bounded-wire-tail") };
    const message = { role: "user", content: "synthetic history" };
    const input = Array.from({ length: 513 }, () => message);
    const complete = (cacheRead: number) => {
      beginOpenAIObservation(identity);
      const { encoded: _encoded, ...fingerprint } = prepareProviderPrompt({
        payload: { input },
        encode: true,
      });
      return completePromptCacheObservation({
        ...identity,
        usage: { cacheRead },
        providerPrompt: { scopeDigest: "same-provider-scope", ...fingerprint },
      });
    };
    complete(15_000);
    input[31] = { ...message, content: "changed detailed item" };
    expect(complete(12_000)?.providerPrefix).toBe("message:31.content");
    input[32] = { ...message, content: "changed item beyond field limit" };
    expect(complete(9_000)?.providerPrefix).toBe("message:32");
    input.push(message);
    expect(complete(6_000)?.providerPrefix).toBe("unverified-after:512");
    input[513] = { ...message, content: "changed tail" };
    expect(complete(3_000)?.providerPrefix).toBe("message-tail:512");
    input.length = 31;
    expect(complete(0)?.providerPrefix).toBe("message:31.removed");
  });

  beforeEach(() => {
    testScope += 1;
  });

  it.each([false, true])(
    "keeps small complete misses tied to the last reported fingerprint (changed=%s)",
    (changed) => {
      const { sessionId, begin: start } = observation(
        "small-cache-miss",
        beginAnthropicObservation,
      );
      const begin = (systemPrompt: string) => start({ systemPrompt, tools: [] });
      begin("prefix A");
      completePromptCacheObservation({ sessionId, usage: { cacheRead: 500 } });
      if (changed) {
        begin("prefix B");
        completePromptCacheObservation({ sessionId });
      }
      recordAggregateTruncation({ sessionId });
      begin(changed ? "prefix B" : "prefix A");
      const result = completePromptCacheObservation({
        sessionId,
        usage: { input: 500, cacheRead: 0 },
      });
      if (changed) {
        expect(result).toBeNull();
      } else {
        expect(result).toMatchObject({
          previousCacheRead: 500,
          cacheRead: 0,
          changes: [{ code: "aggregateToolResultTruncation" }],
        });
      }
    },
  );

  it.each(["name", "parameters"])("collects canonical tools and skips unreadable %s", (field) => {
    const unreadableTool = Object.defineProperty({ name: "unreadable" }, field, {
      get() {
        throw new Error("unreadable descriptor");
      },
    });
    const candidates = [{ name: "write" }, { name: "" }, {}, unreadableTool, { name: " read " }];
    expect(collectPromptCacheTools(candidates)).toEqual([{ name: "read" }, { name: "write" }]);
  });

  it("preserves canonical schema identity when descriptors become published", () => {
    const source = {
      type: "object",
      properties: {
        path: { type: "string", description: "published-schema-fixture" },
      },
    };
    const first = collectPromptCacheTools([{ name: "read", parameters: source }]);
    const parameters = publishRuntimeToolInputSchema(source).schema;
    assert(parameters !== null && typeof parameters === "object");
    expect(collectPromptCacheTools([{ name: "read", parameters }])).toEqual(first);
  });

  it("fingerprints own __proto__ schema properties without prototype pollution", () => {
    const collectSchema = (properties: Record<string, unknown>) =>
      collectPromptCacheTools([{ name: "read", parameters: { type: "object", properties } }]);
    const stringPrototype = collectSchema({ ["__proto__"]: { type: "string" } });
    const numberPrototype = collectSchema({ ["__proto__"]: { type: "number" } });
    const noPrototype = collectSchema({});

    expect(stringPrototype[0]?.schemaDigest).not.toBe(numberPrototype[0]?.schemaDigest);
    expect(stringPrototype[0]?.schemaDigest).not.toBe(noPrototype[0]?.schemaDigest);
    expect(numberPrototype[0]?.schemaDigest).not.toBe(noPrototype[0]?.schemaDigest);
  });

  it("handles cycle-safe schemas", () => {
    const parameters: Record<string, unknown> = { type: "object" };
    parameters.self = parameters;
    const first = collectPromptCacheTools([{ name: "read", parameters }]);
    expect(first).toHaveLength(1);
  });

  it("fingerprints complete schemas independently of property insertion order", () => {
    const collect = (parameters: object) => collectPromptCacheTools([{ name: "read", parameters }]);
    expect(collect({ type: "object", properties: { a: {}, b: {} } })).toEqual(
      collect({ properties: { b: {}, a: {} }, type: "object" }),
    );
  });

  it.each([
    ["Runtime", "Runtime: model=private-a", "Runtime: model=private-b", "model"],
    ["Runtime", "private-a", "private-b", "line[1]"],
    [
      "Session routing",
      "- Actual delegated helpers use `private-a`",
      "- Actual delegated helpers use `private-b`",
      "hidden delegation",
    ],
    [
      "Tooling",
      "- private-a: Read\n- private-b: Write",
      "- private-b: Write\n- private-a: Read",
      "tool list order",
    ],
    ["Tooling", "- read: private-a", "- read: private-b", "tool summaries"],
    ["Conversation Context", "private-a", "private-b", "line[1]"],
    ["Knowledge Index", "private-a", "private-b", "line[1]"],
  ])(
    "names changed %s facts only on drops without exposing content",
    (section, before, after, fact) => {
      const { begin, complete } = observation("changed-prompt-fact");
      const prompt = (body: string) =>
        `${"stable ".repeat(10_000)}${SYSTEM_PROMPT_CACHE_BOUNDARY}## ${section}\n${body}\n`;
      begin({ systemPrompt: prompt(before) });
      complete(8_000);
      const facts = vi.spyOn(promptCacheFacts, "describePromptCacheSectionChanges");
      const started = begin({ systemPrompt: prompt(after) });
      expect(facts).not.toHaveBeenCalled();
      expect(JSON.stringify(started)).not.toContain("private-");
      const result = complete(2_000);
      expect(result?.changes?.[0]?.detail).toContain(`facts: ${section}.${fact} changed`);
      expect(facts).toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain("private-");
    },
  );

  it("attributes computer capability clauses and bounds oversized before-images", () => {
    const { begin, complete } = observation("computer-facts");
    const tools = (window: string) =>
      collectPromptCacheTools([
        {
          name: "computer",
          description: `Control this session's desktop. Observe first with \`get_window_state\` and ground on its advertised ${window} data. Target order: elementRef.`,
        },
      ]);
    begin({ tools: tools("private-before") });
    complete(8_000);
    begin({ tools: tools("private-after") });
    const result = complete(2_000);
    expect(result?.changes?.[0]?.detail).toContain(
      "computer.description.window observation changed",
    );
    expect(JSON.stringify(result)).not.toContain("private-");
    const prompt = (revision: string) =>
      `stable${SYSTEM_PROMPT_CACHE_BOUNDARY}## Runtime\nprivate-${"x".repeat(33_000)}${revision}`;
    begin({ systemPrompt: prompt("before") });
    complete(8_000);
    begin({ systemPrompt: prompt("after") });
    expect(complete(2_000)?.changes?.[0]?.detail).toContain(
      "facts: unavailable (source size bound)",
    );
  });

  it("uses bounded positions for unrecognized headings without exposing text", () => {
    const { begin } = observation("bounded-prompt-sections");
    const unknown = Array.from(
      { length: 100 },
      (_, index) => `## heading-${index}\nprivate-content-${index}`,
    ).join("\n");
    const first = begin({
      systemPrompt: `${unknown}\n## Skills\nprivate-skill\n`,
    });
    const keys = Object.keys(first.snapshot.systemPromptSections ?? {});
    expect(keys).toHaveLength(50);
    expect(keys.slice(0, 2)).toEqual(["section[1]", "section[2]"]);
    expect(keys.slice(-2)).toEqual(["Other", "Skills"]);
    const changed = begin({
      systemPrompt: `${unknown.replace("private-content-0", "private-replaced")}\n## Skills\nprivate-skill\n`,
    });
    expect(changed.changes).toEqual([
      { code: "systemPrompt", detail: "system prompt digest changed (sections: section[1])" },
    ]);
    expect(JSON.stringify([first.snapshot, changed])).not.toContain("private-");
  });

  it("names the unrecognized suffix sections that changed or disappeared", () => {
    const { begin } = observation("named-suffix-sections");
    const observe = (dynamic: string) =>
      begin({
        systemPrompt: `stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}${dynamic}`,
      });
    const runtime = "## Runtime\nchannel=webchat\n";
    observe(`## Silent Replies\nreply NO_REPLY\n## Control UI Embed\nembeds\n${runtime}`);
    expect(observe(`## Silent Replies\nreply quietly\n${runtime}`).changes).toEqual([
      {
        code: "systemPromptSuffix",
        detail: "system prompt suffix digest changed (sections: Silent Replies, Control UI Embed)",
      },
    ]);
    const many = Array.from({ length: 10 }, (_, index) => `## Extra ${index}\nx\n`).join("");
    expect(observe(`${many}${runtime}`).changes?.[0]?.detail).toBe(
      "system prompt suffix digest changed (sections: section[1], section[2], section[3], section[4], section[5], section[6], section[7], section[8], +3 more)",
    );
  });

  it("bounds tool positions without exposing names or descriptor content", () => {
    const { begin } = observation("bounded-tool-change");
    begin({ tools: [] });
    const next = begin({
      tools: collectPromptCacheTools(
        Array.from({ length: 6 }, (_, index) => ({
          name: `${index}\n${"x".repeat(500)}`,
          description: "private descriptor",
        })),
      ),
    });
    const detail = next.changes?.[0]?.detail ?? "";
    expect(detail).toContain("added: tool[1]");
    expect(detail).not.toContain("xxx");
    expect(detail).toContain("(+1 more)");
    expect(detail).not.toContain("\n");
    expect(detail).not.toContain("private descriptor");
    expect(detail.length).toBeLessThan(500);
  });

  it("isolates removal baselines across affinities, retirement and eviction without retaining payloads", async () => {
    vi.stubEnv("OPENCLAW_PROMPT_CACHE_ASSERT", "1");
    const primary = { sessionId: scopedKey("removal-owner"), promptCacheKey: "primary" };
    const identities = [
      primary,
      { ...primary, promptCacheKey: "secondary" },
      { sessionId: scopedKey("other-removal-owner"), promptCacheKey: "primary" },
    ];
    const project = (text: string, removedAt: number) => {
      const message = makeAgentUserMessage({ content: text, timestamp: 1 });
      const messages = [message];
      recordRuntimeContextProjection(
        [makeAgentUserMessage({ content: "removed carrier", timestamp: removedAt })],
        messages,
      );
      return { message, messages };
    };
    const observe = (identity: (typeof identities)[number], text: string, removedAt: number) =>
      beginOpenAIObservation({ ...identity, messages: project(text, removedAt).messages });
    for (const [index, identity] of identities.entries()) {
      expect(observe(identity, "original", index).changes).toBeNull();
    }
    for (const [index, identity] of identities.entries()) {
      expect(observe(identity, "original", index).changes).toBeNull();
      expect(() => observe(identity, "unrelated edit", index)).toThrow("historyRewrite");
    }
    cleanupSessionResources(primary.sessionId);
    expect(observe(primary, "reset baseline", 10).changes).toBeNull();
    expect(() => observe(primary, "edit after reset", 10)).toThrow("historyRewrite");
    for (let index = 0; index < 513; index++) {
      beginOpenAIObservation({ sessionId: scopedKey(`removal-pressure-${index}`) });
    }
    expect(observe(primary, "evicted baseline", 20).changes).toBeNull();
    expect(() => observe(primary, "edit after eviction", 20)).toThrow("historyRewrite");
    const refs = (() => {
      const { message, messages } = project("disposable request payload".repeat(1024), 30);
      beginOpenAIObservation({ sessionId: scopedKey("removal-retention"), messages });
      return [new WeakRef(message), new WeakRef(messages)];
    })();
    await expectCollected(...refs);
  });

  it("clears every retired session affinity while preserving other sessions until global cleanup", () => {
    const retiredSessionId = scopedKey("retired-session");
    const retired = ["primary", "secondary"].map((affinity) => ({
      sessionId: retiredSessionId,
      promptCacheKey: scopedKey(affinity),
    }));
    const retained = {
      sessionId: scopedKey("retained-session"),
      promptCacheKey: retired[0]!.promptCacheKey,
    };
    for (const identity of [...retired, retained]) {
      seedObservation(identity);
    }
    cleanupSessionResources(retiredSessionId);
    for (const identity of retired) {
      expect(beginOpenAIObservation(identity)).toMatchObject({
        previousCacheRead: null,
        prefixUnchanged: false,
      });
    }
    expect(beginOpenAIObservation(retained).previousCacheRead).toBe(8_000);

    for (let index = 0; index < 513; index++) {
      beginOpenAIObservation({ sessionId: scopedKey(`tracker-pressure-${index}`) });
    }
    expect(beginOpenAIObservation(retained)).toMatchObject({
      previousCacheRead: null,
      changes: null,
    });

    seedObservation(retained);
    expect(beginOpenAIObservation(retained).previousCacheRead).toBe(8_000);
    cleanupSessionResources();
    expect(beginOpenAIObservation(retained).previousCacheRead).toBeNull();
  });

  it("enforces only the immediate prefix change after an unmeasured rebuild", () => {
    vi.stubEnv("OPENCLAW_PROMPT_CACHE_ASSERT", "1");
    const identity = { sessionId: scopedKey("rebuild-unmeasured") };
    const begin = (systemPrompt: string) =>
      beginAnthropicObservation({ ...identity, systemPrompt });
    begin("prompt A");
    declarePromptSystemPromptRebuild(identity);
    begin("prompt B");
    completePromptCacheObservation(identity);
    expect(() => begin("prompt B")).not.toThrow();
    expect(() => begin("prompt C")).toThrow("systemPrompt(");
  });

  it.each([
    undefined,
    {
      input: 10_000,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      cacheTelemetry: { state: "unavailable" },
    } satisfies Partial<Usage>,
  ])(
    "preserves the measured cache baseline across unavailable telemetry: %j",
    async (missingUsage) => {
      const sessionId = scopedKey("missing-cache-telemetry");
      const observe = async (usage: Partial<Usage> | undefined, changed: boolean) => {
        const observer = createPromptCacheRequestObserver(
          {
            sessionId,
            sessionKey: scopedKey("agent:main"),
            streamStrategy: "test",
            cacheRetention: changed ? "short" : "long",
            transport: changed ? "websocket" : "sse",
          },
          () => {},
        );
        await observer.onModelRequest(
          { provider: "ollama", id: "local-model", api: "ollama" },
          { systemPrompt: changed ? "changed prefix" : "stable prefix", messages: [] },
        );
        observer.onModelUsage(normalizeUsage(usage));
        return observer.getObservation();
      };

      expect(await observe({ cacheRead: 8_000 }, false)).toMatchObject({
        broke: false,
        changes: null,
      });
      expect(await observe(missingUsage, true)).toMatchObject({
        broke: false,
        cacheRead: undefined,
        cacheWrite: undefined,
      });
      await observe(missingUsage, true);
      expect(await observe({ cacheRead: 2_000 }, true)).toMatchObject({
        broke: true,
        previousCacheRead: 8_000,
        cacheRead: 2_000,
        changes: [
          { code: "cacheRetention", detail: "long -> short" },
          { code: "transport", detail: "sse -> websocket" },
          { code: "systemPrompt", detail: "system prompt digest changed" },
        ],
      });
      expect(await observe({ input: 10_000, cacheRead: 0 }, true)).toMatchObject({
        broke: true,
        previousCacheRead: 2_000,
        cacheRead: 0,
        changes: null,
      });
    },
  );
});

it("names added, changed, and removed extension keys without exposing values", () => {
  const sessionId = scopedKey("reasoning-fields");
  const block = {
    type: "thinking" as const,
    thinking: "private reasoning",
    thinkingSignature: "private original signature",
    changedBlock: "private original block value",
    removedBlock: "private removed block value",
  };
  const message = {
    ...makeAgentAssistantMessage({ content: [block] }),
    changedEnvelope: "private original envelope value",
    removedEnvelope: "private removed envelope value",
  };
  using warn = vi.spyOn(log, "warn").mockImplementation(() => {});
  beginOpenAIObservation({ sessionId, messages: [message] });
  block.thinkingSignature = "private rewritten signature";
  block.changedBlock = "private rewritten block value";
  Reflect.deleteProperty(block, "removedBlock");
  Object.assign(block, { addedBlock: "private added block value" });
  message.changedEnvelope = "private rewritten envelope value";
  Reflect.deleteProperty(message, "removedEnvelope");
  Object.assign(message, { addedEnvelope: "private added envelope value" });
  const changes = beginOpenAIObservation({ sessionId, messages: [message] }).changes;
  expect(changes).toEqual([
    {
      code: "historyRewrite",
      detail:
        'message 0 (assistant) differs from the previous request; history must be append-only; changed fields: content[0].thinkingSignature, content[0].other["changedBlock"], content[0].other["removedBlock"], content[0].other["addedBlock"], envelope.other["changedEnvelope"], envelope.other["removedEnvelope"], envelope.other["addedEnvelope"]',
    },
  ]);
  expect(JSON.stringify(changes)).not.toContain("private");
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining('content[0].other["removedBlock"]'),
  );
  expect(JSON.stringify(warn.mock.calls)).not.toContain("private");
});
