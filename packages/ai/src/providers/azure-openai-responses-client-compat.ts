export function isTraditionalAzureOpenAIHost(hostname: string): boolean {
  return (
    hostname.endsWith(".openai.azure.com") || hostname.endsWith(".cognitiveservices.azure.com")
  );
}

export function isOpenAICompatibleAzureResponsesBaseUrl(baseUrl: string): boolean {
  const url = URL.parse(baseUrl);
  if (!url || isTraditionalAzureOpenAIHost(url.hostname)) {
    return false;
  }

  const hostname = url.hostname.toLowerCase();
  const isFoundryHost =
    hostname.endsWith(".services.ai.azure.com") ||
    hostname.endsWith(".api.cognitive.microsoft.com");
  if (!isFoundryHost) {
    return false;
  }

  const normalizedPath = url.pathname.replace(/\/+$/, "");
  return normalizedPath === "/openai/v1" || normalizedPath.endsWith("/openai/v1");
}
