import * as bedrockRuntimeSdk from "@aws-sdk/client-bedrock-runtime";
import { NodeHttp2Handler } from "@smithy/node-http-handler";
import { afterEach, expect, it, vi } from "vitest";
import { createBedrockEmbeddingProvider, hasAwsCredentials } from "./embedding-provider.js";

vi.mock("@aws-sdk/client-bedrock-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-bedrock-runtime")>();
  // Whole-module autospies mutate the Smithy prototype shared with control-plane clients.
  return { ...actual, BedrockRuntimeClient: vi.fn(actual.BedrockRuntimeClient) };
});

afterEach(() => {
  vi.mocked(bedrockRuntimeSdk.BedrockRuntimeClient).mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const east = "https://bedrock-runtime.us-east-1.amazonaws.com";
const privateHost = "vpce-memory.bedrock-runtime.us-east-1.vpce.amazonaws.com";
const privateUrl = `https://${privateHost}`;
const sdkHost = "vpce-environment.bedrock-runtime.us-east-1.vpce.amazonaws.com";
const isoHost = "bedrock-runtime.us-iso-east-1.c2s.ic.gov";
type EndpointOptions = {
  signingRegion?: string;
  remoteBaseUrl?: string;
  providerBaseUrl?: string | null;
  sdkEndpoint?: string;
  fips?: boolean;
  dualstack?: boolean;
  expectedError?: string;
};
const euPrivate = "vpce-memory.bedrock-runtime.eu-west-1.vpce.amazonaws.com";
const govFips = "bedrock-runtime-fips.us-gov-west-1.amazonaws.com";
const fipsOptions = { fips: true };
const dual = { dualstack: true };
const privateEndpoint = { remoteBaseUrl: privateUrl, providerBaseUrl: null };
const iso = { signingRegion: "us-iso-east-1" };
const memoryOptions = {
  remoteBaseUrl: `https://${euPrivate}`,
  providerBaseUrl: "https://vpce-provider.bedrock-runtime.us-east-1.vpce.amazonaws.com",
  signingRegion: "eu-west-1",
  sdkEndpoint: `https://${sdkHost}`,
};
const westFips = {
  ...fipsOptions,
  providerBaseUrl: "https://bedrock-runtime.us-west-2.api.aws",
  signingRegion: "us-west-2",
};
const govOptions = {
  providerBaseUrl: `https://${govFips}`,
  signingRegion: "us-gov-west-1",
};
const isoPrivate = {
  ...iso,
  providerBaseUrl: null,
  remoteBaseUrl: `https://vpce-memory.${isoHost}`,
};
const isoDual = {
  ...iso,
  providerBaseUrl: `https://${isoHost}`,
  dualstack: true,
  expectedError: "DualStack is enabled but this partition does not support DualStack",
};
const sdkOptions = { sdkEndpoint: `https://${sdkHost}` };
const incompatible = (mode: "fips" | "dualstack") => ({
  ...privateEndpoint,
  [mode]: true,
  expectedError: `Invalid Configuration: ${mode === "fips" ? "FIPS" : "Dualstack"} and custom endpoint are not supported`,
});

it.each<[string, string, EndpointOptions]>([
  ["memory endpoint wins", euPrivate, memoryOptions],
  ["regional FIPS", "bedrock-runtime-fips.us-east-1.amazonaws.com", fipsOptions],
  ["regional dual-stack", "bedrock-runtime.us-east-1.api.aws", dual],
  ["dual-stack with FIPS", "bedrock-runtime-fips.us-west-2.api.aws", westFips],
  ["GovCloud FIPS", govFips, govOptions],
  ["ISO PrivateLink", `vpce-memory.${isoHost}`, isoPrivate],
  ["ISO rejects dual-stack", isoHost, isoDual],
  ["SDK PrivateLink", sdkHost, sdkOptions],
  ["PrivateLink rejects FIPS", privateHost, incompatible("fips")],
  ["PrivateLink rejects dual-stack", privateHost, incompatible("dualstack")],
])("sends signed requests to %s", async (_name, hostname, testCase) => {
  const { remoteBaseUrl, signingRegion = "us-east-1", sdkEndpoint, fips, dualstack } = testCase;
  const providerBaseUrl =
    testCase.providerBaseUrl === null ? undefined : (testCase.providerBaseUrl ?? east);
  vi.stubEnv("AWS_REGION", "us-east-1");
  vi.stubEnv("AWS_DEFAULT_REGION", undefined);
  vi.stubEnv("AWS_PROFILE", undefined);
  vi.stubEnv("AWS_ACCESS_KEY_ID", "BEDROCK_QA_FIXTURE_ACCESS");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "bedrock-qa-fixture-secret");
  vi.stubEnv("AWS_SESSION_TOKEN", undefined);
  vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", undefined);
  vi.stubEnv("AWS_ENDPOINT_URL", undefined);
  vi.stubEnv("AWS_ENDPOINT_URL_BEDROCK_RUNTIME", sdkEndpoint);
  vi.stubEnv("AWS_USE_FIPS_ENDPOINT", fips ? "true" : undefined);
  vi.stubEnv("AWS_USE_DUALSTACK_ENDPOINT", dualstack ? "true" : undefined);

  if (signingRegion === "us-iso-east-1") {
    const { BedrockRuntimeClient: Client } = await vi.importActual<typeof bedrockRuntimeSdk>(
      "@aws-sdk/client-bedrock-runtime",
    );
    vi.mocked(bedrockRuntimeSdk.BedrockRuntimeClient).mockImplementation(
      class extends Client {
        constructor(...args: ConstructorParameters<typeof Client>) {
          super(...args);
          const endpointProvider = this.config.endpointProvider.bind(this.config);
          vi.spyOn(this.config, "endpointProvider").mockImplementation((parameters, context) => {
            if (
              parameters.Region === "us-iso-east-1" &&
              !parameters.Endpoint &&
              (parameters.UseFIPS || parameters.UseDualStack)
            ) {
              const unsupportedMode = parameters.UseFIPS ? "FIPS" : "DualStack";
              throw new Error(
                `${unsupportedMode} is enabled but this partition does not support ${unsupportedMode}`,
              );
            }
            return endpointProvider(parameters, context);
          });
        }
      },
    );
  }

  const observedRequests: Array<{ hostname: string; authorization: string | undefined }> = [];
  vi.spyOn(NodeHttp2Handler.prototype, "handle").mockImplementation(async (request) => {
    observedRequests.push({
      hostname: request.hostname,
      authorization: request.headers.authorization,
    });
    return {
      response: {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({ embedding: [3, 4] })),
      },
    };
  });

  const providers: Record<string, { baseUrl: string; models: [] }> = providerBaseUrl
    ? { "amazon-bedrock": { baseUrl: providerBaseUrl, models: [] } }
    : {};
  const { provider } = await createBedrockEmbeddingProvider({
    config: { models: { providers } },
    ...(remoteBaseUrl ? { remote: { baseUrl: remoteBaseUrl } } : {}),
    model: "amazon.titan-embed-text-v2:0",
  });

  if (testCase.expectedError !== undefined) {
    await expect(provider.embed("private memory", { inputType: "query" })).rejects.toThrow(
      testCase.expectedError,
    );
    expect(observedRequests).toEqual([]);
    return;
  }

  await expect(provider.embed("memory", { inputType: "query" })).resolves.toEqual([0.6, 0.8]);
  expect(observedRequests).toEqual([
    {
      hostname,
      authorization: expect.stringMatching(
        /^AWS4-HMAC-SHA256 Credential=BEDROCK_QA_FIXTURE_ACCESS\//,
      ),
    },
  ]);
  expect(observedRequests[0]?.authorization).toContain(`/${signingRegion}/bedrock/aws4_request`);
});

