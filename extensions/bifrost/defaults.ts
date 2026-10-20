export const BIFROST_BASE_URL = "http://localhost:8080/openai/v1";

export function normalizeBifrostBaseUrl(value: string): string {
  const baseUrl = value.trim().replace(/\/+$/, "");
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The Bifrost gateway URL must start with http:// or https://");
  }
  return baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
}
