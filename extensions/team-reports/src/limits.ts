export const MAX_REPORT_BYTES = 2 * 1024 * 1024;
// GitHub sets the floor for this shared budget: 100 items at per_page=100 with 65,536-character
// bodies are 25 MiB of text even when every character needs four bytes. Discord pages are far
// smaller because message content caps at 2,000 characters, so one budget no legitimate page can
// reach is enough.
export const MAX_API_RESPONSE_BYTES = 32 * 1024 * 1024;
/** Same budget in operator-facing units so overflow warnings state the cutoff they enforce. */
export const MAX_API_RESPONSE_LABEL = `${MAX_API_RESPONSE_BYTES / (1024 * 1024)} MiB`;
/**
 * Exact byte count, so an overflow warning names the page a host advertised or the bytes read
 * before the cutoff rather than only "too large".
 */
export function formatApiResponseSize(bytes: number): string {
  return `${bytes.toLocaleString("en-US")} bytes`;
}
export const WORK_SESSIONS_PAGE_SIZE = 40;
