import type { DecisionBatchV2, DecisionProviderContextV2 } from "openclaw/plugin-sdk/decisions";
import { fetchWithProviderHttpGuard } from "openclaw/plugin-sdk/provider-http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildWorkersAiDecisionProvider } from "./workers-ai-decision-provider.js";

// mock-isolation: fixed Cloudflare REST responses replace billed external I/O only.
vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>()),
  fetchWithProviderHttpGuard: vi.fn(),
}));

const baseUrl = "https://api.cloudflare.com/client/v4/accounts/synthetic-account/ai";
const batch: DecisionBatchV2 = {
  state: { type: "json", value: { ticket: "Synthetic request" } },
  questions: {
    urgent: { type: "boolean", instructions: "Is it urgent?" },
    team: {
      type: "choice",
      instructions: "Which team?",
      criteria: { support: null, sales: "Sales" },
    },
    impact: { type: "score", instructions: "How much impact?", criteria: ["Low", "High"] },
  },
};
function wire() {
  return {
    success: true,
    errors: [],
    messages: [],
    result: {
      model: "clef",
      answers: {
        urgent: { type: "noul", noul: 0.37 },
        team: {
          type: "choice",
          choice: "support",
          probabilities: { support: 0.7, sales: 0.3 },
          confidence: 0.2,
        },
        impact: {
          type: "score",
          score: 0.71,
          probabilities: { "0": 0.3, "1": 0.7 },
          legend: { "0": "Low", "1": "High" },
          confidence: 0.1,
        },
      },
      usage: { input_tokens: 14, output_tokens: 0 },
    },
  };
}
function context(overrides: Partial<DecisionProviderContextV2> = {}): DecisionProviderContextV2 {
  return {
    model: {
      id: "@cf/cloudflare/clef",
      provider: "cloudflare-workers-ai",
      name: "Cloudflare Clef",
      baseUrl,
    },
    config: {},
    auth: { apiKey: "synthetic-workers-token", mode: "api-key" },
    signal: new AbortController().signal,
    deadlineMonotonicMs: performance.now() + 5_000,
    isAdmissible: () => true,
    ...overrides,
  };
}
const release = vi.fn(async () => {});
const getImageMetadata =
  vi.fn<Parameters<typeof buildWorkersAiDecisionProvider>[0]["getImageMetadata"]>();
const provider = buildWorkersAiDecisionProvider({ getImageMetadata });
function respond(value: unknown, status = 200) {
  vi.mocked(fetchWithProviderHttpGuard).mockResolvedValue({
    response: Response.json(value, { status }),
    release,
    finalUrl: `${baseUrl}/run/@cf/cloudflare/clef`,
  });
}
function request() {
  const call = vi.mocked(fetchWithProviderHttpGuard).mock.calls[0]?.[0];
  if (!call || typeof call.init?.body !== "string") {
    throw new Error("Expected native JSON request");
  }
  return { ...call, body: JSON.parse(call.init.body) };
}
beforeEach(() => {
  vi.resetAllMocks();
  getImageMetadata.mockResolvedValue({ width: 320, height: 320 });
  respond(wire());
});

