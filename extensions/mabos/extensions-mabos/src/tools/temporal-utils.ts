/**
 * Temporal Utilities — Three-Date Model for MABOS Memory
 *
 * Provides date extraction, temporal scoring, and effective-date logic
 * to support the three-date model: created_at, observed_at, referenced_dates.
 *
 * No external dependencies — pure regex/heuristic.
 */

// ── Constants ──

const MONTH_NAMES: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

const DAY_NAMES: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const DECAY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Date Extraction ──

/**
 * Extract referenced dates from text content.
 * Handles ISO dates, natural language dates, and relative dates.
 * Returns ISO date strings (YYYY-MM-DD).
 */
export function extractReferencedDates(content: string, referenceDate?: Date): string[] {
  const ref = referenceDate ?? new Date();
  const dates = new Set<string>();

  // ISO dates: 2026-02-27, 2026/02/27
  const isoPattern = /\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/g;
  let m: RegExpExecArray | null;
  while ((m = isoPattern.exec(content)) !== null) {
    const d = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
    if (!isNaN(d.getTime())) dates.add(formatDate(d));
  }

  // Natural language: "January 15", "Jan 15, 2026", "15 January 2026"
  const monthDayPattern = new RegExp(
    `\\b(${Object.keys(MONTH_NAMES).join("|")})\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?\\b`,
    "gi",
  );
  while ((m = monthDayPattern.exec(content)) !== null) {
    const month = MONTH_NAMES[m[1].toLowerCase()];
    const day = parseInt(m[2]);
    const year = m[3] ? parseInt(m[3]) : ref.getFullYear();
    if (month !== undefined && day >= 1 && day <= 31) {
      const d = new Date(year, month, day);
      if (!isNaN(d.getTime())) dates.add(formatDate(d));
    }
  }

  // "15 January 2026" / "15 Jan"
  const dayMonthPattern = new RegExp(
    `\\b(\\d{1,2})\\s+(${Object.keys(MONTH_NAMES).join("|")})(?:\\s+(\\d{4}))?\\b`,
    "gi",
  );
  while ((m = dayMonthPattern.exec(content)) !== null) {
    const day = parseInt(m[1]);
    const month = MONTH_NAMES[m[2].toLowerCase()];
    const year = m[3] ? parseInt(m[3]) : ref.getFullYear();
    if (month !== undefined && day >= 1 && day <= 31) {
      const d = new Date(year, month, day);
      if (!isNaN(d.getTime())) dates.add(formatDate(d));
    }
  }

  // Relative dates
  const lower = content.toLowerCase();

  if (/\byesterday\b/.test(lower)) {
    dates.add(formatDate(offsetDays(ref, -1)));
  }
  if (/\btoday\b/.test(lower)) {
    dates.add(formatDate(ref));
  }
  if (/\btomorrow\b/.test(lower)) {
    dates.add(formatDate(offsetDays(ref, 1)));
  }

  // "last Tuesday", "last Monday"
  const lastDayPattern =
    /\blast\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)\b/gi;
  while ((m = lastDayPattern.exec(lower)) !== null) {
    const targetDay = DAY_NAMES[m[1].toLowerCase()];
    if (targetDay !== undefined) {
      const currentDay = ref.getDay();
      let daysBack = currentDay - targetDay;
      if (daysBack <= 0) daysBack += 7;
      dates.add(formatDate(offsetDays(ref, -daysBack)));
    }
  }

  // "N days ago", "N weeks ago"
  const nAgoPattern = /\b(\d+)\s+(days?|weeks?|months?)\s+ago\b/gi;
  while ((m = nAgoPattern.exec(lower)) !== null) {
    const n = parseInt(m[1]);
    const unit = m[2].toLowerCase();
    if (unit.startsWith("day")) {
      dates.add(formatDate(offsetDays(ref, -n)));
    } else if (unit.startsWith("week")) {
      dates.add(formatDate(offsetDays(ref, -n * 7)));
    } else if (unit.startsWith("month")) {
      const d = new Date(ref);
      d.setMonth(d.getMonth() - n);
      dates.add(formatDate(d));
    }
  }

  // "last week" (start of last week)
  if (/\blast\s+week\b/.test(lower)) {
    const currentDay = ref.getDay();
    const daysBack = currentDay + 7; // Go to last week's Sunday
    dates.add(formatDate(offsetDays(ref, -daysBack)));
  }

  return Array.from(dates).sort();
}

