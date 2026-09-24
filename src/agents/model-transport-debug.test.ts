import { emitModelTransportDebug } from "@openclaw/ai/diagnostics";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("../infra/net/proxy-env.js", () => ({
  shouldUseEnvHttpProxyForUrl: () => false,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => log,
}));

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

describe("emitModelTransportDebug", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_DEBUG_MODEL_TRANSPORT", undefined);
    vi.stubEnv("OPENCLAW_DEBUG_MODEL_PAYLOAD", undefined);
    vi.stubEnv("OPENCLAW_DEBUG_SSE", undefined);
    vi.stubEnv("OPENCLAW_DEBUG_CODE_MODE", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function createLogger() {
    const info = vi.fn();
    const debug = vi.fn();
    return {
      log: { info, debug },
      info,
      debug,
    };
  }

  it.each([
    "[model-fetch] start provider=openai api=chat model=gpt method=POST",
    "[model-fetch] response provider=openai api=chat model=gpt status=200 elapsedMs=42",
    "[model-sse] event type=response.output_text.delta",
  ])("keeps transport diagnostics at debug by default: %s", (message) => {
    const { log: logger, info, debug } = createLogger();

    emitModelTransportDebug(logger, message);

    expect(debug).toHaveBeenCalledWith(message);
    expect(info).not.toHaveBeenCalled();
  });

  it.each([
    ["OPENCLAW_DEBUG_MODEL_TRANSPORT", "1"],
    ["OPENCLAW_DEBUG_MODEL_PAYLOAD", "summary"],
    ["OPENCLAW_DEBUG_SSE", "events"],
    ["OPENCLAW_DEBUG_CODE_MODE", "1"],
  ])("promotes transport diagnostics when %s=%s", (name, value) => {
    vi.stubEnv(name, value);
    const { log: logger, info, debug } = createLogger();
    const message = "[model-fetch] response provider=openai api=chat model=gpt status=200";

    emitModelTransportDebug(logger, message);

    expect(info).toHaveBeenCalledWith(message);
    expect(debug).not.toHaveBeenCalled();
  });
});

describe("guarded model fetch logging", () => {
  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset();
    log.info.mockClear();
    log.debug.mockClear();
    log.warn.mockClear();
    vi.stubEnv("OPENCLAW_DEBUG_MODEL_TRANSPORT", undefined);
    vi.stubEnv("OPENCLAW_DEBUG_MODEL_PAYLOAD", undefined);
    vi.stubEnv("OPENCLAW_DEBUG_SSE", undefined);
    vi.stubEnv("OPENCLAW_DEBUG_CODE_MODE", undefined);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await closeProviderTransportDispatcherPool();
  });

  it.each([
    { status: 200, elapsedMs: 999, level: "debug" },
    { status: 299, elapsedMs: 42, level: "debug" },
    { status: 200, elapsedMs: 1_000, level: "info" },
    { status: 300, elapsedMs: 42, level: "info" },
    { status: 500, elapsedMs: 42, level: "info" },
  ] as const)(
    "logs response status=$status elapsedMs=$elapsedMs at $level",
    async ({ status, elapsedMs, level }) => {
      let now = 1_000;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
      fetchWithSsrFGuardMock.mockImplementationOnce(async () => {
        now += elapsedMs;
        return {
          response: new Response("ok", { status }),
          finalUrl: requestUrl,
          release: vi.fn(async () => undefined),
        };
      });

      try {
        const response = await buildGuardedModelFetch(model)(requestUrl, { method: "POST" });
        await response.text();

        expect(log.debug).toHaveBeenCalledWith(expect.stringContaining("[model-fetch] start "));
        expect(log[level]).toHaveBeenCalledWith(
          expect.stringContaining(`status=${status} elapsedMs=${elapsedMs}`),
        );
        expect(log.info).toHaveBeenCalledTimes(level === "info" ? 1 : 0);
      } finally {
        nowSpy.mockRestore();
      }
    },
  );

  it("keeps transport failures at warning level", async () => {
    fetchWithSsrFGuardMock.mockRejectedValueOnce(new Error("network down"));

    await expect(buildGuardedModelFetch(model)(requestUrl)).rejects.toThrow("network down");

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("[model-fetch] error "));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("message=network down"));
  });
});
