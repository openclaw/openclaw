import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { publishRuntimeToolInputSchema } from "@openclaw/ai/internal/tool-schema";
import * as cryptoDigest from "@openclaw/normalization-core/node-crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Usage } from "../../llm/types.js";
import { normalizeUsage } from "../usage.js";
import * as promptCacheFacts from "./prompt-cache-facts.js";
import {
  beginPromptCacheObservation,
  collectPromptCacheTools,
  completePromptCacheObservation,
  recordAggregateTruncation,
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
    if (parameters === null || typeof parameters !== "object") {
      throw new Error("Expected published object schema");
    }
    const hashes = vi.spyOn(cryptoDigest, "sha256Hex");
    expect(collectPromptCacheTools([{ name: "read", parameters }])).toEqual(first);
    expect(hashes).not.toHaveBeenCalled();
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

  it("memoizes cycle-safe schemas", () => {
    const parameters: Record<string, unknown> = { type: "object" };
    parameters.self = parameters;
    const digest = vi.spyOn(cryptoDigest, "sha256Hex");
    const first = collectPromptCacheTools([{ name: "read", parameters }]);
    expect(first).toHaveLength(1);
    expect(collectPromptCacheTools([{ name: "read", parameters }])).toEqual(first);
    expect(digest).toHaveBeenCalledTimes(1);
  });

  it("fingerprints complete schemas independently of property insertion order", () => {
    const collect = (parameters: object) => collectPromptCacheTools([{ name: "read", parameters }]);
    expect(collect({ type: "object", properties: { a: {}, b: {} } })).toEqual(
      collect({ properties: { b: {}, a: {} }, type: "object" }),
    );
  });

  it("suppresses cache-break events for small drops", () => {
    const { begin, complete } = observation("small-drop", beginAnthropicObservation);
    begin();
    complete(5_000);
    begin();
    expect(complete(4_600)).toBeNull();
  });

  it("treats reordered tool lists as the same diagnostics tool set", () => {
    const { begin, complete } = observation("tool-order");
    begin({ tools: [{ name: "read" }, { name: "write" }] });
    complete(8_000);
    expect(begin({ tools: [{ name: "write" }, { name: "read" }] }).changes).toBeNull();
  });

  it.each([
    ["## Skills", "Skills"],
    ["# Project Context\n## MEMORY.md\n## Skills", "Project Context"],
  ])("attributes prefix changes in %s to %s", (heading, section) => {
    const { begin, complete } = observation("changed-prompt-section");
    const prompt = (content: string) =>
      `${heading}\n${content}\n${SYSTEM_PROMPT_CACHE_BOUNDARY}stable suffix`;
    begin({ systemPrompt: prompt("private-content-before") });
    complete(8_000);
    begin({ systemPrompt: prompt("private-content-after") });
    expect(complete(2_000)?.changes).toEqual([
      { code: "systemPrompt", detail: `system prompt digest changed (sections: ${section})` },
    ]);
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

  it("reuses section digests when only the other side of the cache boundary changes", () => {
    const { begin } = observation("reused-prompt-sections");
    const hashes = vi.spyOn(cryptoDigest, "sha256Hex");
    const prefix = "## Skills\nlarge-skill-catalog\n## Tooling\ntool descriptions\n";
    const suffix = "## Runtime\nreasoning=off\n";
    const observe = (stable: string, dynamic: string) =>
      begin({
        systemPrompt: `${stable}${SYSTEM_PROMPT_CACHE_BOUNDARY}${dynamic}`,
      });
    const first = observe(prefix, suffix);
    expect(observe(prefix, suffix).changes).toBeNull();
    const second = observe(prefix, `${suffix}new runtime fact\n`);
    expect(second.snapshot.systemPromptSections).toEqual(first.snapshot.systemPromptSections);
    expect(
      hashes.mock.calls.filter(([value]) => value === "## Skills\nlarge-skill-catalog\n"),
    ).toHaveLength(1);
    expect(second.changes).toEqual([
      {
        code: "systemPromptSuffix",
        detail: "system prompt suffix digest changed (sections: Runtime)",
      },
    ]);
  });

  it.each([
    [{ parameters: { type: "number" } }, "schema: tool[1]"],
    [
      { description: "Read a workspace file" },
      "description: tool[1]; facts: tool[1].description.line[1] changed",
    ],
    [{ name: "write" }, "added: tool[1]; removed: tool[1]"],
  ])("attributes tool changes (%j)", (override, detail) => {
    const { begin, complete } = observation("changed-tool-schema");
    const tool = {
      name: "read",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    };
    begin({ tools: collectPromptCacheTools([tool]) });
    complete(8_000);
    begin({ tools: collectPromptCacheTools([{ ...tool, ...override }]) });
    expect(complete(0)).toEqual({
      previousCacheRead: 8_000,
      cacheRead: 0,
      changes: [{ code: "tools", detail: `1 -> 1 tools; ${detail}` }],
    });
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

    cleanupSessionResources();
    expect(beginOpenAIObservation(retained).previousCacheRead).toBeNull();
  });

  it("evicts old tracker entries when the tracker map grows past the soft cap", () => {
    seedObservation({ sessionId: scopedKey("session-0") });

    for (let index = 1; index <= 513; index += 1) {
      beginOpenAIObservation({
        sessionId: scopedKey(`session-${index}`),
        systemPrompt: `stable system ${index}`,
      });
    }

    expect(beginOpenAIObservation({ sessionId: scopedKey("session-0") })).toMatchObject({
      previousCacheRead: null,
      changes: null,
    });
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
