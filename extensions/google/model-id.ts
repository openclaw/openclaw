export {
  normalizeAntigravityPreviewModelId as normalizeAntigravityModelId,
  normalizeGooglePreviewModelId as normalizeGoogleModelId,
} from "openclaw/plugin-sdk/model-ref-parse";

const GOOGLE_PROVIDER_PREFIX = "google/";

export function stripGoogleProviderPrefix(id: string): string {
  return id.startsWith(GOOGLE_PROVIDER_PREFIX) ? id.slice(GOOGLE_PROVIDER_PREFIX.length) : id;
}
