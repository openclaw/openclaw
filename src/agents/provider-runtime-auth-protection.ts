// Protects provider auth exchange output before it enters retained runtime state.
import { isSecretValueRegisteredForRedaction } from "../logging/secret-redaction-registry.js";
import { isNonCredentialModelProviderHeaderName } from "../secrets/model-provider-header-policy.js";
import { looksLikeSecretSentinel, mintSecretSentinel } from "../secrets/sentinel.js";
import { isNonSecretApiKeyMarker } from "./model-auth-markers.js";
import type { ModelProviderRequestTransportOverrides } from "./provider-request-config.js";

type PreparedProviderRuntimeAuth = {
  apiKey: string;
  baseUrl?: string;
  request?: ModelProviderRequestTransportOverrides;
  expiresAt?: number;
};

function protectRuntimeAuthValue(params: {
  value: string;
  provider: string;
  label: string;
}): string {
  if (!params.value) {
    return params.value;
  }
  return looksLikeSecretSentinel(params.value)
    ? params.value
    : mintSecretSentinel(params.value, {
        label: `model-auth:${params.provider}:${params.label}`,
      });
}

/** Re-sentinels credentials returned by a provider auth exchange. */
export function protectPreparedProviderRuntimeAuth(params: {
  provider: string;
  preparedAuth: PreparedProviderRuntimeAuth | null | undefined;
}): PreparedProviderRuntimeAuth | undefined {
  const { preparedAuth } = params;
  if (!preparedAuth) {
    return undefined;
  }
  // Credential provenance must not depend on the logging registry's length or capacity limits.
  const credentialValues = new Set<string>();
  const protect = (value: string, label: string): string => {
    if (!value || isNonSecretApiKeyMarker(value)) {
      return value;
    }
    credentialValues.add(value);
    return protectRuntimeAuthValue({ value, provider: params.provider, label });
  };
  const request = preparedAuth.request;
  // Register explicit credentials first so metadata cannot declassify a duplicate value.
  const apiKey = protect(preparedAuth.apiKey, "runtime-api-key");
  const auth = request?.auth;
  const protectedAuth =
    auth?.mode === "authorization-bearer"
      ? { ...auth, token: protect(auth.token, "runtime-bearer") }
      : auth?.mode === "header"
        ? {
            ...auth,
            value: protect(auth.value, `runtime-auth-header:${auth.headerName.toLowerCase()}`),
          }
        : auth;
  const authHeaderName = auth?.mode === "header" ? auth.headerName.trim().toLowerCase() : undefined;
  // Protect custom headers first so a later credential cannot leave an earlier
  // metadata alias in plaintext merely because of object insertion order.
  const protectedHeaders = request?.headers
    ? Object.entries(request.headers).map(
        ([name, value]) =>
          [
            name,
            !isNonCredentialModelProviderHeaderName(name) ||
            name.trim().toLowerCase() === authHeaderName
              ? protect(value, `runtime-header:${name.toLowerCase()}`)
              : value,
          ] as const,
      )
    : undefined;
  const headers = protectedHeaders
    ? Object.fromEntries(
        protectedHeaders.map(([name, value]) => [
          name,
          credentialValues.has(value) || isSecretValueRegisteredForRedaction(value)
            ? protect(value, `runtime-header:${name.toLowerCase()}`)
            : value,
        ]),
      )
    : undefined;
  return {
    ...preparedAuth,
    apiKey,
    ...(request
      ? {
          request: {
            ...request,
            ...(headers ? { headers } : {}),
            ...(protectedAuth ? { auth: protectedAuth } : {}),
          },
        }
      : {}),
  };
}
