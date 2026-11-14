import type { DecisionBatchV2, DecisionProviderContextV2 } from "openclaw/plugin-sdk/decisions";
import { fetchWithProviderHttpGuard } from "openclaw/plugin-sdk/provider-http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildLiquidDecisionProvider } from "./decision-provider.js";

// mock-isolation: synthetic native responses exercise adapter policy without billed inference.
vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>()),
  fetchWithProviderHttpGuard: vi.fn(),
}));

const batch: DecisionBatchV2 = {
  state: { type: "json", value: { ticket: "Synthetic ticket" } },
  questions: {
    b: { type: "boolean", criteria: { true: "Urgent", false: null } },
    c: { type: "choice", criteria: { a: null, b: "Billing" } },
    s: { type: "score", instructions: null, criteria: ["Low", null] },
  },
};
const image: DecisionBatchV2 = {
  ...batch,
  state: { type: "image", dataUri: "data:image/png;base64,AA==", text: "Evidence" },
};
function context(overrides: Partial<DecisionProviderContextV2> = {}): DecisionProviderContextV2 {
  return {
    model: { provider: "liquid-ai", id: "d1-ultra", name: "Liquid d1 Ultra" },
    config: {},
    auth: { apiKey: "synthetic-prepared-key", mode: "api-key" },
    signal: new AbortController().signal,
    deadlineMonotonicMs: performance.now() + 5_000,
    isAdmissible: () => true,
    ...overrides,
  };
}
function wire() {
  return {
    model: "d1-ultra",
    answers: {
      b: { type: "noul", noul: 0.37 },
      c: { type: "choice", choice: "a", probabilities: { a: 0.49, b: 0.5 }, confidence: 0.1 },
      s: { type: "score", score: 0.71, probabilities: { "0": 0.3, "1": 0.69 }, confidence: 0.2 },
    },
    usage: { input_tokens: 3, output_tokens: 0 },
  };
}
const release = vi.fn(async () => {});
const getImageMetadata =
  vi.fn<Parameters<typeof buildLiquidDecisionProvider>[0]["getImageMetadata"]>();
const provider = buildLiquidDecisionProvider({ getImageMetadata });
function respond(value: unknown, status = 200) {
  vi.mocked(fetchWithProviderHttpGuard).mockResolvedValue({
    response: Response.json(value, { status }),
    finalUrl: "https://api.liquid.ai/decisions/v1/systemone",
    release,
  });
}
function request() {
  const call = vi.mocked(fetchWithProviderHttpGuard).mock.calls[0]?.[0];
  if (!call || typeof call.init?.body !== "string") {
    throw new Error("Expected one native JSON request");
  }
  return { ...call, body: JSON.parse(call.init.body) };
}
beforeEach(() => {
  vi.resetAllMocks();
  getImageMetadata.mockResolvedValue({ width: 320, height: 320 });
  respond(wire());
});
afterEach(() => vi.restoreAllMocks());

