export function isOfficialOpenAIResponsesBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) {
    return false;
  }
  const url = URL.parse(baseUrl);
  return (
    url !== null &&
    url.origin === "https://api.openai.com" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    url.pathname.replace(/\/+$/, "") === "/v1"
  );
}
export function supportsNativeOpenAIResponsesEndpoint(params: {
  provider: string;
  api: string;
  baseUrl?: string;
}): boolean {
  return (
    params.provider.trim().toLowerCase() === "openai" &&
    params.api === "openai-responses" &&
    isOfficialOpenAIResponsesBaseUrl(params.baseUrl)
  );
}
