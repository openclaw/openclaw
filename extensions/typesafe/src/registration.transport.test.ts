import assert from "node:assert/strict";
import type {
  DecisionBatchV2,
  DecisionEntry,
  DecisionProviderContextV2,
} from "openclaw/plugin-sdk/decisions";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import plugin from "../index.js";

vi.mock("openclaw/plugin-sdk/secret-input-runtime", () => ({
  getPreparedPluginSecretInput: vi.fn(),
}));

const batch: DecisionBatchV2 = {
  state: { type: "json", value: { evidence: "synthetic only" } },
  questions: {
    q: { type: "boolean", instructions: "Does the evidence satisfy the criterion?" },
    c: { type: "choice", criteria: { keep: "Keep", skip: "Skip" } },
    s: { type: "score", criteria: ["Low", "High"] },
  },
};
const response = {
  model: "jev-test",
  answers: {
    q: { type: "noul", noul: 0.37 },
    c: { type: "choice", choice: "keep", confidence: 0.5, probabilities: { keep: 0.8, skip: 0.2 } },
    s: {
      type: "score",
      score: 0.6,
      confidence: 0.5,
      probabilities: { 0: 0.4, 1: 0.6 },
      legend: { 0: "Low", 1: "High" },
    },
  },
  usage: { input_tokens: 12, output_tokens: 3 },
};

// Exercise the provider created by the actual plugin registration.
function registeredProvider() {
  const registerDecisionProvider = vi.fn<OpenClawPluginApi["registerDecisionProvider"]>();
  plugin.register({
    runtime: { config: { current: () => ({}) } },
    registerDecisionProvider,
  } as unknown as OpenClawPluginApi);
  const provider = registerDecisionProvider.mock.calls[0]?.[0];
  assert(provider?.contractVersion === 2);
  return provider;
}

beforeEach(() => {
  vi.mocked(getPreparedPluginSecretInput).mockReturnValue({ revision: 1, value: "synthetic-key" });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("runs the registered provider through the HTTP transport and back to host decisions", async () => {
  const fetch = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(response)),
  );
  vi.stubGlobal("fetch", fetch);
  const provider = registeredProvider();
  await expect(
    provider.evaluate(batch, {
      model: { id: "jev-agent-selected", name: "Jev", provider: "typesafe" },
      config: {},
      auth: { mode: "api-key", apiKey: "synthetic-key" },
      agentId: "research",
      signal: new AbortController().signal,
      deadlineMonotonicMs: performance.now() + 1000,
    }),
  ).resolves.toEqual({
    status: "ok",
    result: {
      model: "jev-test",
      answers: {
        q: { type: "boolean", probabilityTrue: 0.37 },
        c: response.answers.c,
        s: { type: "score", score: 0.6, confidence: 0.5, probabilities: [0.4, 0.6] },
      },
      usage: { inputTokens: 12, outputTokens: 3 },
    },
  });
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]?.[0]).toBe("https://api.typesafe.ai/v1/systemone");
  const body = fetch.mock.calls[0]?.[1]?.body;
  assert(typeof body === "string");
  expect(JSON.parse(body)).toEqual({
    ...batch,
    state: { evidence: "synthetic only" },
    questions: { ...batch.questions, q: { ...batch.questions.q, type: "noul" } },
    model: "jev-agent-selected",
  });
});

it.each([
  { keep: 0.5, skip: 0.49 },
  { keep: 0.9, skip: 0.1 },
])("preserves native estimates and a non-argmax vendor choice", async (probabilities) => {
  const reported = structuredClone(response);
  reported.answers.c.choice = "skip";
  reported.answers.c.probabilities = probabilities;
  reported.answers.s.score = 0.607;
  const fetch = vi.fn(async () => new Response(JSON.stringify(reported)));
  vi.stubGlobal("fetch", fetch);
  await expect(
    registeredProvider().evaluate(batch, {
      model: { id: "jev-agent-selected", name: "Jev", provider: "typesafe" },
      config: {},
      auth: { mode: "api-key", apiKey: "synthetic-key" },
      signal: new AbortController().signal,
      deadlineMonotonicMs: performance.now() + 1000,
    }),
  ).resolves.toMatchObject({
    status: "ok",
    result: { answers: { c: reported.answers.c, s: { score: 0.607, probabilities: [0.4, 0.6] } } },
  });
  expect(fetch).toHaveBeenCalledOnce();
});