// ── Effective Date ──

/**
 * Returns the effective date for temporal scoring.
 * Uses observed_at if available, falls back to created_at.
 */
export function effectiveDate(item: { observed_at?: string; created_at: string }): string {
  return item.observed_at ?? item.created_at;
}

// ── Temporal Relevance Scoring ──

/**
 * Score 0-1 based on how well an item's dates match a query's temporal intent.
 *
 * If the query contains dates, scores by proximity to query dates.
 * If no query dates, scores by recency with a 7-day decay window.
 */
export function temporalRelevanceScore(
  item: { observed_at?: string; created_at: string; referenced_dates?: string[] },
  query?: string,
  queryDate?: Date,
): number {
  const now = queryDate ?? new Date();

  // Extract query dates if query provided
  const queryDates = query ? extractReferencedDates(query, now) : [];

  if (queryDates.length > 0) {
    // Score by proximity to query dates
    const itemDates = [effectiveDate(item), ...(item.referenced_dates ?? [])]
      .map((d) => new Date(d).getTime())
      .filter((t) => !isNaN(t));

    if (itemDates.length === 0) return 0.1; // No dates to compare

    const queryTimes = queryDates.map((d) => new Date(d).getTime());
    let bestScore = 0;

    for (const itemTime of itemDates) {
      for (const queryTime of queryTimes) {
        const diffDays = Math.abs(itemTime - queryTime) / (24 * 60 * 60 * 1000);
        // Score: 1.0 for exact match, decays over 30 days
        const score = Math.max(0, 1 - diffDays / 30);
        bestScore = Math.max(bestScore, score);
      }
    }

    return bestScore;
  }

  // No query dates — score by recency with 7-day decay window
  const itemTime = new Date(effectiveDate(item)).getTime();
  if (isNaN(itemTime)) return 0.1;

  const ageMs = now.getTime() - itemTime;
  if (ageMs < 0) return 1.0; // Future date treated as maximally relevant
  return Math.max(0, 1 - ageMs / DECAY_WINDOW_MS);
}

// ── Unified Memory Score ──

/**
 * Compute a unified memory relevance score combining semantic, importance, and temporal signals.
 */
export function computeMemoryScore(params: {
  item: {
    observed_at?: string;
    created_at: string;
    referenced_dates?: string[];
    importance: number;
  };
  semanticScore?: number;
  query?: string;
  queryDate?: Date;
}): number {
  const { item, semanticScore, query, queryDate } = params;
  const temporal = temporalRelevanceScore(item, query, queryDate);

  if (semanticScore !== undefined && semanticScore > 0) {
    // With semantic: semantic * 0.5 + importance * 0.2 + temporal * 0.3
    return semanticScore * 0.5 + item.importance * 0.2 + temporal * 0.3;
  }

  // Without semantic: importance * 0.4 + temporal * 0.4 + freshness * 0.2
  const now = queryDate ?? new Date();
  const ageMs = now.getTime() - new Date(item.created_at).getTime();
  const freshness = Math.max(0, 1 - ageMs / DECAY_WINDOW_MS);

  return item.importance * 0.4 + temporal * 0.4 + freshness * 0.2;
}

// ── Relative Date Labels ──

/**
 * Human-readable relative date label: "3 days ago", "last week", etc.
 */
export function computeRelativeDateLabel(isoDate: string, fromDate?: Date): string {
  const from = fromDate ?? new Date();
  const target = new Date(isoDate);

  if (isNaN(target.getTime())) return "unknown date";

  const diffMs = from.getTime() - target.getTime();
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));

  if (diffDays < 0) return `in ${Math.abs(diffDays)} day${Math.abs(diffDays) !== 1 ? "s" : ""}`;
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 14) return "last week";
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
  if (diffDays < 60) return "last month";
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`;
  return `${Math.floor(diffDays / 365)} year${Math.floor(diffDays / 365) !== 1 ? "s" : ""} ago`;
}

// ── Helpers ──

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function offsetDays(d: Date, offset: number): Date {
  const result = new Date(d);
  result.setDate(result.getDate() + offset);
  return result;
}
