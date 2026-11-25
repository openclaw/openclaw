import { Readable } from "node:stream";
import {
  BedrockRuntimeClient,
  type BedrockRuntimeClientConfig,
} from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { HttpRequest } from "@smithy/types";
import { createHttpProxyAgentsForTarget, type Model } from "openclaw/plugin-sdk/llm";
import type { ConverseProxyTransportFactory } from "openclaw/plugin-sdk/provider-stream-family";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveBedrockRuntimeAuth } from "./aws-credential-refresh.js";
import type { BedrockOptions } from "./bedrock-options.js";

export async function createBedrockStreamClient(
  model: Model<"bedrock-converse-stream">,
  options: BedrockOptions,
  transport?: ConverseProxyTransportFactory,
): Promise<BedrockRuntimeClient> {
  let config: BedrockRuntimeClientConfig;
  if (transport) {
    const proxy = await transport(model, options);
    options.signal?.throwIfAborted();
    if (!proxy.apiKey.trim()) {
      throw new Error("Converse proxy requires its selected credential");
    }
    // This is an explicit proxy mode, independent of every AWS environment/profile setting.
    // The SDK still owns serialization and decoding; the proxy owns destination and auth.
    config = {
      endpoint: proxy.endpoint,
      region: "us-east-1",
      token: { token: proxy.apiKey },
      authSchemePreference: ["httpBearerAuth"],
      credentialDefaultProvider: () => async () => {
        throw new Error("AWS credentials are unavailable to a Converse proxy transport");
      },
      maxAttempts: 1,
      requestHandler: {
        async handle(request: HttpRequest) {
          const result = await proxy.send(
            {
              method: request.method,
              path: request.path,
              query: request.query ?? {},
              headers: request.headers,
              body: request.body,
            },
            options.signal,
          );
          return { response: { ...result, body: Readable.from([result.body]) } };
        },
      },
    };
  } else {
    config = {
      profile: options.profile,
      ...resolveBedrockRuntimeAuth(options.bearerToken),
    };
    const configuredRegion = getConfiguredBedrockRegion(options);
    const requestRegion = options.region || getBedrockModelArnRegion(model.id) || configuredRegion;
    const hasConfiguredProfile = hasConfiguredBedrockProfile(options);
    const endpointRegion = getStandardBedrockEndpointRegion(model.baseUrl);
    const useExplicitEndpoint = !endpointRegion || (!requestRegion && !hasConfiguredProfile);

    // Only pin standard AWS Bedrock runtime endpoints when no region/profile is configured.
    // This preserves custom endpoints (VPC/proxy) from #3402 without forcing built-in
    // catalog defaults such as us-east-1 to override AWS_REGION/AWS_PROFILE.
    if (useExplicitEndpoint) {
      config.endpoint = model.baseUrl;
    }

    // Region resolution: explicit option > model ARN > env vars > SDK default chain.
    // When AWS_PROFILE is set, leave region undefined so the SDK can resolve it.
    if (requestRegion) {
      config.region = requestRegion;
    } else if (endpointRegion && useExplicitEndpoint) {
      config.region = endpointRegion;
    } else if (!hasConfiguredProfile) {
      config.region = "us-east-1";
    }

    const proxyAgents = createHttpProxyAgentsForTarget(model.baseUrl);
    if (proxyAgents) {
      // Bedrock runtime uses NodeHttp2Handler by default since v3.798.0, which is based
      // on `http2` module and has no support for http agent.
      // Use NodeHttpHandler to support HTTP(S) proxy agents.
      config.requestHandler = new NodeHttpHandler(proxyAgents);
    } else if (process.env.AWS_BEDROCK_FORCE_HTTP1 === "1") {
      // Some custom endpoints require HTTP/1.1 instead of HTTP/2
      config.requestHandler = new NodeHttpHandler();
    }
  }
  return new BedrockRuntimeClient(config);
}

function getBedrockModelArnRegion(modelId: string): string | undefined {
  return /^arn:aws(?:-[a-z0-9-]+)?:bedrock:([a-z0-9-]+):/.exec(modelId)?.[1];
}

export function getConfiguredBedrockRegion(options: BedrockOptions): string | undefined {
  if (typeof process === "undefined") {
    return options.region;
  }

  return (
    options.region ||
    normalizeOptionalString(process.env.AWS_REGION) ||
    normalizeOptionalString(process.env.AWS_DEFAULT_REGION)
  );
}

function hasConfiguredBedrockProfile(options: BedrockOptions): boolean {
  if (options.profile) {
    return true;
  }
  if (typeof process === "undefined") {
    return false;
  }

  return Boolean(process.env.AWS_PROFILE);
}

function getStandardBedrockEndpointRegion(baseUrl: string | undefined): string | undefined {
  const hostname = baseUrl ? URL.parse(baseUrl)?.hostname : undefined;
  return hostname
    ?.toLowerCase()
    .match(/^bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/)?.[1];
}
