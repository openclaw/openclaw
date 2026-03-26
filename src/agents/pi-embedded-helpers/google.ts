export function isGoogleModelApi(modelApi?: string | null): boolean {
  if (!modelApi) {
    return false;
  }
  const normalized = modelApi.toLowerCase();
  return normalized.includes("google") || normalized.includes("gemini");
}