it.each([
  [
    "static keys",
    { AWS_ACCESS_KEY_ID: "access-key", AWS_SECRET_ACCESS_KEY: "secret-key" },
    undefined,
    true,
    0,
  ],
  ["bearer token", { AWS_BEARER_TOKEN_BEDROCK: "bearer-token" }, undefined, true, 0],
  [
    "resolved profile",
    { AWS_PROFILE: "work" },
    () => async () => ({ accessKeyId: "resolved-access-key" }),
    true,
    1,
  ],
  [
    "unresolved profile",
    { AWS_PROFILE: "missing" },
    () => async () => {
      throw new Error("Could not load credentials from any providers");
    },
    false,
    1,
  ],
  ["unavailable package", {}, null, false, 1],
] as const)("handles %s", async (_name, env, loadedProvider, expected, calls) => {
  const loadCredentialProvider = vi.fn().mockResolvedValue(loadedProvider);
  await expect(hasAwsCredentials(env, loadCredentialProvider)).resolves.toBe(expected);
  expect(loadCredentialProvider).toHaveBeenCalledTimes(calls);
});

const titan = "amazon.titan-embed-text-v2:0";
const cohere = "cohere.embed-english-v3";
const badUtf8 = Buffer.from('{"ignored":"bad\xff","embedding":[3,4]}', "latin1");
it.each([
  ["non-object JSON", titan, "[]"],
  ["invalid single vector element", titan, '{"embedding":[1,"bad"]}'],
  ["missing batch vectors", cohere, "{}"],
  ["invalid batch vector shape", cohere, '{"embeddings":[[1],{"bad":true}]}'],
  ["nonfinite later batch vector", cohere, '{"embeddings":[[3,4],[1e309]]}'],
  ["invalid UTF-8", titan, badUtf8],
] as const)("rejects %s through the provider boundary", async (_name, model, raw) => {
  vi.spyOn(bedrockRuntimeSdk.BedrockRuntimeClient.prototype, "send").mockResolvedValue({
    body: typeof raw === "string" ? new TextEncoder().encode(raw) : raw,
  } as never);
  const { provider } = await createBedrockEmbeddingProvider({ config: {}, model });
  const request = model.startsWith("cohere.")
    ? provider.embedBatch(["private memory"], { inputType: "document" })
    : provider.embed("private memory", { inputType: "query" });

  await expect(request).rejects.toThrow(
    "Amazon Bedrock embedding response returned malformed JSON",
  );
});

