import type { OpenClawClient } from "@/lib/openclaw-client";

interface GatewayModel {
  id?: string;
  provider?: string;
}

const PREFERRED_PROVIDERS = [
  "openai-codex",
  "openai",
  "google-antigravity",
  "google",
  "groq",
  "mistral",
  "xai",
  "openrouter",
];

function errorText(error: unknown): string {
  if (error instanceof Error) {return error.message.toLowerCase();}
  return String(error ?? "").toLowerCase();
}

export function isProviderAuthError(error: unknown): boolean {
  const text = errorText(error);
  return (
    text.includes("invalid x-api-key") ||
    text.includes("authentication_error") ||
    text.includes("credit balance is too low") ||
    text.includes("plans & billing") ||
    text.includes("api key") ||
    text.includes("anthropic")
  );
}

export function isRecoverableModelError(error: unknown): boolean {
  const text = errorText(error);
  return (
    isProviderAuthError(error) ||
    text.includes("model not allowed") ||
    text.includes("provider is not configured") ||
    text.includes("no such model") ||
    text.includes("model unavailable")
  );
}

function detectLikelyProvider(error: unknown): string | null {
  const text = errorText(error);
  if (text.includes("anthropic") || text.includes("claude")) {return "anthropic";}
  if (text.includes("openai")) {return "openai";}
  if (text.includes("google") || text.includes("gemini")) {return "google";}
  return null;
}

function toModelRef(model: GatewayModel): string | null {
  const modelId = model.id?.trim();
  if (!modelId) {return null;}
  if (modelId.includes("/")) {return modelId;}
  const provider = model.provider?.trim();
  return provider ? `${provider}/${modelId}` : modelId;
}

function providerRank(provider: string | undefined): number {
  if (!provider) {return PREFERRED_PROVIDERS.length + 1;}
  const idx = PREFERRED_PROVIDERS.indexOf(provider);
  return idx === -1 ? PREFERRED_PROVIDERS.length : idx;
}

function extractUsageProviders(usagePayload: unknown): Set<string> {
  const active = new Set<string>();
  if (!usagePayload || typeof usagePayload !== "object") {return active;}
  const providers = (usagePayload as { providers?: unknown[] }).providers;
  if (!Array.isArray(providers)) {return active;}

  for (const providerEntry of providers) {
    if (!providerEntry || typeof providerEntry !== "object") {continue;}
    const provider = (providerEntry as { provider?: unknown }).provider;
    if (typeof provider === "string" && provider.trim()) {
      active.add(provider.trim());
    }
  }
  return active;
}

export async function retrySendMessageWithFallback(params: {
  client: OpenClawClient;
  sessionKey: string;
  message: string;
  originalError: unknown;
  avoidProvider?: string | null;
}): Promise<{ modelRef: string } | null> {
  const { client, sessionKey, message, originalError, avoidProvider } = params;

  if (!isRecoverableModelError(originalError)) {return null;}

  const blockedProviders = new Set<string>();
  if (avoidProvider) {blockedProviders.add(avoidProvider);}
  const detected = detectLikelyProvider(originalError);
  if (detected) {blockedProviders.add(detected);}
  // Block the failing provider's family to avoid retrying the same auth issue.
  if (detected === "anthropic") {blockedProviders.add("anthropic");}

  const usagePayload = await client
    .getUsage()
    .catch(() => null);
  const usageProviders = extractUsageProviders(usagePayload);

  const modelResponse = (await client.listModels()) as {
    models?: GatewayModel[];
  };
  const allModels = (modelResponse.models || [])
    .filter((model) => !!model.id)
    .toSorted((a, b) => {
      const aProvider = a.provider || "";
      const bProvider = b.provider || "";
      const aActive = usageProviders.size === 0 || usageProviders.has(aProvider);
      const bActive = usageProviders.size === 0 || usageProviders.has(bProvider);
      if (aActive !== bActive) {return aActive ? -1 : 1;}
      return providerRank(a.provider) - providerRank(b.provider);
    });

  const candidateRefs: string[] = [];
  for (const model of allModels) {
    const provider = model.provider || "";
    if (blockedProviders.has(provider)) {continue;}
    if (usageProviders.size > 0 && provider && !usageProviders.has(provider)) {continue;}
    const modelRef = toModelRef(model);
    if (!modelRef || candidateRefs.includes(modelRef)) {continue;}
    candidateRefs.push(modelRef);
  }

  for (const modelRef of candidateRefs.slice(0, 12)) {
    try {
      await client.patchSession(sessionKey, { model: modelRef });
      await client.sendMessage(sessionKey, message);
      return { modelRef };
    } catch {
      // Keep trying alternative models.
    }
  }

  // Last resort: reset to auto/default model and retry once.
  try {
    await client.patchSession(sessionKey, { model: null });
    await client.sendMessage(sessionKey, message);
    return { modelRef: "auto" };
  } catch {
    return null;
  }
}
