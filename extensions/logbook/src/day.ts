/** Formats an epoch-ms timestamp as a local-time YYYY-MM-DD day key. */
export function dayKeyFor(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const dayOfMonth = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${dayOfMonth}`;
}
