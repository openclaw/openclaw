/**
 * Lightweight event logger for Command Center user actions.
 *
 * Events are stored in a ring buffer (max 200 entries) in memory.
 * Each entry includes a timestamp, action category, and detail string.
 * The log is accessible via console for debugging and can be extended
 * to push to the backend when needed.
 */

export interface LogEntry {
  ts: string;
  action: string;
  detail: string;
}

const MAX_ENTRIES = 200;
const entries: LogEntry[] = [];

export function logEvent(action: string, detail: string): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    action,
    detail,
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries.shift();
  }
}

export function getLog(): readonly LogEntry[] {
  return entries;
}

/**
 * Expose the event log on window for console debugging:
 *   window.__ccLog()    → returns all log entries
 *   window.__ccLog(10)  → returns last 10 entries
 */
export function exposeOnWindow(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__ccLog = (n?: number): LogEntry[] => {
    if (n && n > 0) {
      return entries.slice(-n);
    }
    return [...entries];
  };
}
