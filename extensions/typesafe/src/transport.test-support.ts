import type { IncomingMessage } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { vi } from "vitest";
import plugin from "../index.js";
import type { EvaluationInput } from "./schema.js";

export function mockFetch(implementation: typeof globalThis.fetch) {
  const fetch = vi.fn(implementation);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
export const mockResponse = (body?: BodyInit | null, init?: ResponseInit) =>
  mockFetch(async () => new Response(body, init));
export const mockJsonResponse = (body: unknown, init?: ResponseInit) =>
  mockResponse(typeof body === "string" ? body : JSON.stringify(body), init);
export function stubAmbientProxies() {
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
    vi.stubEnv(key, "http://127.0.0.1:1");
    vi.stubEnv(key.toLowerCase(), "http://127.0.0.1:1");
  }
  vi.stubEnv("NO_PROXY", "");
  vi.stubEnv("no_proxy", "");
  vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "false");
}
export function collectRequest(request: IncomingMessage, handle: (body: string) => void) {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => handle(Buffer.concat(chunks).toString("utf8")));
}

const choiceAnswer = (
  choice: string,
  probabilities: Record<string, number>,
  confidence: number,
) => ({ type: "choice" as const, choice, confidence, probabilities });
export const scoreAnswer = (
  score: number,
  probabilities: Record<string, number>,
  legend: Record<string, unknown>,
  confidence: number,
) => ({ type: "score" as const, score, confidence, probabilities, legend });

const input = {
  model: "jev-test",
  state: { evidence: "synthetic only" },
  questions: {
    q: { type: "noul", instructions: { question: "Escalate?" } },
    c: { type: "choice", criteria: { keep: "Keep", skip: null } },
    s: { type: "score", criteria: [null, { impact: ["widespread", true, 2] }] },
  },
} satisfies EvaluationInput;
const response = {
  model: input.model,
  answers: {
    q: { type: "noul", noul: 0.37 },
    c: choiceAnswer("skip", { keep: 0.5, skip: 0.49 }, 0.5),
    s: scoreAnswer(0.607, { 0: 0.4, 1: 0.6 }, { 0: null, 1: input.questions.s.criteria[1] }, 0.5),
  },
  usage: { input_tokens: 12, output_tokens: 3 },
};
const localCriteria = ["", '{"impact":["widespread",true,2]}'];
export const mixedFixture = {
  input,
  response,
  batch: {
    state: { type: "json" as const, value: input.state },
    questions: { ...input.questions, q: { ...input.questions.q, type: "boolean" as const } },
  },
  localInput: {
    ...input,
    questions: {
      ...input.questions,
      c: { ...input.questions.c, instructions: null },
      s: { ...input.questions.s, instructions: null, criteria: localCriteria },
    },
  },
  localResponse: {
    ...response,
    answers: {
      ...response.answers,
      s: { ...response.answers.s, legend: { 0: "", 1: localCriteria[1] } },
    },
    latency_ms: 15.7,
  },
  result: {
    status: "ok",
    result: {
      model: "jev-test",
      answers: {
        q: { type: "boolean", probabilityTrue: 0.37 },
        c: response.answers.c,
        s: { type: "score", score: 0.607, confidence: 0.5, probabilities: [0.4, 0.6] },
      },
      usage: { inputTokens: 12, outputTokens: 3 },
    },
  },
};
export function registeredPreparedDecisionProvider(
  current: () => ReturnType<OpenClawPluginApi["runtime"]["config"]["current"]>,
) {
  const registerDecisionProvider = vi.fn<OpenClawPluginApi["registerDecisionProvider"]>();
  plugin.register({
    runtime: { config: { current } },
    registerDecisionProvider,
  } as unknown as OpenClawPluginApi);
  const provider = registerDecisionProvider.mock.calls[0]![0];
  if (provider.contractVersion !== 2) {
    throw new Error("Expected the prepared TypeSafe provider");
  }
  return provider;
}
