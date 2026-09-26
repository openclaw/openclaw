// Shared mocks and request helpers for the Ollama stream runtime tests.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, vi } from "vitest";

const ollamaStreamMocks = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
  ollamaStreamWarnMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: ollamaStreamMocks.fetchWithSsrFGuardMock,
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  return {
    ...actual,
    createSubsystemLogger: () => ({ warn: ollamaStreamMocks.ollamaStreamWarnMock }),
  };
});

import { createOllamaStreamFn } from "./stream.runtime.js";

export const { fetchWithSsrFGuardMock, ollamaStreamWarnMock } = ollamaStreamMocks;

export type GuardedFetchCall = {
  url: string;
  init?: RequestInit;
  policy?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  auditContext?: string;
};

export const requireRecord = createRequireRecord("object", "expected-label");

export function requireOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value === undefined ? undefined : requireRecord(value, "request options");
}

export function resetOllamaStreamMocks(): void {
  fetchWithSsrFGuardMock.mockReset();
  ollamaStreamWarnMock.mockReset();
}

export async function withMockNdjsonFetch(
  lines: string[],
  run: (fetchMock: typeof fetchWithSsrFGuardMock) => Promise<void>,
): Promise<void> {
  fetchWithSsrFGuardMock.mockImplementation(async () => {
    const payload = lines.join("\n");
    return {
      response: new Response(`${payload}\n`, {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson" },
      }),
      release: vi.fn(async () => undefined),
    };
  });
  await run(fetchWithSsrFGuardMock);
}

export async function withSuccessfulOllamaFetch(
  run: (fetchMock: typeof fetchWithSsrFGuardMock) => Promise<void>,
): Promise<void> {
  await withMockNdjsonFetch(
    [
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":"ok"},"done":false}',
      '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":1,"eval_count":1}',
    ],
    run,
  );
}

export function getGuardedFetchCall(fetchMock: typeof fetchWithSsrFGuardMock): GuardedFetchCall {
  return (fetchMock.mock.calls.at(0)?.[0] as GuardedFetchCall | undefined) ?? { url: "" };
}

export function getGuardedFetchJsonBody(
  fetchMock: typeof fetchWithSsrFGuardMock,
): Record<string, unknown> {
  const body = getGuardedFetchCall(fetchMock).init?.body;
  if (typeof body !== "string") {
    throw new Error("Expected string request body");
  }
  return requireRecord(JSON.parse(body), "Ollama request body");
}

export async function createOllamaTestStream(params: {
  baseUrl: string;
  defaultHeaders?: Record<string, string>;
  model?: Record<string, unknown>;
  context?: Record<string, unknown>;
  options?: Parameters<ReturnType<typeof createOllamaStreamFn>>[2] & Record<string, unknown>;
}) {
  const streamFn = createOllamaStreamFn(params.baseUrl, params.defaultHeaders);
  return streamFn(
    {
      id: "qwen3:32b",
      api: "ollama",
      provider: "custom-ollama",
      input: ["text"],
      contextWindow: 131072,
      ...params.model,
    } as unknown as Parameters<typeof streamFn>[0],
    (params.context ?? {
      messages: [{ role: "user", content: "hello" }],
    }) as unknown as Parameters<typeof streamFn>[1],
    (params.options ?? {}) as unknown as Parameters<typeof streamFn>[2],
  );
}

export async function collectStreamEvents<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

export async function expectSuccessfulOllamaRequest(
  params: Parameters<typeof createOllamaTestStream>[0],
  verify: (observation: {
    body: Record<string, unknown>;
    fetchMock: typeof fetchWithSsrFGuardMock;
    request: GuardedFetchCall;
  }) => void | Promise<void>,
): Promise<void> {
  await withSuccessfulOllamaFetch(async (fetchMock) => {
    const events = await collectStreamEvents(await createOllamaTestStream(params));
    expect(events.at(-1)?.type).toBe("done");
    await verify({
      body: getGuardedFetchJsonBody(fetchMock),
      fetchMock,
      request: getGuardedFetchCall(fetchMock),
    });
  });
}
