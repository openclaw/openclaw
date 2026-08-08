import { redactToolPayloadText } from "openclaw/plugin-sdk/logging-core";

const AUTHORIZATION_SECRET_HEADERS = new Set(["authorization", "proxy-authorization"]);

export function collectOllamaRequestHeaderSecretValues(
  headers: Readonly<Record<string, string>>,
): string[] {
  // Arbitrary configured headers can carry credentials. Authorization intermediaries
  // can also reflect the credential without its scheme, so redact both scoped forms.
  return Object.entries(headers).flatMap(([headerName, headerValue]) => {
    const normalizedHeaderName = headerName.toLowerCase();
    if (normalizedHeaderName === "content-type" && headerValue === "application/json") {
      return [];
    }
    if (!AUTHORIZATION_SECRET_HEADERS.has(normalizedHeaderName)) {
      return [headerValue];
    }
    const credentialComponent = /^\s*\S+\s+(.+?)\s*$/u.exec(headerValue)?.[1];
    return credentialComponent ? [headerValue, credentialComponent] : [headerValue];
  });
}

export function redactOllamaResponseErrorText(
  text: string,
  headers: Readonly<Record<string, string>>,
  options?: { sourceTruncated?: boolean },
): string {
  return redactToolPayloadText(text, {
    exactSecretValues: collectOllamaRequestHeaderSecretValues(headers),
    sourceTruncated: options?.sourceTruncated,
  });
}
