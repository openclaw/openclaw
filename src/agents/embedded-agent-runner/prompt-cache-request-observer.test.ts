import { hash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runNodeScript } from "../../../test/helpers/run-node-script.js";
import { createPromptCacheRequestObserver } from "./prompt-cache-request-observer.js";
import { prepareProviderPrompt } from "./provider-prompt-serialization.js";

let testScope = 0;
let currentTestScope = "";
const model = { provider: "openai", id: "test-model", api: "openai-responses" } as const;

function createObserver(
  sessionId: string,
  onObservation: Parameters<typeof createPromptCacheRequestObserver>[1] = () => {},
  promptCacheKey?: string,
) {
  return createPromptCacheRequestObserver(
    { sessionId, promptCacheKey, streamStrategy: "test" },
    onObservation,
  );
}

type Observer = ReturnType<typeof createObserver>;
const requestContext = (observer: Observer, systemPrompt = "original system") =>
  observer.onModelRequest(model, { systemPrompt, messages: [] });

const inputChange = (fields: Record<string, unknown>) => ({
  input: [{ role: "user", content: "first", ...fields }],
});

function scopedKey(value: string): string {
  return `request-observer:${value}:${currentTestScope}`;
}

function fingerprint(payload: unknown) {
  const { encoded: _encoded, ...result } = prepareProviderPrompt({ payload, encode: true });
  expect(JSON.stringify(result)).not.toContain("private");
  return { scopeDigest: "same-scope", ...result };
}

async function measure(observer: Observer, body: unknown, cacheRead?: number) {
  await requestContext(observer);
  observer.onModelUsage(
    cacheRead === undefined
      ? undefined
      : {
          cacheRead,
          contextUsage: { state: "available", promptTokens: 10_000, totalTokens: 10_100 },
        },
    fingerprint(body),
    { responseId: "resp-cache-fixture" },
  );
  return observer.getObservation();
}

