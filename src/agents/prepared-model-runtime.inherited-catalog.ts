import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isLikelySensitiveModelProviderHeaderName } from "../secrets/model-provider-header-policy.js";
import { parseModelCatalogJson } from "./model-catalog-json.js";

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
