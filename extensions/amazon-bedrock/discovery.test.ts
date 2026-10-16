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
const opusId = "anthropic.claude-opus-4.8-v1:0";
const fableId = "anthropic.claude-fable-5";
function sonnetProfile(prefix: string, models = [sonnetId]) {
  const title = prefix === "global" ? "Global" : prefix.toUpperCase();
  return buildBedrockProfile(
    `${prefix}.${sonnetId}`,
    `${title} Anthropic Claude Sonnet 4.6`,
    models,
  );
}
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

function expectModelFields(model: unknown, expected: Record<string, unknown>): void {
  expect(model).toEqual(expect.objectContaining(expected));
}
function expectModel(
  models: Awaited<ReturnType<typeof discoverBedrockModels>>,
  id: string,
  expected: Record<string, unknown>,
) {
  expectModelFields(
    models.find((model) => model.id === id),
    expected,
  );
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

async function discoverFixture(
  foundations: Record<string, unknown>[],
  profiles: Record<string, unknown>[] = [],
  params: Parameters<typeof discoverFreshBedrockModels>[0] = { region: "us-east-1" },
) {
  mockBedrockDiscovery(foundations, profiles);
  return discoverFreshBedrockModels(params);
}

describe("bedrock discovery", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    sendMock.mockClear();
    destroyMock.mockClear();
  });

  it("filters to active streaming text models and maps modalities", async () => {
    const models = await discoverFixture([
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

  it.each([
    ["amazon", []],
    ["anthropic", [`global.${sonnetId}`, sonnetId]],
  ] as const)("applies the %s filter to foundations and profiles", async (provider, expected) => {
    const models = await discoverFixture([sonnetSummary()], [sonnetProfile("global")], {
      region: "us-east-1",
      config: { providerFilter: [provider] },
    });
    expect(models.map((model) => model.id)).toEqual(expected);
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

  it.each([
    [
      opusId,
      "Claude Opus 4.8",
      `us.${opusId}`,
      "US Claude Opus 4.8",
      ["TEXT"],
      "SYSTEM_DEFINED",
      {
        contextWindow: 1_000_000,
        reasoning: true,
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      },
      {},
    ],
    [
      fableId,
      "Claude Fable 5",
      "company-fable",
      "Company Fable",
      ["TEXT", "IMAGE"],
      "APPLICATION",
      {
        contextWindow: 1_000_000,
        reasoning: true,
        maxTokens: 128_000,
        thinkingLevelMap: { off: "low", minimal: "low", xhigh: "xhigh", max: "max" },
      },
      { params: { canonicalModelId: "claude-fable-5" } },
    ],
  ] as const)(
    "inherits %s capabilities in foundation and profile discovery",
    async (id, name, profileId, profileName, input, type, expected, profileFields) => {
      const models = await discoverFixture(
        [buildActiveAnthropicSummary(id, name, [...input])],
        [buildBedrockProfile(profileId, profileName, [id], { type })],
      );
      expectModel(models, id, expected);
      expectModel(models, profileId, { ...expected, ...profileFields });
    },
  );

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
    const models = await discoverFixture(
      [buildActiveAnthropicSummary(foundationId, "Claude Sonnet 4.6", ["TEXT", "IMAGE"])],
      [
        sonnetProfile("us", [
          foundationId,
          `arn:aws:bedrock:us-west-2::foundation-model/${foundationId}`,
        ]),
        sonnetProfile("global"),
        buildBedrockProfile("ap.anthropic.claude-sonnet-4-6", "AP Claude Sonnet 4.6", [], {
          status: "LEGACY",
        }),
      ],
    );

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

  it("uses the plugin default when both region env overrides are blank", async () => {
    mockBedrockDiscovery([baseActiveAnthropicSummary]);
    const provider = await resolveImplicitBedrockProvider({
      pluginConfig: { discovery: { enabled: true, refreshInterval: 0 } },
      env: { AWS_REGION: "", AWS_DEFAULT_REGION: "   " },
    });
    expect(provider?.baseUrl).toBe("https://bedrock-runtime.us-east-1.amazonaws.com");
  });

  // Ported from #65449 by @alickgithub2 — extended to also cover apac. prefix
  it("resolves au. and apac. prefixes for regional inference profiles", async () => {
    const models = await discoverFixture(
      [sonnetSummary()],
      [
        // Empty model ARNs intentionally force the regional prefix fallback.
        sonnetProfile("au", []),
        sonnetProfile("apac", []),
      ],
      { region: "ap-southeast-2" },
    );

    expect(models).toHaveLength(3);

    for (const prefix of ["au", "apac"]) {
      const id = `${prefix}.${sonnetId}`;
      expectModel(models, id, {
        id,
        name: `${prefix.toUpperCase()} Anthropic Claude Sonnet 4.6`,
        input: ["text", "image"],
      });
    }
  });
});
