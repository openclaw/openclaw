// Agent Eye — BugStore
// Zero booleans. All state uses typed string enums with explicit equality checks.

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const BUG_SEVERITY = {
  CRITICAL: "CRITICAL",
  ERROR: "ERROR",
  WARNING: "WARNING",
  INFO: "INFO",
} as const;
export type BugSeverity = (typeof BUG_SEVERITY)[keyof typeof BUG_SEVERITY];

const SEVERITY_ORDER: readonly BugSeverity[] = [
  BUG_SEVERITY.CRITICAL,
  BUG_SEVERITY.ERROR,
  BUG_SEVERITY.WARNING,
  BUG_SEVERITY.INFO,
] as const;

export const TRIGGER_KIND = {
  JS_ERROR: "JS_ERROR",
  UNHANDLED_REJECTION: "UNHANDLED_REJECTION",
  CONSOLE_ERROR: "CONSOLE_ERROR",
  NETWORK_ERROR: "NETWORK_ERROR",
} as const;
export type TriggerKind = (typeof TRIGGER_KIND)[keyof typeof TRIGGER_KIND];

const VALID_TRIGGERS = new Set<string>(Object.values(TRIGGER_KIND));

export const ACTION_KIND = {
  CLICK: "CLICK",
  INPUT: "INPUT",
  SCROLL: "SCROLL",
  NAVIGATE: "NAVIGATE",
} as const;
export type ActionKind = (typeof ACTION_KIND)[keyof typeof ACTION_KIND];

export const REPORT_VERDICT = {
  ACCEPTED: "ACCEPTED",
  RATE_LIMITED: "RATE_LIMITED",
  REJECTED: "REJECTED",
} as const;
export type ReportVerdict = (typeof REPORT_VERDICT)[keyof typeof REPORT_VERDICT];

export const EYE_MODE = {
  WATCHING: "WATCHING",
  DORMANT: "DORMANT",
  PAUSED: "PAUSED",
} as const;
export type EyeMode = (typeof EYE_MODE)[keyof typeof EYE_MODE];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UserAction = {
  kind: ActionKind;
  selector: string;
  text?: string;
  tag?: string;
  x?: number;
  y?: number;
  url?: string;
  timestamp: number;
};

export type BugReport = {
  id: string;
  url: string;
  timestamp: number;
  severity: BugSeverity;
  trigger: TriggerKind;
  message: string;
  stack?: string;
  filename?: string;
  line?: number;
  col?: number;
  status?: number;
  method?: string;
  actions: UserAction[];
  domSnippet?: string;
  viewport?: { width: number; height: number };
  tabId?: number;
  tabTitle?: string;
};

// ---------------------------------------------------------------------------
// ID generator (simple counter + random suffix, no external deps)
// ---------------------------------------------------------------------------

let idCounter = 0;

function generateId(): string {
  const now = Date.now().toString(36);
  const count = (idCounter++).toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `eye_${now}_${count}_${rand}`;
}

// ---------------------------------------------------------------------------
// Severity classification
// ---------------------------------------------------------------------------

export function classifySeverity(trigger: TriggerKind, status?: number): BugSeverity {
  if (trigger === TRIGGER_KIND.JS_ERROR) return BUG_SEVERITY.CRITICAL;
  if (trigger === TRIGGER_KIND.UNHANDLED_REJECTION) return BUG_SEVERITY.CRITICAL;
  if (trigger === TRIGGER_KIND.NETWORK_ERROR) {
    if (typeof status === "number" && status >= 500) return BUG_SEVERITY.CRITICAL;
    if (typeof status === "number" && status >= 400) return BUG_SEVERITY.ERROR;
    return BUG_SEVERITY.ERROR;
  }
  if (trigger === TRIGGER_KIND.CONSOLE_ERROR) return BUG_SEVERITY.WARNING;
  return BUG_SEVERITY.INFO;
}

// ---------------------------------------------------------------------------
// BugStore — circular buffer with TTL
// ---------------------------------------------------------------------------

const MAX_BUGS = 200;
const TTL_MS = 60 * 60 * 1000; // 1 hour

export class BugStore {
  private buffer: BugReport[] = [];

  /** Validate an incoming trigger string against known TRIGGER_KIND values. */
  isValidTrigger(trigger: string): trigger is TriggerKind {
    return VALID_TRIGGERS.has(trigger);
  }

  /** Add a bug report. Returns the generated ID. */
  add(report: Omit<BugReport, "id">): string {
    this.prune();
    const id = generateId();
    const bug: BugReport = { ...report, id };
    this.buffer.push(bug);
    if (this.buffer.length > MAX_BUGS) {
      this.buffer.splice(0, this.buffer.length - MAX_BUGS);
    }
    return id;
  }

  /** Get a single bug by ID, or undefined. */
  get(id: string): BugReport | undefined {
    this.prune();
    return this.buffer.find((b) => b.id === id);
  }

  /** List bugs, optionally filtered by severity. */
  list(severity?: BugSeverity): BugReport[] {
    this.prune();
    if (severity === undefined) return this.buffer.slice();
    return this.buffer.filter((b) => b.severity === severity);
  }

  /** Count bugs by severity. */
  counts(): Record<BugSeverity, number> {
    this.prune();
    const result: Record<string, number> = {
      [BUG_SEVERITY.CRITICAL]: 0,
      [BUG_SEVERITY.ERROR]: 0,
      [BUG_SEVERITY.WARNING]: 0,
      [BUG_SEVERITY.INFO]: 0,
    };
    for (const bug of this.buffer) {
      result[bug.severity] = (result[bug.severity] ?? 0) + 1;
    }
    return result as Record<BugSeverity, number>;
  }

  /** Total number of bugs currently stored. */
  size(): number {
    this.prune();
    return this.buffer.length;
  }

  /** Clear all bugs. Returns count removed. */
  clear(): number {
    const count = this.buffer.length;
    this.buffer = [];
    return count;
  }

  /** Remove expired bugs (older than TTL). */
  private prune(): void {
    const cutoff = Date.now() - TTL_MS;
    this.buffer = this.buffer.filter((b) => b.timestamp > cutoff);
  }

  /** Severity order for display (not used for comparison — always use === checks). */
  static severityOrder(): readonly BugSeverity[] {
    return SEVERITY_ORDER;
  }

  /** Max capacity. */
  static capacity(): number {
    return MAX_BUGS;
  }
}
