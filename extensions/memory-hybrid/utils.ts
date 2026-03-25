/**
 * Utility functions for the memory-hybrid plugin
 */

/**
 * Parses a relative date string into a timestamp.
 * Supported: "yesterday", "last week", "last month", "2 days ago", "1 hour ago".
 * Fallback to Date.parse() for ISO strings.
 */
export function parseDate(dateStr: string | null | undefined): number {
  if (!dateStr) return NaN;

  const now = Date.now();
  const lower = dateStr.toLowerCase().trim();

  // 1. Common relative strings
  if (lower === "today" || lower === "now") return now;
  if (lower === "yesterday") return now - 24 * 60 * 60 * 1000;
  if (lower === "last week") return now - 7 * 24 * 60 * 60 * 1000;
  if (lower === "last month") return now - 30 * 24 * 60 * 60 * 1000;
  if (lower === "tomorrow") return now + 24 * 60 * 60 * 1000;

  // 2. Regex for "N units ago"
  const agoMatch = lower.match(/^(\d+)\s+(year|month|week|day|hour|minute|second)s?\s+ago$/);
  if (agoMatch) {
    const value = parseInt(agoMatch[1], 10);
    const unit = agoMatch[2];
    const multipliers: Record<string, number> = {
      second: 1000,
      minute: 60 * 1000,
      hour: 60 * 60 * 1000,
      day: 24 * 60 * 60 * 1000,
      week: 7 * 24 * 60 * 60 * 1000,
      month: 30 * 24 * 60 * 60 * 1000,
      year: 365 * 24 * 60 * 60 * 1000,
    };
    return now - value * (multipliers[unit] ?? 0);
  }

  // 3. Fallback to native parser (ISO strings, etc.)
  return Date.parse(dateStr);
}

/**
 * Retry a function with exponential backoff.
 */
export async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3, delay = 1000): Promise<T> {
  let lastError: any;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < maxRetries) {
        const wait = delay * Math.pow(2, i);
        // Add some jitter to avoid thundering herd
        const jitter = Math.random() * 200;
        await new Promise((resolve) => setTimeout(resolve, wait + jitter));
      }
    }
  }
  throw lastError;
}
