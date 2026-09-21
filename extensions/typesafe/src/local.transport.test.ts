import assert from "node:assert/strict";
import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import type { DecisionProviderV1 } from "openclaw/plugin-sdk/decisions";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import plugin from "../index.js";
import { evaluate } from "./client.js";
import { runtimeConfig } from "./config.js";
import type { EvaluationInput } from "./schema.js";

vi.mock("openclaw/plugin-sdk/secret-input-runtime", () => ({
  getPreparedPluginSecretInput: vi.fn(),
}));
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return { ...actual, lookup: vi.fn(actual.lookup) };
});

const baseUrl = "http://127.0.0.1:8009";
const input = {
  state: { message: "Synthetic outage" },
  questions: {
    c: { type: "choice", criteria: { support: "Service outages", sales: null } },
    s: { type: "score", criteria: [null, { impact: ["widespread", true, 2] }] },
    b: { type: "noul", instructions: { question: "Escalate?" } },
  },
} satisfies EvaluationInput;
const localAnswer = {
  model: "kev-latest",
  answers: {
    c: {
      type: "choice",
      choice: "support",
      confidence: 0.8,
      probabilities: { support: 0.9, sales: 0.1 },
    },
    s: {
      type: "score",
      score: 0.8,
      confidence: 0.8,
      probabilities: { 0: 0.2, 1: 0.8 },
      legend: { 0: "", 1: '{"impact":["widespread",true,2]}' },
    },
    b: { type: "noul", noul: 0.75 },
  },
  usage: { input_tokens: 30, output_tokens: 12 },
  latency_ms: 15.7,
};

beforeEach(() => {
  vi.mocked(getPreparedPluginSecretInput).mockReset();
  vi.mocked(getPreparedPluginSecretInput).mockReturnValue({ revision: 1, value: "hosted-secret" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.mocked(lookup).mockReset();
});

it("runs the registered tool and decision provider locally without reading hosted credentials", async () => {
  const fetch = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(localAnswer)),
  );
  vi.stubGlobal("fetch", fetch);
  vi.stubEnv("HTTP_PROXY", "http://proxy.invalid:3128");
  vi.stubEnv("HTTPS_PROXY", "http://proxy.invalid:3128");
  vi.stubEnv("ALL_PROXY", "http://proxy.invalid:3128");
  vi.stubEnv("NO_PROXY", "");
  const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
  const registerDecisionProvider = vi.fn<OpenClawPluginApi["registerDecisionProvider"]>();
  plugin.register({
    runtime: {
      config: {
        current: () => ({
          plugins: {
            entries: { typesafe: { config: { baseUrl, apiKey: "hosted-materialized" } } },
          },
        }),
      },
    },
    registerTool,
    registerDecisionProvider,
  } as unknown as OpenClawPluginApi);
  const tool = registerTool.mock.calls[0]?.[0] as AnyAgentTool;
  const provider = registerDecisionProvider.mock.calls[0]?.[0] as DecisionProviderV1;
  expect(provider.isReady?.()).toBe(true);
  const result = await tool.execute("local-test", input);
  expect(result.details).toEqual({
    evaluation: {
      model: "kev-latest",
      usage: localAnswer.usage,
      answers: {
        ...localAnswer.answers,
        s: {
          ...localAnswer.answers.s,
          legend: { 0: null, 1: input.questions.s.criteria[1] },
        },
      },
    },
  });
  await expect(
    provider.evaluate(
      {
        ...input,
        questions: { ...input.questions, b: { ...input.questions.b, type: "boolean" } },
      },
      {
        model: "kev-latest",
        signal: new AbortController().signal,
        deadlineMonotonicMs: performance.now() + 1000,
      },
    ),
  ).resolves.toMatchObject({
    status: "ok",
    result: {
      answers: {
        c: localAnswer.answers.c,
        s: { type: "score", score: 0.8, probabilities: [0.2, 0.8] },
        b: { type: "boolean", probabilityTrue: 0.75 },
      },
    },
  });
  expect(getPreparedPluginSecretInput).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(2);
  for (const [url, init] of fetch.mock.calls) {
    expect(url).toBe(`${baseUrl}/v1/systemone`);
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    assert(typeof init?.body === "string");
    expect(JSON.parse(init.body)).toEqual({
      ...input,
      model: "kev-latest",
      questions: {
        c: { ...input.questions.c, instructions: null },
        s: {
          ...input.questions.s,
          instructions: null,
          criteria: ["", '{"impact":["widespread",true,2]}'],
        },
        b: input.questions.b,
      },
    });
  }
});