it("does not dispatch when prepared credentials disappear or caller authority is canceled", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const provider = registeredProvider();
  const controller = new AbortController();
  const context: DecisionProviderContextV2 = {
    model: { id: "jev-agent-selected", name: "Jev", provider: "typesafe" },
    config: {},
    auth: { mode: "api-key", apiKey: "synthetic-key" },
    agentId: "research",
    signal: controller.signal,
    deadlineMonotonicMs: performance.now() + 1000,
  };
  vi.mocked(getPreparedPluginSecretInput).mockReturnValue({ revision: 2 });
  await expect(
    provider.evaluate(batch, { ...context, auth: { mode: "api-key" } }),
  ).resolves.toEqual({
    status: "unavailable",
    reason: "credentials-unavailable",
  });
  controller.abort(new Error("caller closed"));
  await expect(provider.evaluate(batch, context)).rejects.toThrow("caller closed");
  expect(fetch).not.toHaveBeenCalled();
});

it.each<DecisionBatchV2>([
  {
    state: { type: "json", value: null },
    questions: { s: { type: "score", criteria: Array(11).fill("level") } },
  },
  {
    state: { type: "json", value: null },
    questions: {
      c: {
        type: "choice",
        criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [String(i), null])),
      },
    },
  },
  { ...batch, state: { type: "json", value: { constructor: "synthetic reserved key" } } },
])("rejects unsupported vendor input without dispatch", async (input) => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(
    registeredProvider().evaluate(input, {
      model: { id: "jev-agent-selected", name: "Jev", provider: "typesafe" },
      config: {},
      auth: { mode: "api-key", apiKey: "synthetic-key" },
      signal: new AbortController().signal,
      deadlineMonotonicMs: performance.now() + 1000,
    }),
  ).resolves.toEqual({ status: "unavailable", reason: "unsupported-input" });
  expect(fetch).not.toHaveBeenCalled();
});

it("does not dispatch when preparation consumes the native deadline", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify(response)));
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(100);
  await expect(
    registeredProvider().evaluate(batch, {
      model: { id: "jev-agent-selected", name: "Jev", provider: "typesafe" },
      config: {},
      auth: { mode: "api-key", apiKey: "synthetic-key" },
      signal: new AbortController().signal,
      deadlineMonotonicMs: 50,
    }),
  ).resolves.toEqual({ status: "unavailable", reason: "transport" });
  expect(fetch).not.toHaveBeenCalled();
});

it("limits an in-flight request to the budget remaining after preparation", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(40);
  let started!: (signal: AbortSignal) => void;
  const startedSignal = new Promise<AbortSignal>((resolve) => {
    started = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          assert(signal);
          signal.addEventListener("abort", () => reject(new Error("request aborted")), {
            once: true,
          });
          started(signal);
        }),
    ),
  );
  const controller = new AbortController();
  const pending = registeredProvider().evaluate(batch, {
    model: { id: "jev-agent-selected", name: "Jev", provider: "typesafe" },
    config: {},
    auth: { mode: "api-key", apiKey: "synthetic-key" },
    signal: controller.signal,
    deadlineMonotonicMs: 50,
  });
  try {
    const signal = await startedSignal;
    await vi.advanceTimersByTimeAsync(9);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    await expect(pending).resolves.toEqual({ status: "unavailable", reason: "transport" });
  } finally {
    controller.abort();
    await pending.catch(() => {});
    vi.useRealTimers();
  }
});

it.each(["inherited array serializer", "hidden serializer", "getter", "hidden array getter"])(
  "rejects a %s before executing user code or dispatching the registered provider",
  async (kind) => {
    const hook = vi.fn(() => "synthetic replacement");
    let state: DecisionEntry;
    if (kind === "inherited array serializer") {
      const prototype = Object.create(Array.prototype);
      Object.defineProperty(prototype, "toJSON", { value: hook });
      state = Object.setPrototypeOf(["synthetic evidence"], prototype);
    } else if (kind === "hidden array getter") {
      state = Object.defineProperty([], "0", { get: hook });
    } else {
      state = Object.defineProperty(
        {},
        kind === "getter" ? "evidence" : "toJSON",
        kind === "getter" ? { enumerable: true, get: hook } : { value: hook },
      );
    }
    const fetch = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    await expect(
      registeredProvider().evaluate(
        {
          state: { type: "json", value: state },
          questions: { q: { type: "boolean" } },
        },
        {
          model: { id: "jev-agent-selected", name: "Jev", provider: "typesafe" },
          config: {},
          auth: { mode: "api-key", apiKey: "synthetic-key" },
          signal: new AbortController().signal,
          deadlineMonotonicMs: performance.now() + 1000,
        },
      ),
    ).resolves.toEqual({ status: "unavailable", reason: "unsupported-input" });
    expect(hook).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  },
);