it.each([
  {
    model: cohere,
    queryResponse: '{"embeddings":[[3,4]]}',
    batchResponse: '{"embeddings":[[0,2],[3,4]]}',
    dimensions: 1024,
    requestFields: {},
    maxInputTokens: 512,
  },
  {
    model: "global.cohere.embed-v4:0",
    queryResponse: '{"embeddings":{"float":[[3,4]]}}',
    batchResponse: '{"embeddings":{"float":[[0,2],[3,4]]}}',
    dimensions: 1536,
    requestFields: { embedding_types: ["float"], output_dimension: 1536 },
    maxInputTokens: 128_000,
  },
])("preserves $model query and document batch contracts", async (testCase) => {
  const { model, queryResponse, batchResponse, dimensions, requestFields, maxInputTokens } =
    testCase;
  const send = vi
    .spyOn(bedrockRuntimeSdk.BedrockRuntimeClient.prototype, "send")
    .mockResolvedValueOnce({
      body: new TextEncoder().encode(queryResponse),
    } as never)
    .mockResolvedValueOnce({
      body: new TextEncoder().encode(batchResponse),
    } as never);
  const { provider, client } = await createBedrockEmbeddingProvider({ config: {}, model });

  await expect(provider.embed("memory", { inputType: "query" })).resolves.toEqual([0.6, 0.8]);
  await expect(
    provider.embedBatch(["first", "second"], { inputType: "document" }),
  ).resolves.toEqual([
    [0, 1],
    [0.6, 0.8],
  ]);

  expect(send).toHaveBeenCalledTimes(2);
  for (const [index, request] of [
    { texts: ["memory"], input_type: "search_query" },
    { texts: ["first", "second"], input_type: "search_document" },
  ].entries()) {
    const input = send.mock.calls[index]?.[0]?.input;
    if (!input || !("body" in input) || typeof input.body !== "string") {
      throw new Error("Expected a JSON embedding request body");
    }
    expect(JSON.parse(input.body)).toEqual({ ...request, truncate: "END", ...requestFields });
    expect(input).toMatchObject({ modelId: model });
  }
  expect(client).toMatchObject({ model, dimensions });
  expect(provider.maxInputTokens).toBe(maxInputTokens);
});