it("refuses to send the local Kev selection to hosted inference through registered handlers", async () => {
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          model: "kev-latest",
          answers: { q: { type: "noul", noul: 0.75 } },
          usage: localAnswer.usage,
        }),
      ),
  );
  vi.stubGlobal("fetch", fetch);
  const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
  const registerDecisionProvider = vi.fn<OpenClawPluginApi["registerDecisionProvider"]>();
  plugin.register({
    runtime: { config: { current: () => ({}) } },
    registerTool,
    registerDecisionProvider,
  } as unknown as OpenClawPluginApi);
  const provider = registerDecisionProvider.mock.calls[0]?.[0];
  assert(provider);
  await expect(
    provider.evaluate(
      { state: "local-only evidence", questions: { q: { type: "boolean" } } },
      {
        model: "kev-latest",
        signal: new AbortController().signal,
        deadlineMonotonicMs: performance.now() + 10000,
      },
    ),
  ).resolves.toEqual({ status: "unavailable", reason: "unsupported-input" });
  const tool = registerTool.mock.calls[0]?.[0] as AnyAgentTool;
  await expect(
    tool.execute("local-test", {
      state: "local-only evidence",
      questions: { q: { type: "noul" } },
      model: "kev-latest",
    }),
  ).rejects.toThrow("baseUrl");
  expect(fetch).not.toHaveBeenCalled();
});

it.each([
  "http://localhost:8009",
  "http://127.0.0.1:8009/",
  "http://[::1]:8009",
  "https://localhost",
])("accepts an explicit loopback origin %s", (url) => {
  expect(runtimeConfig({ baseUrl: url, apiKey: "ignored-secret" })).toEqual({
    baseUrl: new URL(url).origin,
    model: "kev-latest",
    timeoutMs: 10000,
  });
});

it.each([
  "",
  "http://192.168.1.2:8009",
  "https://remote.example",
  "http://localhost.example",
  "http://localhost:8009/v1",
  "http://localhost:8009?x=1",
  "http://localhost:8009#x",
  "http://user:password@localhost:8009",
  "file:///localhost",
  "http://localhost:65536",
  "http://127.1:8009",
  "http://2130706433:8009",
  "http://localhost.:8009",
  null,
  8009,
])("rejects non-origin, non-loopback, or ambiguous endpoint %s", (url) => {
  expect(() => runtimeConfig({ baseUrl: url })).toThrow("baseUrl");
});

it.each([
  { ...localAnswer, latency_ms: -1 },
  { ...localAnswer, latency_ms: "15" },
  { ...localAnswer, debug: "extra metadata" },
  {
    ...localAnswer,
    answers: {
      ...localAnswer.answers,
      s: {
        ...localAnswer.answers.s,
        legend: { 0: "", 1: "wrong rubric" },
      },
    },
  },
  { ...localAnswer, answers: { ...localAnswer.answers, b: { type: "noul", noul: 2 } } },
])("keeps answer and metadata validation strict for local responses", async (response) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(response))),
  );
  await expect(evaluate(input, runtimeConfig({ baseUrl }))).rejects.toThrow("invalid response");
});

it("keeps hosted response validation strict and ignores stale keys even on direct local calls", async () => {
  const fetch = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(localAnswer)),
  );
  vi.stubGlobal("fetch", fetch);
  await expect(
    evaluate(input, {
      ...runtimeConfig({ baseUrl }),
      apiKey: "hosted-secret",
    }),
  ).resolves.toHaveProperty("evaluation.model", "kev-latest");
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has("authorization")).toBe(false);
  const hostedInput = {
    ...input,
    questions: {
      ...input.questions,
      s: {
        ...input.questions.s,
        criteria: ["", '{"impact":["widespread",true,2]}'],
      },
    },
  };
  await expect(evaluate(hostedInput, runtimeConfig({ apiKey: "hosted-secret" }))).rejects.toThrow(
    "invalid response",
  );
  expect(fetch.mock.calls[1]?.[0]).toBe("https://api.typesafe.ai/v1/systemone");
  expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get("authorization")).toBe(
    "Bearer hosted-secret",
  );
});

it.each(["127.0.0.1", "localhost", "[::1]"])(
  "reaches a real %s server without ambient proxies or localhost DNS",
  async (hostname) => {
    const received: { url?: string; authorization?: string; host?: string; body: string }[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({
          url: request.url,
          authorization: request.headers.authorization,
          host: request.headers.host,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(localAnswer));
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, hostname === "[::1]" ? "::1" : "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      assert(address && typeof address === "object");
      for (const name of [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
      ]) {
        vi.stubEnv(name, "http://127.0.0.1:1");
      }
      vi.stubEnv("NO_PROXY", "");
      vi.stubEnv("no_proxy", "");
      vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "false");
      if (hostname === "localhost") {
        vi.mocked(lookup).mockRejectedValue(new Error("Synthetic untrusted localhost resolver"));
      }
      await expect(
        evaluate(input, runtimeConfig({ baseUrl: `http://${hostname}:${address.port}` })),
      ).resolves.toHaveProperty("evaluation.answers.b.noul", 0.75);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        url: "/v1/systemone",
        authorization: undefined,
        host: `${hostname}:${address.port}`,
      });
      expect(JSON.parse(received[0]!.body).questions.c.instructions).toBeNull();
      if (hostname === "localhost") {
        expect(lookup).not.toHaveBeenCalled();
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  },
);