it.each([42, false])(
  "encodes explicit JSON scalar %s without treating it as ambient evidence",
  async (value) => {
    const fetch = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(response)),
    );
    vi.stubGlobal("fetch", fetch);
    const outcome = await registeredProvider().evaluate(
      { ...batch, state: { type: "json", value } },
      {
        model: { id: "jev-latest", name: "Jev", provider: "typesafe" },
        config: {},
        auth: { mode: "api-key", apiKey: "synthetic-key" },
        signal: new AbortController().signal,
        deadlineMonotonicMs: performance.now() + 1000,
      },
    );
    expect(outcome.status).toBe("ok");
    const body = fetch.mock.calls[0]?.[1]?.body;
    assert(typeof body === "string");
    expect(JSON.parse(body).state).toBe(JSON.stringify(value));
  },
);

it.each(["choice", "score"] as const)(
  "rejects zero-mass %s distributions from the registered transport",
  async (kind) => {
    const reported = structuredClone(response);
    if (kind === "choice") {
      reported.answers.c.probabilities = { keep: 0, skip: 0 };
    } else {
      reported.answers.s.probabilities = { 0: 0, 1: 0 };
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(reported))),
    );
    await expect(
      registeredProvider().evaluate(batch, {
        model: { id: "jev-latest", name: "Jev", provider: "typesafe" },
        config: {},
        auth: { mode: "api-key", apiKey: "synthetic-key" },
        signal: new AbortController().signal,
        deadlineMonotonicMs: performance.now() + 1000,
      }),
    ).resolves.toEqual({ status: "unavailable", reason: "invalid-response" });
  },
);

it("sends the registered prepared request through guarded loopback HTTP and sanitizes 413/422", async () => {
  let status = 200;
  const received: { authorization?: string; url?: string; body: unknown }[] = [];
  await withServer(
    (request, serverResponse) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({
          authorization: request.headers.authorization,
          url: request.url,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
        serverResponse.writeHead(status, { "content-type": "application/json" });
        serverResponse.end(
          status === 200
            ? JSON.stringify({
                model: "kev-latest",
                answers: { q: { type: "noul", noul: 0.37 } },
                usage: { input_tokens: 3, output_tokens: 1 },
              })
            : "synthetic-private-evidence synthetic-prepared-key",
        );
      });
    },
    async (baseUrl) => {
      const provider = registeredProvider();
      const context: DecisionProviderContextV2 = {
        model: { id: "kev-latest", name: "Kev", provider: "typesafe" },
        config: { plugins: { entries: { typesafe: { config: { baseUrl } } } } },
        auth: { mode: "api-key", apiKey: "synthetic-prepared-key" },
        reasoning: "auto",
        signal: new AbortController().signal,
        deadlineMonotonicMs: performance.now() + 1000,
      };
      const input: DecisionBatchV2 = {
        state: { type: "text", text: "synthetic-private-evidence" },
        questions: { q: { type: "boolean" } },
      };
      await expect(provider.evaluate(input, context)).resolves.toMatchObject({
        status: "ok",
        result: { model: "kev-latest", answers: { q: { probabilityTrue: 0.37 } } },
      });
      for (status of [413, 422]) {
        await expect(provider.evaluate(input, context)).resolves.toEqual({
          status: "unavailable",
          reason: "unsupported-input",
        });
      }
      expect(received).toHaveLength(3);
      for (const request of received) {
        expect(request).toEqual({
          authorization: undefined,
          url: "/v1/systemone",
          body: {
            model: "kev-latest",
            state: "synthetic-private-evidence",
            questions: { q: { type: "noul", instructions: null } },
          },
        });
      }
    },
  );
});