describe("prompt cache request observer", () => {
  beforeEach(() => {
    currentTestScope = String(++testScope);
  });
  afterEach(() => vi.restoreAllMocks());

  it("pairs a drop with the last measured wire request across missing usage and run boundaries", async () => {
    const sessionId = scopedKey("wire-pair");
    const request = (key: string, cacheRead?: number) =>
      measure(
        createObserver(sessionId),
        {
          prompt_cache_key: key,
          previous_response_id: "private-response",
          input: [],
        },
        cacheRead,
      );
    expect((await request("private-first", 9_000))?.broke).toBe(false);
    await request("private-unmeasured");
    const dropped = await request("private-final", 2_000);
    expect(dropped).toMatchObject({
      broke: true,
      requests: {
        previous: {
          cacheKeyPresent: true,
          cacheKeyHash: hash("sha256", '"private-first"').slice(0, 16),
        },
        current: {
          cacheKeyPresent: true,
          cacheKeyHash: hash("sha256", '"private-final"').slice(0, 16),
        },
      },
    });
    expect(JSON.stringify(dropped)).not.toContain("private-");
    expect((await request("private-first", 0))?.requests?.previous?.cacheKeyHash).toBe(
      dropped?.requests?.current?.cacheKeyHash,
    );
  });

  it("keeps concurrent review and foreground usage in their own diagnostic sessions", async () => {
    const promptCacheKey = scopedKey("shared-provider-affinity");
    const foreground = createObserver(scopedKey("foreground"), undefined, promptCacheKey);
    const review = createObserver(scopedKey("review"), undefined, promptCacheKey);
    await requestContext(review, "stable");
    await requestContext(foreground, "stable");
    foreground.onModelUsage({ cacheRead: 9_000 });
    review.onModelUsage({ cacheRead: 0, input: 1_000 });
    expect(review.getObservation()).toMatchObject({ broke: false });
    await requestContext(foreground, "stable");
    foreground.onModelUsage({ cacheRead: 2_000 });
    expect(foreground.getObservation()).toMatchObject({
      broke: true,
      previousCacheRead: 9_000,
      cacheRead: 2_000,
      dropCause: "unattributed:provider-prompt-unavailable",
    });
  });

  it("retains the input change when a request has no usage callback", async () => {
    const observer = createObserver(scopedKey("unfinished-request"));
    await requestContext(observer, "before");
    observer.onModelUsage({ cacheRead: 8_000 });
    await requestContext(observer, "after");
    await requestContext(observer, "after");
    observer.onModelUsage({ cacheRead: 2_000 });
    expect(observer.getObservation()).toMatchObject({
      broke: true,
      dropCause: "tracked-input-change",
      changes: [{ code: "systemPrompt", detail: "system prompt digest changed" }],
    });
  });

  it.each([
    ["system", { instructions: "provider rewritten system" }, "provider-input-change:system"],
    ["tools", { tools: [{ type: "function", name: "changed" }] }],
    ["message:0.content", inputChange({ content: "private rewritten history" })],
    ["message:0.encrypted_content", inputChange({ encrypted_content: "private-ciphertext" })],
    ["message:0.order", { input: [{ content: "first", role: "user" }] }],
    ["message:0.other", inputChange({ "private-field-name": "private-value" })],
    ["message:0.removed", { input: [] }],
    ["parameters:service_tier", { service_tier: "default" }],
    ["parameters:other", { "private-parameter-name": "private-value" }],
    [
      "continuation:parameters:previous_response_id",
      { previous_response_id: "private-response" },
      "unattributed:continuation-wire-input",
    ],
    [
      "continuation:wire-input:0.content,parameters:previous_response_id",
      {
        previous_response_id: "private-response",
        input: [{ role: "user", content: "private-delta" }],
      },
    ],
    [
      "prefix-match",
      {
        input: [
          { role: "user", content: "first" },
          { role: "user", content: "appended" },
        ],
      },
      "provider-cache-reuse-lost:unchanged-prefix",
    ],
  ] as const)(
    "identifies final encoded %s changes despite unchanged assembled context",
    async (expected, replacement, dropCause?: string) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const observer = createObserver(scopedKey(`wire-${expected}`));
      const payload = {
        instructions: "original system",
        tools: [{ type: "function", name: "read" }],
        input: [{ role: "user", content: "first" }],
      };
      await measure(observer, payload, 9_000);
      clock.mockReturnValue(3_000);
      const observation = await measure(observer, { ...payload, ...replacement }, 2_000);
      expect(observation).toMatchObject({
        broke: true,
        changes: null,
        providerPrefix: expected,
        requestGapMs: 2_000,
        promptTokens: 10_000,
        responseId: "resp-cache-fixture",
      });
      if (dropCause) {
        expect(observation?.dropCause).toBe(dropCause);
      }
      if (expected === "parameters:service_tier") {
        expect(observation?.requests?.current?.serviceTier).toBe("default");
      }
      expect(JSON.stringify(observation)).not.toContain("private");
    },
  );

  it("observes a miss and subsequent hits with per-turn request indices", async () => {
    const turns = [[10_000], [0, 10_000, 10_000]];
    const sessionId = scopedKey("request-usage");
    const observed: Array<{ request: string; cacheRead: number | undefined; broke: boolean }> = [];
    for (const [turnIndex, reads] of turns.entries()) {
      const observer = createPromptCacheRequestObserver(
        { sessionId, streamStrategy: "test" },
        (observation) =>
          observed.push({
            request: `${turnIndex + 1}:${observation.requestIndex}`,
            cacheRead: observation.cacheRead,
            broke: observation.broke,
          }),
      );
      for (const cacheRead of reads) {
        await requestContext(observer, "stable prefix");
        observer.onModelUsage({ input: 10_000 - cacheRead, cacheRead, cacheWrite: 0 });
      }
    }
    expect(observed.map((entry) => entry.cacheRead)).toEqual(turns.flat());
    expect(observed.filter((entry) => entry.broke).map((entry) => entry.request)).toEqual(["2:1"]);
  });
});

it("bounds diagnostic retention for resident hydrated histories across requests", async ({
  signal,
}) => {
  const result = await runNodeScript(
    [
      "--expose-gc",
      "--import",
      "./scripts/tsx.mjs",
      "scripts/perf/prompt-cache-observation-measure.ts",
      "--sessions",
      "4",
      "--messages",
      "512",
      "--rounds",
      "20",
    ],
    process.env,
    undefined,
    { cwd: fileURLToPath(new URL("../../../", import.meta.url)), signal },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  const measured = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as {
    retainedFirst: number;
    retainedFinal: number;
    residentMessages: number;
    sessionCount: number;
  };
  // Full diagnostic hashes fit within 1 KiB/message; revision maps do not.
  expect(measured.retainedFinal).toBeLessThan(measured.residentMessages * 1024 + 128 * 1024);
  // Re-observing the resident window must replace, rather than accumulate, baselines.
  expect(measured.retainedFinal - measured.retainedFirst).toBeLessThan(
    measured.sessionCount * 64 * 1024,
  );
});
