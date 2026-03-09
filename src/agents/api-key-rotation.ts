import { formatErrorMessage } from "../infra/errors.js";
import { collectProviderApiKeys, isApiKeyRateLimitError } from "./live-auth-keys.js";

type ApiKeyRetryParams = {
  apiKey: string;
  error: unknown;
  attempt: number;
};

type ExecuteWithApiKeyRotationOptions<T> = {
  provider: string;
  apiKeys: string[];
  execute: (apiKey: string) => Promise<T>;
  shouldRetry?: (params: ApiKeyRetryParams & { message: string }) => boolean;
  onRetry?: (params: ApiKeyRetryParams & { message: string }) => void;
};

function dedupeApiKeys(raw: string[]): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const value of raw) {
    const apiKey = value.trim();
    if (!apiKey || seen.has(apiKey)) {
      continue;
    }
    seen.add(apiKey);
    keys.push(apiKey);
  }
  return keys;
}

export function collectProviderApiKeysForExecution(params: {
  provider: string;
  primaryApiKey?: string;
}): string[] {
  const { primaryApiKey, provider } = params;
  return dedupeApiKeys([primaryApiKey?.trim() ?? "", ...collectProviderApiKeys(provider)]);
}

export async function executeWithApiKeyRotation<T>(
  params: ExecuteWithApiKeyRotationOptions<T>,
): Promise<T> {
  const keys = dedupeApiKeys(params.apiKeys);
  if (keys.length === 0) {
    throw new Error(`No API keys configured for provider "${params.provider}".`);
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < keys.length; attempt += 1) {
    const apiKey = keys[attempt];
    try {
      return await params.execute(apiKey);
    } catch (error) {
      lastError = error;
      const message = formatErrorMessage(error);
      const retryable = params.shouldRetry
        ? params.shouldRetry({ apiKey, error, attempt, message })
        : isApiKeyRateLimitError(message);

      if (!retryable || attempt + 1 >= keys.length) {
        break;
      }

      params.onRetry?.({ apiKey, error, attempt, message });
    }
  }

  if (lastError === undefined) {
    throw new Error(`Failed to run API request for ${params.provider}.`);
  }
  throw lastError;
}
