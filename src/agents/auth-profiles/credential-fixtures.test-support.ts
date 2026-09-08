export function createApiKeyCredential(
  provider: string,
  key: string,
): { type: "api_key"; provider: string; key: string } {
  return { type: "api_key", provider, key };
}
