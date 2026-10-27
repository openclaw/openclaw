import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { BedrockDiscoveryConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

const activeFoundation = {
  modelId: "anthropic.claude-3-7-sonnet-20250219-v1:0",
  modelName: "Claude 3.7 Sonnet",
  providerName: "anthropic",
  inputModalities: ["TEXT"],
  outputModalities: ["TEXT"],
  responseStreamingSupported: true,
  modelLifecycle: { status: "ACTIVE" },
};

function foundation(
  modelId = activeFoundation.modelId,
  overrides: Partial<typeof activeFoundation> = {},
): typeof activeFoundation {
  return { ...activeFoundation, modelId, ...overrides };
}

function mockDiscovery(
  modelSummaries: Record<string, unknown>[],
  inferenceProfileSummaries: Record<string, unknown>[] = [],
): void {
  sendMock
    .mockResolvedValueOnce({ modelSummaries })
    .mockResolvedValueOnce({ inferenceProfileSummaries });
}

function profile(
  inferenceProfileId: string,
  foundationModels: string[] = [],
  options: {
    name?: string;
    region?: string;
    type?: "SYSTEM_DEFINED" | "APPLICATION";
    status?: "ACTIVE" | "LEGACY";
  } = {},
): Record<string, unknown> {
  const region = options.region ?? "us-east-1";
  return {
    inferenceProfileId,
    inferenceProfileName: options.name ?? inferenceProfileId,
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
  return profile(`${prefix}.${sonnetId}`, models, {
    name: `${title} Anthropic Claude Sonnet 4.6`,
  });
}
const sonnetSummary = () => foundation(sonnetId, { inputModalities: ["TEXT", "IMAGE"] });
const novaProfile = profile("us.amazon.nova-micro-v1:0", ["amazon.nova-micro-v1:0"]);
const accessDenied = () =>
  Object.assign(new Error("AccessDeniedException"), { $metadata: { httpStatusCode: 403 } });
const resolveImplicit = (discovery: BedrockDiscoveryConfig, env: NodeJS.ProcessEnv = {}) =>
  resolveImplicitBedrockProvider({ pluginConfig: { discovery }, env });

function expectFields(model: unknown, expected: Record<string, unknown>): void {
  expect(model).toEqual(expect.objectContaining(expected));
}
function expectModel(
  models: Awaited<ReturnType<typeof discoverBedrockModels>>,
  id: string,
  expected: Record<string, unknown>,
) {
  expectFields(
    models.find((model) => model.id === id),
    expected,
  );
}

function discoverFresh(
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
  params: Parameters<typeof discoverFresh>[0] = { region: "us-east-1" },
) {
  mockDiscovery(foundations, profiles);
  return discoverFresh(params);
}

afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  sendMock.mockClear();
  destroyMock.mockClear();
});

