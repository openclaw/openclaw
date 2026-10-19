/** Detect Azure OpenAI-compatible embedding hosts. */
function isAzureOpenAICompatibleHost(hostname: string): boolean {
  return (
    hostname.endsWith(".openai.azure.com") ||
    hostname.endsWith(".services.ai.azure.com") ||
    hostname.endsWith(".cognitiveservices.azure.com")
  );
}

// Normalize only the outgoing target; configured headers remain part of the cache identity.
export function resolveAzureApiVersionRequestTarget(params: {
  url: string;
  headers: Record<string, string>;
}): { url: string; headers: Record<string, string> } {
  const { url, headers } = params;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return params;
  }
  if (!isAzureOpenAICompatibleHost(parsed.hostname)) {
    return params;
  }
  const headerKey = Object.keys(headers).find((key) => key.toLowerCase() === "api-version");
  if (!headerKey) {
    return params;
  }
  const apiVersion = headers[headerKey]?.trim();
  const nextHeaders = { ...headers };
  delete nextHeaders[headerKey];
  if (!apiVersion) {
    return { url, headers: nextHeaders };
  }
  const existing = parsed.searchParams.get("api-version");
  if (existing === null || existing.trim() === "") {
    parsed.searchParams.set("api-version", apiVersion);
  }
  return { url: parsed.toString(), headers: nextHeaders };
}