describe("Cloudflare Clef Decision adapter", () => {
  it.each([0, 2])(
    "preserves returned estimates and %s output tokens in the native request",
    async (outputTokens) => {
      const value = wire();
      value.result.usage.output_tokens = outputTokens;
      respond(value);
      expect(await provider.evaluate(batch, context())).toMatchObject({
        status: "ok",
        result: {
          model: "clef",
          usage: { inputTokens: 14, outputTokens },
          answers: {
            urgent: { probabilityTrue: 0.37 },
            impact: { score: 0.71, probabilities: [0.3, 0.7], confidence: 0.1 },
          },
        },
      });
      expect(request().url).toBe(`${baseUrl}/run/@cf/cloudflare/clef`);
      expect(request().body).toEqual({
        model: "clef",
        state: { ticket: "Synthetic request" },
        questions: {
          urgent: { type: "noul", instructions: "Is it urgent?" },
          team: {
            type: "choice",
            instructions: "Which team?",
            criteria: { support: null, sales: "Sales" },
          },
          impact: { type: "score", instructions: "How much impact?", criteria: ["Low", "High"] },
        },
      });
      expect(new Headers(request().init?.headers).get("authorization")).toBe(
        "Bearer synthetic-workers-token",
      );
      expect(fetchWithProviderHttpGuard).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it.each([16_000_000, 16_004_000])(
    "enforces the 16-megapixel image limit at %s pixels",
    async (pixels) => {
      getImageMetadata.mockResolvedValue({ width: 4000, height: pixels / 4000 });
      const dataUri = "data:image/png;base64,AA==";
      expect(
        await provider.evaluate(
          { ...batch, state: { type: "image", dataUri, text: "Evidence" } },
          context(),
        ),
      ).toMatchObject(pixels === 16_000_000 ? { status: "ok" } : { reason: "unsupported-input" });
      expect(fetchWithProviderHttpGuard).toHaveBeenCalledTimes(pixels === 16_000_000 ? 1 : 0);
      if (pixels === 16_000_000) {
        expect(request().body).toMatchObject({ state: "Evidence", images: [dataUri] });
      }
    },
  );

  it.each<DecisionBatchV2>([
    { ...batch, questions: { urgent: { type: "boolean" } } },
    {
      ...batch,
      questions: { urgent: { type: "boolean", instructions: "Urgent?", criteria: null } },
    },
    { ...batch, questions: { "bad id": { type: "boolean", instructions: "Urgent?" } } },
    {
      ...batch,
      questions: Object.fromEntries(
        Array.from({ length: 65 }, (_, index) => [
          `q${index}`,
          { type: "boolean", instructions: "Urgent?" },
        ]),
      ),
    },
    {
      ...batch,
      questions: {
        impact: {
          type: "score",
          instructions: "Rate",
          criteria: Array.from({ length: 11 }, () => "Level"),
        },
      },
    },
    {
      ...batch,
      questions: {
        team: {
          type: "choice",
          instructions: "Choose",
          criteria: Object.fromEntries(
            Array.from({ length: 256 }, (_, index) => [`c${index}`, null]),
          ),
        },
      },
    },
    { ...batch, state: { type: "json", value: null } },
  ])("rejects unsupported payloads before HTTP", async (input) => {
    expect(await provider.evaluate(input, context())).toMatchObject({
      reason: "unsupported-input",
    });
    expect(fetchWithProviderHttpGuard).not.toHaveBeenCalled();
  });

  it.each(["model", "provider", "defaults", "default-model", "agent", "agent-model"])(
    "rejects authored %s parameters instead of dropping policy",
    async (scope) => {
      const params = { provider: { data_collection: "deny" } };
      const ref = "cloudflare-workers-ai/@cf/cloudflare/clef";
      const ctx = context({
        agentId: "worker",
        config: {
          models: {
            providers: {
              "cloudflare-workers-ai": {
                baseUrl,
                models: [],
                params: scope === "provider" ? params : {},
              },
            },
          },
          agents: {
            defaults: {
              params: scope === "defaults" ? params : {},
              models: { [ref]: { params: scope === "default-model" ? params : {} } },
            },
            entries: {
              worker: {
                params: scope === "agent" ? params : {},
                models: { [ref]: { params: scope === "agent-model" ? params : {} } },
              },
            },
          },
        },
      });
      ctx.model.params = scope === "model" ? params : {};
      expect(await provider.evaluate(batch, ctx)).toMatchObject({ reason: "unsupported-input" });
      expect(fetchWithProviderHttpGuard).not.toHaveBeenCalled();
    },
  );

  it("preserves prepared auth, Gateway routing and explicit network policy", async () => {
    const ctx = context({
      config: {
        models: {
          providers: {
            "cloudflare-workers-ai": {
              baseUrl,
              models: [],
              request: {
                auth: { mode: "header", headerName: "x-prepared-key", value: "synthetic-unused" },
                allowPrivateNetwork: false,
                proxy: { mode: "env-proxy" },
              },
            },
          },
        },
      },
    });
    ctx.model.baseUrl = "https://proxy.example.test/clef/";
    ctx.model.headers = {
      "x-prepared-key": "synthetic-effective",
      "cf-aig-gateway-id": "synthetic-gateway",
    };
    await provider.evaluate(batch, ctx);
    expect(request().url).toBe("https://proxy.example.test/clef/run/@cf/cloudflare/clef");
    const headers = new Headers(request().init?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-prepared-key")).toBe("synthetic-effective");
    expect(headers.get("cf-aig-gateway-id")).toBe("synthetic-gateway");
    expect(request().policy).toEqual({
      allowIpv6UniqueLocalRange: true,
      allowRfc2544BenchmarkRange: true,
      hostnameAllowlist: ["proxy.example.test"],
    });
    expect(request().dispatcherPolicy).toEqual({ mode: "env-proxy" });
  });

  it.each(["envelope", "legend", "distribution", "confidence", "usage"])(
    "rejects malformed %s without retry",
    async (failure) => {
      const value = wire();
      if (failure === "envelope") {
        value.success = false;
      }
      if (failure === "legend") {
        Reflect.deleteProperty(value.result.answers.impact.legend, "1");
      }
      if (failure === "distribution") {
        Reflect.deleteProperty(value.result.answers.team, "probabilities");
      }
      if (failure === "confidence") {
        Reflect.deleteProperty(value.result.answers.team, "confidence");
      }
      if (failure === "usage") {
        value.result.usage.output_tokens = -1;
      }
      respond(value);
      expect(await provider.evaluate(batch, context())).toMatchObject({
        reason: "invalid-response",
      });
      expect(fetchWithProviderHttpGuard).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [401, "authentication"],
    [403, "authentication"],
    [429, "rate-limited"],
    [400, "unsupported-input"],
    [500, "transport"],
  ] as const)("classifies HTTP %s without exposing or retrying errors", async (status, reason) => {
    respond({ success: false, errors: [{ message: "synthetic-private-error" }] }, status);
    expect(await provider.evaluate(batch, context())).toEqual({ status: "unavailable", reason });
    expect(fetchWithProviderHttpGuard).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("rechecks authority after image inspection and immediately before dispatch", async () => {
    const error = new Error("synthetic revoked caller");
    let active = true;
    getImageMetadata.mockImplementationOnce(async () => {
      active = false;
      return { width: 32, height: 32 };
    });
    const ctx = context({
      isAdmissible: () => {
        if (!active) {
          throw error;
        }
        return true;
      },
    });
    await expect(
      provider.evaluate(
        { ...batch, state: { type: "image", dataUri: "data:image/png;base64,AA==" } },
        ctx,
      ),
    ).rejects.toBe(error);
    expect(fetchWithProviderHttpGuard).not.toHaveBeenCalled();
    active = true;
    const dispatched = vi.fn();
    vi.mocked(fetchWithProviderHttpGuard).mockImplementationOnce(async (options) => {
      active = false;
      options.beforeRequest?.();
      dispatched();
      return { response: Response.json(wire()), release, finalUrl: options.url };
    });
    await expect(provider.evaluate(batch, ctx)).rejects.toBe(error);
    expect(dispatched).not.toHaveBeenCalled();
  });

  it.each(["aborted", "expired"])("does not dispatch an %s call", async (state) => {
    const controller = new AbortController();
    const error = new Error("synthetic caller cancellation");
    if (state === "aborted") {
      controller.abort(error);
    }
    const pending = provider.evaluate(
      batch,
      context({
        signal: controller.signal,
        deadlineMonotonicMs:
          state === "expired" ? performance.now() - 1 : performance.now() + 5_000,
      }),
    );
    if (state === "aborted") {
      await expect(pending).rejects.toBe(error);
    } else {
      await expect(pending).resolves.toEqual({ status: "unavailable", reason: "transport" });
    }
    expect(fetchWithProviderHttpGuard).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("awaits transport release when cancelled during response reading", async () => {
    const controller = new AbortController();
    const reading = Promise.withResolvers<void>();
    const releasing = Promise.withResolvers<void>();
    const drained = Promise.withResolvers<void>();
    const error = new Error("synthetic body cancellation");
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        controller.signal.addEventListener("abort", () => stream.error(error), { once: true });
      },
      pull() {
        reading.resolve();
      },
    });
    release.mockImplementationOnce(async () => {
      releasing.resolve();
      await drained.promise;
    });
    vi.mocked(fetchWithProviderHttpGuard).mockResolvedValueOnce({
      response: new Response(body),
      finalUrl: `${baseUrl}/run/@cf/cloudflare/clef`,
      release,
    });
    const settled = vi.fn();
    const pending = provider
      .evaluate(batch, context({ signal: controller.signal }))
      .finally(settled);
    const rejected = expect(pending).rejects.toBe(error);
    await reading.promise;
    controller.abort(error);
    await releasing.promise;
    expect(settled).not.toHaveBeenCalled();
    drained.resolve();
    await rejected;
    expect(release).toHaveBeenCalledOnce();
  });
});
