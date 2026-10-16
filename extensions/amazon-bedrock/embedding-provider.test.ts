import * as bedrockRuntimeSdk from "@aws-sdk/client-bedrock-runtime";
import { NodeHttp2Handler } from "@smithy/node-http-handler";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBedrockEmbeddingProvider, hasAwsCredentials } from "./embedding-provider.js";

vi.mock("@aws-sdk/client-bedrock-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-bedrock-runtime")>();
  return {
    ...actual,
    // Whole-module autospies mutate the Smithy prototype shared with control-plane clients.
    BedrockRuntimeClient: vi.fn(actual.BedrockRuntimeClient),
  };
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
  customEndpoint?: boolean;
  unsupportedPartitionModes?: boolean;
  expectedError?: string;
};
const euPrivate = "vpce-memory.bedrock-runtime.eu-west-1.vpce.amazonaws.com";
const govFips = "bedrock-runtime-fips.us-gov-west-1.amazonaws.com";
const regional = { customEndpoint: false };
const fipsOptions = { ...regional, fips: true };
const dual = { ...regional, dualstack: true };
const privateEndpoint = { remoteBaseUrl: privateUrl, providerBaseUrl: null };
const iso = { signingRegion: "us-iso-east-1", unsupportedPartitionModes: true };
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
  ...regional,
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
const sdkOptions = { ...regional, sdkEndpoint: `https://${sdkHost}` };
const rejectFips = {
  ...privateEndpoint,
  fips: true,
  expectedError: "Invalid Configuration: FIPS and custom endpoint are not supported",
};
const rejectDual = {
  ...privateEndpoint,
  dualstack: true,
  expectedError: "Invalid Configuration: Dualstack and custom endpoint are not supported",
};

describe("bedrock embedding endpoint routing", () => {
  it.each<[string, string, EndpointOptions]>([
    ["memory endpoint wins", euPrivate, memoryOptions],
    ["regional FIPS", "bedrock-runtime-fips.us-east-1.amazonaws.com", fipsOptions],
    ["regional dual-stack", "bedrock-runtime.us-east-1.api.aws", dual],
    ["dual-stack with FIPS", "bedrock-runtime-fips.us-west-2.api.aws", westFips],
    ["GovCloud FIPS", govFips, govOptions],
    ["ISO PrivateLink", `vpce-memory.${isoHost}`, isoPrivate],
    ["ISO rejects dual-stack", isoHost, isoDual],
    ["SDK PrivateLink", sdkHost, sdkOptions],
    ["PrivateLink rejects FIPS", privateHost, rejectFips],
    ["PrivateLink rejects dual-stack", privateHost, rejectDual],
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

    if (testCase.unsupportedPartitionModes) {
      const { BedrockRuntimeClient: ActualBedrockRuntimeClient } = await vi.importActual<
        typeof import("@aws-sdk/client-bedrock-runtime")
      >("@aws-sdk/client-bedrock-runtime");
      vi.mocked(bedrockRuntimeSdk.BedrockRuntimeClient).mockImplementation(
        class extends ActualBedrockRuntimeClient {
          constructor(...args: ConstructorParameters<typeof ActualBedrockRuntimeClient>) {
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
    vi.spyOn(NodeHttp2Handler, "create").mockImplementation(() => {
      const requestHandler = new NodeHttp2Handler();
      vi.spyOn(requestHandler, "handle").mockImplementation(async (request) => {
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
      return requestHandler;
    });

    const { provider, client } = await createBedrockEmbeddingProvider({
      config: providerBaseUrl
        ? {
            models: {
              providers: {
                "amazon-bedrock": { baseUrl: providerBaseUrl, models: [] },
              },
            },
          }
        : {},
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

    await expect(provider.embed("private memory", { inputType: "query" })).resolves.toEqual([
      0.6, 0.8,
    ]);
    expect(observedRequests).toEqual([
      {
        hostname,
        authorization: expect.stringMatching(
          /^AWS4-HMAC-SHA256 Credential=BEDROCK_QA_FIXTURE_ACCESS\//,
        ),
      },
    ]);
    expect(observedRequests[0]?.authorization).toContain(`/${signingRegion}/bedrock/aws4_request`);
    expect(client.region).toBe(signingRegion);
    if (testCase.customEndpoint ?? (remoteBaseUrl || providerBaseUrl)) {
      expect(client).toHaveProperty("endpoint", remoteBaseUrl ?? providerBaseUrl);
    } else {
      expect(client).not.toHaveProperty("endpoint");
    }
  });
});

describe("hasAwsCredentials", () => {
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
});

describe("bedrock embedding response parsing", () => {
  const titan = "amazon.titan-embed-text-v2:0";
  const cohere = "cohere.embed-english-v3";
  const badUtf8 = Buffer.concat([
    Buffer.from('{"ignored":"bad'),
    Buffer.from([0xff]),
    Buffer.from('","embedding":[3,4]}'),
  ]);
  it.each([
    ["non-object JSON", titan, "[]"],
    ["invalid single vector element", titan, '{"embedding":[1,"bad"]}'],
    ["missing batch vectors", cohere, "{}"],
    ["invalid batch vector shape", cohere, '{"embeddings":[[1],{"bad":true}]}'],
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
});

describe("bedrock embedding inference profiles", () => {
  it("uses the Cohere v4 contract for the global profile prefix", async () => {
    const model = "global.cohere.embed-v4:0";
    const send = vi
      .spyOn(bedrockRuntimeSdk.BedrockRuntimeClient.prototype, "send")
      .mockResolvedValue({
        body: new TextEncoder().encode('{"embeddings":{"float":[[3,4]]}}'),
      } as never);
    const { provider, client } = await createBedrockEmbeddingProvider({ config: {}, model });

    await expect(provider.embed("private memory", { inputType: "query" })).resolves.toEqual([
      0.6, 0.8,
    ]);

    const command = send.mock.calls.at(-1)?.[0] as {
      input?: { body?: string | Uint8Array; modelId?: string };
    };
    const body =
      typeof command.input?.body === "string"
        ? command.input.body
        : new TextDecoder().decode(command.input?.body);
    expect(JSON.parse(body)).toEqual({
      texts: ["private memory"],
      input_type: "search_query",
      truncate: "END",
      embedding_types: ["float"],
      output_dimension: 1536,
    });
    expect(command.input?.modelId).toBe(model);
    expect(client).toMatchObject({ model, dimensions: 1536 });
    expect(provider.maxInputTokens).toBe(128_000);
  });
});
