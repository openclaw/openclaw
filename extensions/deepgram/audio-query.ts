import type { AudioTranscriptionRequest } from "openclaw/plugin-sdk/media-understanding";

export function setDeepgramQueryParam(
  searchParams: URLSearchParams,
  key: string,
  value: NonNullable<AudioTranscriptionRequest["query"]>[string],
): void {
  if (Array.isArray(value)) {
    searchParams.delete(key);
    for (const item of value) {
      searchParams.append(key, item);
    }
  } else {
    searchParams.set(key, String(value));
  }
}