it("filters to active streaming text models and maps modalities", async () => {
  const models = await discoverFixture([
    foundation(undefined, { inputModalities: ["TEXT", "IMAGE"] }),
    foundation("anthropic.claude-3-haiku-20240307-v1:0", {
      responseStreamingSupported: false,
    }),
    foundation("meta.llama3-8b-instruct-v1:0", {
      modelLifecycle: { status: "INACTIVE" },
    }),
    foundation("amazon.titan-embed-text-v1", {
      outputModalities: ["EMBEDDING"],
    }),
  ]);
  expect(models).toHaveLength(1);
  expectFields(models[0], {
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
  const models = await discoverFixture(
    [],
    [
      profile("jp.example.unknown-text-v1:0", ["example.unknown-text-v1:0"], {
        region: "ap-northeast-1",
      }),
    ],
    { region: "ap-northeast-1" },
  );
  expect(models).toHaveLength(1);
  expectFields(models[0], {
    id: "jp.example.unknown-text-v1:0",
    contextWindow: 32000,
    maxTokens: 4096,
    input: ["text"],
  });
});

it.each([
  ["opus", { xhigh: "xhigh", max: "max" }],
  ["sonnet", { off: "low", minimal: "low", xhigh: "xhigh", max: "max" }],
] as const)("%s 5 profile-only capabilities", async (family, thinkingLevelMap) => {
  const canonicalModelId = `claude-${family}-5`;
  const id = `global.anthropic.${canonicalModelId}`;
  const models = await discoverFixture([], [profile(id, [`anthropic.${canonicalModelId}`])]);
  expectFields(models[0], {
    id,
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    thinkingLevelMap,
    params: { canonicalModelId },
  });
});

it("skips Mythos Preview inference profiles because Mantle owns that route", async () => {
  const models = await discoverFixture(
    [],
    [profile("us.anthropic.claude-mythos-preview", ["anthropic.claude-mythos-preview"])],
  );
  expect(models).toEqual([]);
});

it.each([
  [
    opusId,
    `us.${opusId}`,
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
    "company-fable",
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
  "inherits %s foundation and profile capabilities",
  async (id, profileId, input, type, expected, profileFields) => {
    const models = await discoverFixture(
      [foundation(id, { inputModalities: [...input] })],
      [profile(profileId, [id], { type })],
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
    const discovery = discoverFresh({ region: "abort-timeout" });
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
  const models = await discoverFixture(
    [sonnetSummary()],
    [
      sonnetProfile("us", [sonnetId, `arn:aws:bedrock:us-west-2::foundation-model/${sonnetId}`]),
      sonnetProfile("global"),
      profile(`ap.${sonnetId}`, [], {
        status: "LEGACY",
      }),
    ],
  );
  expect(models).toHaveLength(3);
  expect(models[0]?.id).toBe(`global.${sonnetId}`);
  expectModel(models, sonnetId, { input: ["text", "image"] });
  expectModel(models, `us.${sonnetId}`, {
    name: "US Anthropic Claude Sonnet 4.6",
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 4096,
    params: { canonicalModelId: "claude-sonnet-4-6" },
  });
  expect(models.find((model) => model.id === `us.${sonnetId}`)?.thinkingLevelMap).toBeUndefined();
  expectModel(models, `global.${sonnetId}`, { input: ["text", "image"] });
  expect(models.find((m) => m.id === `ap.${sonnetId}`)).toBeUndefined();
});

it("rejects failed profile-page acquisition and retries the complete catalog", async () => {
  const failure = accessDenied();
  sendMock
    .mockResolvedValueOnce({ modelSummaries: [activeFoundation] })
    .mockResolvedValueOnce({ inferenceProfileSummaries: [novaProfile], nextToken: "next-page" })
    .mockRejectedValueOnce(failure);
  const params = { region: "failed-profile-page", discoveryMode: "strict" as const };
  await expect(discoverBedrockModels(params)).rejects.toMatchObject({ status: 403 });
  expect(destroyMock).toHaveBeenCalledTimes(1);
  mockDiscovery([activeFoundation], [novaProfile]);
  const recovered = await discoverBedrockModels(params);
  expect(recovered.map((model) => model.id)).toEqual([
    activeFoundation.modelId,
    novaProfile.inferenceProfileId,
  ]);
  expect(destroyMock).toHaveBeenCalledTimes(2);
});

it("preserves the advisory empty-result contract and caches it", async () => {
  mockDiscovery([]);
  const config = { enabled: true, region: "successful-empty-advisory" };
  await expect(resolveImplicit(config)).resolves.toBeNull();
  await expect(resolveImplicit(config)).resolves.toBeNull();
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
        .mockResolvedValueOnce({ modelSummaries: [activeFoundation] })
        .mockRejectedValueOnce(failure);
    }
    const params = { region: `advisory-${surface}` };
    const initial = await discoverBedrockModels(params);
    expect(initial.map((model) => model.id)).toEqual(
      surface === "foundation" ? [] : [activeFoundation.modelId],
    );
    mockDiscovery([activeFoundation], [novaProfile]);
    expect(await discoverBedrockModels(params)).toHaveLength(2);
    expect(sendMock).toHaveBeenCalledTimes(4);
    expect(destroyMock).toHaveBeenCalledTimes(2);
  },
);

it("keeps strict callers out of an advisory in-flight failure", async () => {
  const started = createDeferred<void>();
  const profiles = createDeferred<never>();
  const failure = accessDenied();
  sendMock
    .mockResolvedValueOnce({ modelSummaries: [activeFoundation] })
    .mockImplementationOnce(() => {
      started.resolve();
      return profiles.promise;
    })
    .mockResolvedValueOnce({ modelSummaries: [activeFoundation] })
    .mockRejectedValueOnce(failure);
  const params = { region: "advisory-strict-in-flight" };
  const advisory = discoverBedrockModels(params);
  await started.promise;
  await expect(discoverBedrockModels({ ...params, discoveryMode: "strict" })).rejects.toMatchObject(
    { status: 403 },
  );
  profiles.reject(failure);
  await expect(advisory).resolves.toMatchObject([{ id: activeFoundation.modelId }]);
  mockDiscovery([activeFoundation]);
  await expect(
    discoverBedrockModels({ ...params, discoveryMode: "strict" }),
  ).resolves.toMatchObject([{ id: activeFoundation.modelId }]);
  expect(sendMock).toHaveBeenCalledTimes(6);
  expect(destroyMock).toHaveBeenCalledTimes(3);
});

it.each([false, undefined])(
  "returns null without discovery when enabled is %s",
  async (enabled) => {
    await expect(resolveImplicit({ enabled })).resolves.toBeNull();
    expect(sendMock).not.toHaveBeenCalled();
  },
);

it("uses the plugin default when both region env overrides are blank", async () => {
  mockDiscovery([activeFoundation]);
  const provider = await resolveImplicit(
    { enabled: true, refreshInterval: 0 },
    { AWS_REGION: "", AWS_DEFAULT_REGION: "   " },
  );
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
