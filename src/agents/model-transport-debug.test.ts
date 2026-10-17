import { emitModelTransportDebug } from "@openclaw/ai/diagnostics";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withModelTransportContext } from "../llm/model-transport-context.js";
import { closeProviderTransportDispatcherPool } from "./provider-transport-dispatcher-pool.js";
import { buildGuardedModelFetch } from "./provider-transport-fetch.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

const { fetchWithSsrFGuardMock, log } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
  log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("../infra/net/proxy-env.js", () => ({ shouldUseEnvHttpProxyForUrl: () => false }));
vi.mock("../logging/subsystem.js", () => ({ createSubsystemLogger: () => log }));

vi.mock("./provider-local-service.js", () => ({
  ensureModelProviderLocalService: async () => undefined,
}));

vi.mock("./provider-request-config.js", () => ({
  buildProviderRequestDispatcherPolicy: () => undefined,
  getModelProviderRequestRouteFacts: () => undefined,
  getModelProviderRequestTransport: () => undefined,
  mergeModelProviderRequestOverrides: () => undefined,
  resolveProviderRequestPolicyConfig: () => ({ allowPrivateNetwork: false }),
}));

const model = makeProviderModelFixture<"openai-responses">({
  id: "gpt-5.5",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
});
const requestUrl = "https://api.openai.com/v1/responses";

beforeEach(() => {
  fetchWithSsrFGuardMock.mockReset();
  for (const logger of Object.values(log)) {
    logger.mockClear();
  }
  for (const name of ["MODEL_TRANSPORT", "MODEL_PAYLOAD", "SSE", "CODE_MODE"]) {
    vi.stubEnv(`OPENCLAW_DEBUG_${name}`, undefined);
  }
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await closeProviderTransportDispatcherPool();
});

function guardedResponse(init: ResponseInit) {
  return {
    response: new Response("ok", init),
    finalUrl: requestUrl,
    release: async () => undefined,
  };
}

const startMessage = "[model-fetch] start provider=openai api=chat model=gpt method=POST";
const responseMessage = "[model-fetch] response provider=openai api=chat model=gpt status=200";
const sseMessage = "[model-sse] event type=response.output_text.delta";
it.each([
  [startMessage, undefined, undefined],
  [`${responseMessage} elapsedMs=42`, undefined, undefined],
  [sseMessage, undefined, undefined],
  [responseMessage, "OPENCLAW_DEBUG_MODEL_TRANSPORT", "1"],
  [responseMessage, "OPENCLAW_DEBUG_MODEL_PAYLOAD", "summary"],
  [responseMessage, "OPENCLAW_DEBUG_SSE", "events"],
  [responseMessage, "OPENCLAW_DEBUG_CODE_MODE", "1"],
] as const)("emits %s with %s=%s", (message, name, value) => {
  if (name) {
    vi.stubEnv(name, value);
  }
  emitModelTransportDebug(log, message);
  expect(log[name ? "info" : "debug"]).toHaveBeenCalledWith(message);
  expect(log[name ? "debug" : "info"]).not.toHaveBeenCalled();
});
it("keeps concurrent model fetches correlated across asynchronous response headers", async () => {
  const pending: Array<() => void> = [];
  fetchWithSsrFGuardMock.mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      pending.push(resolve);
    });
    return guardedResponse({ headers: { "x-request-id": "req_upstream" } });
  });
  const fetch = buildGuardedModelFetch(model);
  const identities = ["1", '2\n\r\u001b[31m"\\'];
  const requests = identities.map((number) =>
    withModelTransportContext(
      {
        sessionKey: `session-${number}`,
        runId: `run-${number}`,
        requestId: `run-${number}:model:3`,
      },
      () => fetch(requestUrl),
    ),
  );
  await Promise.resolve();
  for (const resolve of pending.toReversed()) {
    resolve();
  }
  const responses = await Promise.all(requests);
  await Promise.all(responses.map((response) => response.text()));
  for (const number of identities) {
    const messages = log.debug.mock.calls.map(([message]) => String(message));
    const correlated = messages.filter((message) =>
      message.includes(`sessionKey=${JSON.stringify(`session-${number}`)} `),
    );
    expect(correlated).toHaveLength(2);
    for (const message of correlated) {
      expect(message).toContain(
        `runId=${JSON.stringify(`run-${number}`)} requestId=${JSON.stringify(`run-${number}:model:3`)} requestNumber=3`,
      );
      for (const control of ["\n", "\r", "\u001b"]) {
        expect(message).not.toContain(control);
      }
    }
    expect(correlated.find((message) => message.includes("[model-fetch] response "))).toContain(
      "httpRequestId=req_upstream",
    );
  }
});

it.each([
  [200, 999, "debug"],
  [299, 42, "debug"],
  [200, 1_000, "debug"],
  [200, 30_000, "debug"],
  [300, 42, "info"],
  [500, 42, "info"],
] as const)("logs response status=%s elapsedMs=%s at %s", async (status, elapsedMs, level) => {
  let now = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  fetchWithSsrFGuardMock.mockImplementationOnce(async () => {
    now += elapsedMs;
    return guardedResponse({ status });
  });

  const response = await buildGuardedModelFetch(model)(requestUrl, { method: "POST" });
  await response.text();

  expect(log.debug).toHaveBeenCalledWith(expect.stringContaining("[model-fetch] start "));
  expect(log[level]).toHaveBeenCalledWith(
    expect.stringContaining(`status=${status} elapsedMs=${elapsedMs}`),
  );
  expect(log.info).toHaveBeenCalledTimes(level === "info" ? 1 : 0);
});

it.each([
  [false, new Error("network down"), "warn", false],
  [false, new DOMException("upstream abort", "AbortError"), "warn", false],
  [false, new DOMException("fetch deadline", "TimeoutError"), "warn", false],
  [true, new DOMException("caller deadline", "TimeoutError"), "warn", false],
  [true, new Error("unknown caller failure"), "warn", false],
  [true, new DOMException("caller cancelled", "AbortError"), "debug", false],
  [true, new DOMException("caller cancelled", "AbortError"), "debug", true],
] as const)(
  "logs caller abort=%s error=%s at %s (Request: %s)",
  async (abort, error, level, request) => {
    const controller = new AbortController();
    fetchWithSsrFGuardMock.mockImplementationOnce(async () => {
      if (abort) {
        controller.abort(error);
      }
      throw error;
    });
    const fetch = buildGuardedModelFetch(model);
    const pending = request
      ? fetch(new Request(requestUrl, { signal: controller.signal }))
      : fetch(requestUrl, { signal: controller.signal });

    await expect(pending).rejects.toBe(error);

    expect(log[level]).toHaveBeenCalledWith(
      expect.stringContaining(`[model-fetch] ${level === "debug" ? "aborted" : "error"} `),
    );
    expect(log.warn).toHaveBeenCalledTimes(level === "warn" ? 1 : 0);
  },
);
