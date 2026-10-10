// Protects provider auth exchange output before it enters retained runtime state.
import type { ProviderPreparedRuntimeAuth } from "../plugins/provider-runtime.types.js";
import { looksLikeSecretSentinel, mintSecretSentinel } from "../secrets/sentinel.js";
import { isNonSecretApiKeyMarker } from "./model-auth-markers.js";

/** Re-sentinels credentials returned by a provider auth exchange. */
export function protectPreparedProviderRuntimeAuth(params: {
  provider: string;
  preparedAuth: ProviderPreparedRuntimeAuth | null | undefined;
}): ProviderPreparedRuntimeAuth | undefined {
  const { preparedAuth } = params;
  if (!preparedAuth) {
    return undefined;
  }
  const protect = (value: string, label: string): string =>
    !value || isNonSecretApiKeyMarker(value) || looksLikeSecretSentinel(value)
      ? value
      : mintSecretSentinel(value, { label: `model-auth:${params.provider}:${label}` });
  const request = preparedAuth.request;
  const headers = request?.headers
    ? Object.fromEntries(
        Object.entries(request.headers).map(([name, value]) => [
          name,
          protect(value, `runtime-header:${name.toLowerCase()}`),
        ]),
      )
    : undefined;
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
  return {
    ...preparedAuth,
    apiKey: protect(preparedAuth.apiKey, "runtime-api-key"),
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