describe("Liquid native Decision provider", () => {
  it.each(["d1", "d1-ultra"])(
    "sends %s through the native endpoint without chat fields",
    async (id) => {
      const ctx = context();
      ctx.model.id = id;
      const result = await provider.evaluate(batch, ctx);
      expect(result).toMatchObject({
        status: "ok",
        result: {
          model: "d1-ultra",
          usage: { inputTokens: 3, outputTokens: 0 },
          answers: { s: { score: 0.71, probabilities: [0.3, 0.69] } },
        },
      });
      expect(request().url).toBe("https://api.liquid.ai/decisions/v1/systemone");
      expect(request().body).toEqual({
        model: id,
        state: { ticket: "Synthetic ticket" },
        questions: {
          ...batch.questions,
          b: { type: "noul", criteria: { true: "Urgent", false: null } },
        },
      });
      expect(new Headers(request().init?.headers).get("authorization")).toBe(
        "Bearer synthetic-prepared-key",
      );
      expect(getImageMetadata).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it.each(["png", "jpeg", "webp"])(
    "sends one top-level %s image with optional text",
    async (mime) => {
      const dataUri = `data:image/${mime};base64,AA==`;
      expect(
        await provider.evaluate({ ...image, state: { type: "image", dataUri } }, context()),
      ).toMatchObject({ status: "ok" });
      expect(request().body).toMatchObject({ state: "", images: [dataUri] });
      expect(getImageMetadata).toHaveBeenCalledWith(Buffer.from([0]));
    },
  );

  it.each([
    [{ width: 3200, height: 3200 }, true],
    [{ width: 3201, height: 3200 }, false],
    [{ width: 3200, height: 32 }, true],
    [{ width: 3201, height: 32 }, false],
    [{ width: 0, height: 32 }, false],
    [null, false],
  ] as const)("enforces decoded image dimensions %j", async (metadata, supported) => {
    getImageMetadata.mockResolvedValue(metadata);
    expect(await provider.evaluate(image, context())).toMatchObject(
      supported ? { status: "ok" } : { reason: "unsupported-input" },
    );
    expect(fetchWithProviderHttpGuard).toHaveBeenCalledTimes(supported ? 1 : 0);
  });

  it.each([4_499_999, 4_500_000])(
    "bounds the complete UTF-8 JSON body at %s bytes",
    async (size) => {
      const dataUri = `data:image/png;base64,${Buffer.alloc(3_374_000).toString("base64")}`;
      const questions = { b: { type: "boolean", instructions: "Match?" } } as const;
      const base = {
        model: "d1-ultra",
        state: "",
        images: [dataUri],
        questions: { b: { type: "noul", instructions: "Match?" } },
      };
      const text = "x".repeat(size - Buffer.byteLength(JSON.stringify(base)));
      respond({ ...wire(), answers: { b: wire().answers.b } });
      const result = await provider.evaluate(
        { state: { type: "image", dataUri, text }, questions },
        context(),
      );
      expect(result).toMatchObject(
        size < 4_500_000 ? { status: "ok" } : { reason: "unsupported-input" },
      );
      expect(fetchWithProviderHttpGuard).toHaveBeenCalledTimes(size < 4_500_000 ? 1 : 0);
      if (size < 4_500_000) {
        expect(Buffer.byteLength(JSON.stringify(request().body))).toBe(size);
      }
    },
  );

  it.each([
    { state: { type: "json", value: null }, questions: batch.questions },
    { state: { type: "json", value: 42 }, questions: batch.questions },
    { state: { type: "list", items: [] }, questions: batch.questions },
    { ...batch, questions: { b: { type: "boolean", criteria: { true: null, false: null } } } },
    { ...image, questions: { b: { type: "box", instructions: "Find it" } } },
  ] satisfies DecisionBatchV2[])(
    "rejects unsupported evidence or questions before HTTP",
    async (input) => {
      expect(await provider.evaluate(input, context())).toMatchObject({
        reason: "unsupported-input",
      });
      expect(fetchWithProviderHttpGuard).not.toHaveBeenCalled();
    },
  );

  it("uses prepared auth and prefix without rereading configured secrets", async () => {
    const ctx = context();
    ctx.model.baseUrl = "https://proxy.example.test/tenant/liquid/";
    ctx.model.headers = { "x-auth-fixture": "synthetic-effective" };
    ctx.config.models = {
      providers: {
        "liquid-ai": {
          baseUrl: "https://not-selected.invalid",
          models: [],
          apiKey: "synthetic-not-selected",
          request: {
            auth: { mode: "header", headerName: "x-auth-fixture", value: "synthetic-not-selected" },
            allowPrivateNetwork: false,
            proxy: { mode: "env-proxy" },
            tls: { ca: "synthetic-ca" },
          },
        },
      },
    };
    await provider.evaluate(batch, ctx);
    expect(request().url).toBe("https://proxy.example.test/tenant/liquid/systemone");
    const headers = new Headers(request().init?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-auth-fixture")).toBe("synthetic-effective");
    // Disabling private-origin trust keeps only the shared hostname-scoped
    // fake-IP allowances; it must not enable arbitrary private destinations.
    expect(request().policy).toEqual({
      allowIpv6UniqueLocalRange: true,
      allowRfc2544BenchmarkRange: true,
      hostnameAllowlist: ["proxy.example.test"],
    });
    expect(request().dispatcherPolicy).toEqual({
      mode: "env-proxy",
      connect: { ca: "synthetic-ca" },
    });
  });

  it.each(["provider", "model", "defaults", "default-model", "agent-model", "agent"])(
    "rejects unsupported %s parameters before inspecting images or sending HTTP",
    async (scope) => {
      const params = { temperature: 0, provider: { data_collection: "deny" } };
      const ctx = context({
        agentId: "worker",
        config: {
          models: {
            providers: {
              "liquid-ai": {
                baseUrl: "https://api.liquid.ai/decisions/v1",
                models: [],
                params: scope === "provider" ? params : undefined,
              },
            },
          },
          agents: {
            defaults: {
              params: scope === "defaults" ? params : undefined,
              models: {
                "liquid-ai/d1-ultra": { params: scope === "default-model" ? params : undefined },
              },
            },
            entries: {
              worker: {
                params: scope === "agent" ? params : undefined,
                models: {
                  "liquid-ai/d1-ultra": { params: scope === "agent-model" ? params : undefined },
                },
              },
            },
          },
        },
      });
      ctx.model.params = scope === "model" ? params : undefined;
      expect(await provider.evaluate(image, ctx)).toMatchObject({ reason: "unsupported-input" });
      expect(getImageMetadata).not.toHaveBeenCalled();
      expect(fetchWithProviderHttpGuard).not.toHaveBeenCalled();
    },
  );

  it("ignores empty parameters and parameters for other agents or models", async () => {
    const ctx = context({ agentId: "worker" });
    ctx.model.params = {};
    ctx.config.agents = {
      defaults: { params: {}, models: { "other/model": { params: { temperature: 0 } } } },
      entries: { worker: { params: {} }, other: { params: { temperature: 0 } } },
    };
    expect(await provider.evaluate(batch, ctx)).toMatchObject({ status: "ok" });
  });

  it.each(["on", "off"] as const)("rejects unsupported reasoning %s", async (reasoning) => {
    expect(await provider.evaluate(batch, { ...context(), reasoning })).toMatchObject({
      reason: "unsupported-input",
    });
    expect(fetchWithProviderHttpGuard).not.toHaveBeenCalled();
  });

  it.each(["unknown-model", "missing-credentials", "expired-deadline"])(
    "rejects %s before HTTP",
    async (failure) => {
      const ctx = context({
        ...(failure === "missing-credentials" ? { auth: { mode: "api-key" } } : {}),
        ...(failure === "expired-deadline" ? { deadlineMonotonicMs: 0 } : {}),
      });
      if (failure === "unknown-model") {
        ctx.model.id = "unsupported";
      }
      expect(await provider.evaluate(batch, ctx)).toMatchObject({ status: "unavailable" });
      expect(fetchWithProviderHttpGuard).not.toHaveBeenCalled();
    },
  );

  it("checks caller authority again after image inspection", async () => {
    const failure = new Error("synthetic revoked authority");
    let active = true;
    getImageMetadata.mockImplementationOnce(async () => {
      active = false;
      return { width: 32, height: 32 };
    });
    await expect(
      provider.evaluate(image, {
        ...context(),
        isAdmissible: () => {
          if (!active) {
            throw failure;
          }
          return true;
        },
      }),
    ).rejects.toBe(failure);
    expect(fetchWithProviderHttpGuard).not.toHaveBeenCalled();
  });

  it("rechecks authority immediately before physical dispatch", async () => {
    const failure = new Error("synthetic revoked authority");
    let active = true;
    const physicalFetch = vi.fn();
    vi.mocked(fetchWithProviderHttpGuard).mockImplementationOnce(async (options) => {
      active = false;
      options.beforeRequest?.();
      physicalFetch();
      return { response: Response.json(wire()), finalUrl: options.url, release };
    });
    await expect(
      provider.evaluate(batch, {
        ...context(),
        isAdmissible: () => {
          if (!active) {
            throw failure;
          }
          return true;
        },
      }),
    ).rejects.toBe(failure);
    expect(physicalFetch).not.toHaveBeenCalled();
  });

  it.each([
    [400, "unsupported-input"],
    [401, "authentication"],
    [403, "authentication"],
    [413, "unsupported-input"],
    [422, "unsupported-input"],
    [429, "rate-limited"],
    [500, "transport"],
  ] as const)("classifies HTTP %s and releases without retry", async (status, reason) => {
    respond({ private: "synthetic-error-body" }, status);
    expect(await provider.evaluate(batch, context())).toEqual({ status: "unavailable", reason });
    expect(fetchWithProviderHttpGuard).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    { answers: {} },
    { usage: { input_tokens: 3, output_tokens: 1 } },
    { usage: { input_tokens: -1, output_tokens: 0 } },
    { padding: "x".repeat(1_048_576) },
  ])("rejects invalid or oversized responses and releases", async (patch) => {
    respond({ ...wire(), ...patch });
    expect(await provider.evaluate(batch, context())).toMatchObject({ reason: "invalid-response" });
    expect(release).toHaveBeenCalledOnce();
  });

  it("awaits physical release before propagating cancellation", async () => {
    const controller = new AbortController();
    const releasing = Promise.withResolvers<void>();
    const drained = Promise.withResolvers<void>();
    release.mockImplementationOnce(async () => {
      releasing.resolve();
      await drained.promise;
    });
    vi.mocked(fetchWithProviderHttpGuard).mockImplementationOnce(async (options) => {
      controller.abort(new Error("synthetic cancellation"));
      return { response: Response.json(wire()), finalUrl: options.url, release };
    });
    const pending = provider.evaluate(batch, { ...context(), signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow("synthetic cancellation");
    await releasing.promise;
    let settled = false;
    void pending.catch(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    drained.resolve();
    await rejected;
  });
});
