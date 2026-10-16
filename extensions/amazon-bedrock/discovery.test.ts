import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverBedrockModels, resolveImplicitBedrockProvider } from "./api.js";

const { sendMock, destroyMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  destroyMock: vi.fn(),
}));
vi.mock("@aws-sdk/client-bedrock", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@aws-sdk/client-bedrock")>()),
  BedrockClient: class {
    send = sendMock;
    destroy = destroyMock;
  },
}));

const baseActiveAnthropicSummary = {
  modelId: "anthropic.claude-3-7-sonnet-20250219-v1:0",
  modelName: "Claude 3.7 Sonnet",
  providerName: "anthropic",
  inputModalities: ["TEXT"],
  outputModalities: ["TEXT"],
  responseStreamingSupported: true,
  modelLifecycle: { status: "ACTIVE" },
};

function buildActiveAnthropicSummary(
  modelId: string,
  modelName: string,
  inputModalities: string[] = ["TEXT"],
): typeof baseActiveAnthropicSummary {
  return { ...baseActiveAnthropicSummary, modelId, modelName, inputModalities };
}

function mockBedrockDiscovery(
  modelSummaries: Record<string, unknown>[],
  inferenceProfileSummaries: Record<string, unknown>[] = [],
): void {
  sendMock
    .mockResolvedValueOnce({ modelSummaries })
    .mockResolvedValueOnce({ inferenceProfileSummaries });
}

function buildBedrockProfile(
  inferenceProfileId: string,
  inferenceProfileName: string,
  foundationModels: string[] = [],
  options: {
    region?: string;
    type?: "SYSTEM_DEFINED" | "APPLICATION";
    status?: "ACTIVE" | "LEGACY";
  } = {},
): Record<string, unknown> {
  const region = options.region ?? "us-east-1";
  return {
    inferenceProfileId,
    inferenceProfileName,
    status: options.status ?? "ACTIVE",
    type: options.type ?? "SYSTEM_DEFINED",
    models: foundationModels.map((model) => ({
      modelArn: model.startsWith("arn:")
        ? model
        : `arn:aws:bedrock:${region}::foundation-model/${model}`,
    })),
  };
}

const sonnetId = "anthropic.claude-sonnet-4-6";
const sonnetSummary = () =>
  buildActiveAnthropicSummary(sonnetId, "Claude Sonnet 4.6", ["TEXT", "IMAGE"]);
function mockProfileOnly(
  id: string,
  name: string,
  foundation: string[],
  options?: Parameters<typeof buildBedrockProfile>[3],
) {
  mockBedrockDiscovery([], [buildBedrockProfile(id, name, foundation, options)]);
}

function mockSingleActiveSummary(overrides: Partial<typeof baseActiveAnthropicSummary> = {}): void {
  mockBedrockDiscovery([{ ...baseActiveAnthropicSummary, ...overrides }]);
}

function expectModelFields(model: unknown, expected: Record<string, unknown>): void {
  expect(model).toEqual(expect.objectContaining(expected));
}

function discoverFreshBedrockModels(
  params: Parameters<typeof discoverBedrockModels>[0] = { region: "us-east-1" },
): ReturnType<typeof discoverBedrockModels> {
  return discoverBedrockModels({
    ...params,
    discoveryMode: "strict",
    config: { ...params.config, refreshInterval: 0 },
  });
}

