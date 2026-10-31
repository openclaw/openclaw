import type { BedrockRuntimeClientConfig } from "@aws-sdk/client-bedrock-runtime";
import type { DefaultProviderInit, defaultProvider } from "@aws-sdk/credential-provider-node";

/** Keep shared-file refresh on the chain that actually signs the Bedrock request. */
export function bedrockCredentialDefaultProvider(init: DefaultProviderInit) {
  // Load credentials lazily so discovery/registration and bearer-token requests do
  // not resolve AWS credentials. Each SDK client retains its own normal chain cache.
  let provider: ReturnType<typeof defaultProvider> | undefined;
  return async (...args: Parameters<ReturnType<typeof defaultProvider>>) => {
    const { defaultProvider } = await import("@aws-sdk/credential-provider-node");
    provider ??= defaultProvider({ ...init, ignoreCache: true });
    return provider(...args);
  };
}

/** Preserve explicit proxy and bearer authentication ahead of the default AWS chain. */
export function resolveBedrockRuntimeAuth(
  bearerToken?: string,
): Pick<
  BedrockRuntimeClientConfig,
  "credentialDefaultProvider" | "credentials" | "token" | "authSchemePreference"
> {
  const config: ReturnType<typeof resolveBedrockRuntimeAuth> = {
    credentialDefaultProvider: bedrockCredentialDefaultProvider,
  };
  if (process.env.AWS_BEDROCK_SKIP_AUTH === "1") {
    if (process.versions?.node || process.versions?.bun) {
      config.credentials = {
        accessKeyId: "dummy-access-key",
        secretAccessKey: "dummy-secret-key",
      };
    }
  } else {
    const token = bearerToken || process.env.AWS_BEARER_TOKEN_BEDROCK || undefined;
    if (token !== undefined) {
      config.token = { token };
      config.authSchemePreference = ["httpBearerAuth"];
    }
  }
  return config;
}
