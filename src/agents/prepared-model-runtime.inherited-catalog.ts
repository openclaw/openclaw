import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isLikelySensitiveModelProviderHeaderName } from "../secrets/model-provider-header-policy.js";
import { parseModelCatalogJson } from "./model-catalog-json.js";
import { captureModelsJsonSource } from "./models-config-state.js";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";

/** Captures local inventory first, preserving the catalog owner's serialized reads. */
export async function capturePreparedModelsJsonSource(
  input: Pick<PreparedModelRuntimeInput, "agentDir" | "fallbackAgentDir">,
): Promise<Readonly<{ contents: string | null; sanitizedFallback: boolean }>> {
  const local = await captureModelsJsonSource(input.agentDir);
  if (local.contents !== null || !input.fallbackAgentDir) {
    return { contents: local.contents, sanitizedFallback: false };
  }
  const inherited = await captureModelsJsonSource(input.fallbackAgentDir);
  return inherited.contents === null
    ? { contents: null, sanitizedFallback: false }
    : {
        contents: sanitizeInheritedModelsJsonContents(inherited.contents),
        sanitizedFallback: true,
      };
}

type SanitizedValue = { changed: boolean; value: unknown };

function sanitizeInheritedHeaders(value: unknown): SanitizedValue {
  if (!isRecord(value)) {
    return { changed: false, value };
  }
  const entries = Object.entries(value).filter(
    ([name]) => !isLikelySensitiveModelProviderHeaderName(name),
  );
  return entries.length === Object.keys(value).length
    ? { changed: false, value }
    : { changed: true, value: Object.fromEntries(entries) };
}

function sanitizeInheritedModel(value: unknown): SanitizedValue {
  if (!isRecord(value)) {
    return { changed: false, value };
  }
  const headers = sanitizeInheritedHeaders(value.headers);
  return headers.changed
    ? { changed: true, value: { ...value, headers: headers.value } }
    : { changed: false, value };
}

function sanitizeInheritedProvider(value: unknown): SanitizedValue {
  if (!isRecord(value)) {
    return { changed: false, value };
  }
  const headers = sanitizeInheritedHeaders(value.headers);
  const models = Array.isArray(value.models)
    ? value.models.map((model) => sanitizeInheritedModel(model))
    : undefined;
  const modelsChanged = models?.some((model) => model.changed) === true;
  const apiKeyChanged = Object.hasOwn(value, "apiKey");
  if (!headers.changed && !modelsChanged && !apiKeyChanged) {
    return { changed: false, value };
  }
  const sanitized = { ...value };
  delete sanitized.apiKey;
  if (headers.changed) {
    sanitized.headers = headers.value;
  }
  if (modelsChanged && models) {
    sanitized.models = models.map((model) => model.value);
  }
  return { changed: true, value: sanitized };
}

/** Keeps inherited model inventory while removing system-agent credential authority. */
export function sanitizeInheritedModelsJsonContents(contents: string): string {
  let parsed: unknown;
  try {
    parsed = parseModelCatalogJson(contents);
  } catch {
    return contents;
  }
  if (!isRecord(parsed) || !isRecord(parsed.providers)) {
    return contents;
  }
  const providers = Object.entries(parsed.providers).map(
    ([providerId, provider]) => [providerId, sanitizeInheritedProvider(provider)] as const,
  );
  if (!providers.some(([, provider]) => provider.changed)) {
    return contents;
  }
  return JSON.stringify({
    ...parsed,
    providers: Object.fromEntries(
      providers.map(([providerId, provider]) => [providerId, provider.value]),
    ),
  });
}
