export const BIFROST_BASE_URL = "http://localhost:8080/openai/v1";

export function tryNormalizeBifrostBaseUrl(value: string): string | undefined {
  const baseUrl = value.trim().replace(/\/+$/, "");
  if (!URL.canParse(baseUrl)) {
    return undefined;
  }
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return undefined;
  }
  return baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
}

export function normalizeBifrostBaseUrl(value: string): string {
  const baseUrl = tryNormalizeBifrostBaseUrl(value);
  if (!baseUrl) {
    throw new Error("The Bifrost gateway URL must start with http:// or https://");
  }
  return baseUrl;
}