describe("bedrock discovery", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    sendMock.mockClear();
    destroyMock.mockClear();
  });

  it("filters to active streaming text models and maps modalities", async () => {
    mockBedrockDiscovery([
      buildActiveAnthropicSummary(
        "anthropic.claude-3-7-sonnet-20250219-v1:0",
        "Claude 3.7 Sonnet",
        ["TEXT", "IMAGE"],
      ),
      {
        ...baseActiveAnthropicSummary,
        modelId: "anthropic.claude-3-haiku-20240307-v1:0",
        responseStreamingSupported: false,
      },
      {
        ...baseActiveAnthropicSummary,
        modelId: "meta.llama3-8b-instruct-v1:0",
        modelLifecycle: { status: "INACTIVE" },
      },
      {
        ...baseActiveAnthropicSummary,
        modelId: "amazon.titan-embed-text-v1",
        outputModalities: ["EMBEDDING"],
      },
    ]);

    const models = await discoverFreshBedrockModels();
    expect(models).toHaveLength(1);
    expectModelFields(models[0], {
      id: "anthropic.claude-3-7-sonnet-20250219-v1:0",
      name: "Claude 3.7 Sonnet",
      reasoning: false,
      input: ["text", "image"],
      contextWindow: 200000,
      maxTokens: 4096,
    });
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it("applies provider filter", async () => {
    mockSingleActiveSummary();

    const models = await discoverFreshBedrockModels({
      region: "us-east-1",
      config: { providerFilter: ["amazon"] },
    });
    expect(models).toHaveLength(0);
  });

  it("keeps the conservative fallback for unknown inference profiles", async () => {
    mockProfileOnly(
      "jp.example.unknown-text-v1:0",
      "JP Example Unknown Text",
      ["example.unknown-text-v1:0"],
      { region: "ap-northeast-1" },
    );

    const models = await discoverFreshBedrockModels({ region: "ap-northeast-1" });

    expect(models).toHaveLength(1);
    expectModelFields(models[0], {
      id: "jp.example.unknown-text-v1:0",
      contextWindow: 32000,
      maxTokens: 4096,
      input: ["text"],
    });
  });

  it.each([
    ["opus", "Opus", { xhigh: "xhigh", max: "max" }],
    ["sonnet", "Sonnet", { off: "low", minimal: "low", xhigh: "xhigh", max: "max" }],
  ] as const)(
    "applies the %s 5 inference-profile-only contract",
    async (family, title, thinkingLevelMap) => {
      const canonicalModelId = `claude-${family}-5`;
      const id = `global.anthropic.${canonicalModelId}`;
      mockBedrockDiscovery(
        [],
        [buildBedrockProfile(id, `Global Claude ${title} 5`, [`anthropic.${canonicalModelId}`])],
      );
      const models = await discoverFreshBedrockModels();
      expectModelFields(models[0], {
        id,
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        thinkingLevelMap,
        params: { canonicalModelId },
      });
    },
  );

  it("skips Mythos Preview inference profiles because Mantle owns that route", async () => {
    mockProfileOnly("us.anthropic.claude-mythos-preview", "US Claude Mythos Preview", [
      "anthropic.claude-mythos-preview",
    ]);

    const models = await discoverFreshBedrockModels();

    expect(models).toEqual([]);
  });

  it("uses 1M context window for dotted Claude Opus 4.8 Bedrock refs", async () => {
    mockBedrockDiscovery(
      [buildActiveAnthropicSummary("anthropic.claude-opus-4.8-v1:0", "Claude Opus 4.8")],
      [
        buildBedrockProfile("us.anthropic.claude-opus-4.8-v1:0", "US Claude Opus 4.8", [
          "anthropic.claude-opus-4.8-v1:0",
        ]),
      ],
    );

    const models = await discoverFreshBedrockModels();

    expectModelFields(
      models.find((model) => model.id === "anthropic.claude-opus-4.8-v1:0"),
      {
        contextWindow: 1_000_000,
        reasoning: true,
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      },
    );
    expectModelFields(
      models.find((model) => model.id === "us.anthropic.claude-opus-4.8-v1:0"),
      {
        contextWindow: 1_000_000,
        reasoning: true,
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      },
    );
  });

  it("applies Fable limits and reasoning metadata to foundation and profile models", async () => {
    mockBedrockDiscovery(
      [
        buildActiveAnthropicSummary("anthropic.claude-fable-5", "Claude Fable 5", [
          "TEXT",
          "IMAGE",
        ]),
      ],
      [
        buildBedrockProfile("company-fable", "Company Fable", ["anthropic.claude-fable-5"], {
          type: "APPLICATION",
        }),
      ],
    );

    const models = await discoverFreshBedrockModels();
    const expected = {
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      thinkingLevelMap: { off: "low", minimal: "low", xhigh: "xhigh", max: "max" },
    };

    expectModelFields(
      models.find((model) => model.id === "anthropic.claude-fable-5"),
      expected,
    );
    expectModelFields(
      models.find((model) => model.id === "company-fable"),
      {
        ...expected,
        params: { canonicalModelId: "claude-fable-5" },
      },
    );
  });

  it("aborts stalled Bedrock model discovery requests", async () => {
    vi.useFakeTimers();
    const abortSignals: AbortSignal[] = [];
    try {
      sendMock.mockImplementation((_command: unknown, options?: { abortSignal?: AbortSignal }) => {
        const signal = options?.abortSignal;
        if (!signal) {
          throw new Error("expected Bedrock discovery abort signal");
        }
        abortSignals.push(signal);
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
            },
            { once: true },
          );
        });
      });

      const discovery = discoverFreshBedrockModels({ region: "abort-timeout" });
      const rejected = expect(discovery).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(30_000);

      await rejected;
      expect(sendMock).toHaveBeenCalledTimes(2);
      expect(abortSignals).toHaveLength(2);
      expect(abortSignals.every((signal) => signal.aborted)).toBe(true);
      expect(destroyMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("discovers inference profiles and inherits foundation model capabilities", async () => {
    const foundationId = "anthropic.claude-sonnet-4-6";
    mockBedrockDiscovery(
      [buildActiveAnthropicSummary(foundationId, "Claude Sonnet 4.6", ["TEXT", "IMAGE"])],
      [
        buildBedrockProfile("us.anthropic.claude-sonnet-4-6", "US Anthropic Claude Sonnet 4.6", [
          foundationId,
          "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-6",
        ]),
        buildBedrockProfile(
          "global.anthropic.claude-sonnet-4-6",
          "Global Anthropic Claude Sonnet 4.6",
          [foundationId],
        ),
        buildBedrockProfile("ap.anthropic.claude-sonnet-4-6", "AP Claude Sonnet 4.6", [], {
          status: "LEGACY",
        }),
      ],
    );

    const models = await discoverFreshBedrockModels();

    expect(models).toHaveLength(3);
    expect(models[0]?.id).toBe("global.anthropic.claude-sonnet-4-6");

    const foundationModel = models.find((m) => m.id === "anthropic.claude-sonnet-4-6");
    const usProfile = models.find((m) => m.id === "us.anthropic.claude-sonnet-4-6");
    const globalProfile = models.find((m) => m.id === "global.anthropic.claude-sonnet-4-6");

    expectModelFields(foundationModel, { input: ["text", "image"] });

    expectModelFields(usProfile, {
      name: "US Anthropic Claude Sonnet 4.6",
      input: ["text", "image"],
      contextWindow: 1000000,
      maxTokens: 4096,
      params: { canonicalModelId: "claude-sonnet-4-6" },
    });
    expect(usProfile?.thinkingLevelMap).toBeUndefined();
    expectModelFields(globalProfile, { input: ["text", "image"] });

    expect(models.find((m) => m.id === "ap.anthropic.claude-sonnet-4-6")).toBeUndefined();
  });

  it("rejects failed profile-page acquisition and retries the complete catalog", async () => {
    const failure = Object.assign(new Error("AccessDeniedException"), {
      $metadata: { httpStatusCode: 403 },
    });
    const profile = buildBedrockProfile("us.amazon.nova-micro-v1:0", "US Nova", [
      "amazon.nova-micro-v1:0",
    ]);
    sendMock
      .mockResolvedValueOnce({ modelSummaries: [baseActiveAnthropicSummary] })
      .mockResolvedValueOnce({ inferenceProfileSummaries: [profile], nextToken: "next-page" })
      .mockRejectedValueOnce(failure);
    const params = { region: "failed-profile-page", discoveryMode: "strict" as const };
    await expect(discoverBedrockModels(params)).rejects.toMatchObject({ status: 403 });
    expect(destroyMock).toHaveBeenCalledTimes(1);

    mockBedrockDiscovery([baseActiveAnthropicSummary], [profile]);
    const recovered = await discoverBedrockModels(params);
    expect(recovered.map((model) => model.id)).toEqual([
      baseActiveAnthropicSummary.modelId,
      profile.inferenceProfileId,
    ]);
    expect(destroyMock).toHaveBeenCalledTimes(2);
  });

  it("preserves the advisory empty-result contract and caches it", async () => {
    mockBedrockDiscovery([]);
    const params = {
      pluginConfig: { discovery: { enabled: true, region: "successful-empty-advisory" } },
      env: {},
    };
    await expect(resolveImplicitBedrockProvider(params)).resolves.toBeNull();
    await expect(resolveImplicitBedrockProvider(params)).resolves.toBeNull();
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it.each(["foundation", "profiles"])(
    "preserves public %s failure defaults without caching incomplete inventory",
    async (surface) => {
      const failure = new Error("catalog unavailable");
      if (surface === "foundation") {
        sendMock.mockRejectedValueOnce(failure).mockResolvedValueOnce({});
      } else {
        sendMock
          .mockResolvedValueOnce({ modelSummaries: [baseActiveAnthropicSummary] })
          .mockRejectedValueOnce(failure);
      }
      const params = { region: `advisory-${surface}` };
      const initial = await discoverBedrockModels(params);
      expect(initial.map((model) => model.id)).toEqual(
        surface === "foundation" ? [] : [baseActiveAnthropicSummary.modelId],
      );
      mockBedrockDiscovery(
        [baseActiveAnthropicSummary],
        [buildBedrockProfile("us.amazon.nova-micro-v1:0", "US Nova", ["amazon.nova-micro-v1:0"])],
      );
      expect(await discoverBedrockModels(params)).toHaveLength(2);
      expect(sendMock).toHaveBeenCalledTimes(4);
      expect(destroyMock).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps strict callers out of an advisory in-flight failure", async () => {
    const started = createDeferred<void>();
    const profiles = createDeferred<never>();
    const failure = Object.assign(new Error("AccessDeniedException"), {
      $metadata: { httpStatusCode: 403 },
    });
    sendMock
      .mockResolvedValueOnce({ modelSummaries: [baseActiveAnthropicSummary] })
      .mockImplementationOnce(() => {
        started.resolve();
        return profiles.promise;
      })
      .mockResolvedValueOnce({ modelSummaries: [baseActiveAnthropicSummary] })
      .mockRejectedValueOnce(failure);
    const params = { region: "advisory-strict-in-flight" };
    const advisory = discoverBedrockModels(params);
    await started.promise;
    await expect(
      discoverBedrockModels({ ...params, discoveryMode: "strict" }),
    ).rejects.toMatchObject({ status: 403 });
    profiles.reject(failure);
    await expect(advisory).resolves.toMatchObject([{ id: baseActiveAnthropicSummary.modelId }]);
    mockBedrockDiscovery([baseActiveAnthropicSummary]);
    await expect(
      discoverBedrockModels({ ...params, discoveryMode: "strict" }),
    ).resolves.toMatchObject([{ id: baseActiveAnthropicSummary.modelId }]);
    expect(sendMock).toHaveBeenCalledTimes(6);
    expect(destroyMock).toHaveBeenCalledTimes(3);
  });

  it.each([false, undefined])(
    "keeps non-attempt discovery null when enabled is %s",
    async (enabled) => {
      await expect(
        resolveImplicitBedrockProvider({
          pluginConfig: { discovery: { enabled } },
          env: {},
        }),
      ).resolves.toBeNull();
      expect(sendMock).not.toHaveBeenCalled();
    },
  );

  it("keeps matching inference profiles when provider filters are enabled", async () => {
    mockBedrockDiscovery(
      [sonnetSummary()],
      [
        buildBedrockProfile(
          "global.anthropic.claude-sonnet-4-6",
          "Global Anthropic Claude Sonnet 4.6",
          ["anthropic.claude-sonnet-4-6"],
        ),
      ],
    );

    const models = await discoverFreshBedrockModels({
      region: "us-east-1",
      config: { providerFilter: ["anthropic"] },
    });

    expect(models.map((model) => model.id)).toEqual([
      "global.anthropic.claude-sonnet-4-6",
      "anthropic.claude-sonnet-4-6",
    ]);
  });

  it("uses the plugin default when both region env overrides are blank", async () => {
    mockSingleActiveSummary();
    const provider = await resolveImplicitBedrockProvider({
      pluginConfig: { discovery: { enabled: true, refreshInterval: 0 } },
      env: { AWS_REGION: "", AWS_DEFAULT_REGION: "   " },
    });
    expect(provider?.baseUrl).toBe("https://bedrock-runtime.us-east-1.amazonaws.com");
  });

  // Ported from #65449 by @alickgithub2 — extended to also cover apac. prefix
  it("resolves au. and apac. prefixes for regional inference profiles", async () => {
    mockBedrockDiscovery(
      [sonnetSummary()],
      [
        // Empty model ARNs intentionally force the regional prefix fallback.
        buildBedrockProfile("au.anthropic.claude-sonnet-4-6", "AU Anthropic Claude Sonnet 4.6"),
        buildBedrockProfile("apac.anthropic.claude-sonnet-4-6", "APAC Anthropic Claude Sonnet 4.6"),
      ],
    );

    const models = await discoverFreshBedrockModels({ region: "ap-southeast-2" });

    expect(models).toHaveLength(3);

    const auProfile = models.find((m) => m.id === "au.anthropic.claude-sonnet-4-6");
    expectModelFields(auProfile, {
      id: "au.anthropic.claude-sonnet-4-6",
      name: "AU Anthropic Claude Sonnet 4.6",
      input: ["text", "image"],
    });

    const apacProfile = models.find((m) => m.id === "apac.anthropic.claude-sonnet-4-6");
    expectModelFields(apacProfile, {
      id: "apac.anthropic.claude-sonnet-4-6",
      name: "APAC Anthropic Claude Sonnet 4.6",
      input: ["text", "image"],
    });
  });
});
