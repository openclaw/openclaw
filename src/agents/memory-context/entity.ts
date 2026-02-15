/**
 * Entity Extraction
 *
 * Extracts named entities from text using regex/rule-based matching.
 * Supports Chinese and English. No external NLP dependencies.
 */

export type EntityType = "person" | "stock" | "url" | "date" | "amount" | "project" | "email";

export interface ExtractedEntity {
  type: EntityType;
  value: string;
  /** Character offset in source text */
  offset: number;
}

// ── Patterns ──────────────────────────────────────────────

/** A-share stock codes: 6-digit numbers (SH/SZ prefix optional) */
const STOCK_CN = /(?:SH|SZ|sh|sz)?[0-9]{6}(?=\b|[^\d])/g;

/** US stock tickers: 1-5 uppercase letters preceded by $ or standalone */
const STOCK_US = /\$[A-Z]{1,5}\b/g;

/** URLs */
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

/** Email addresses */
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/** Chinese amounts: ¥ or 元 */
const AMOUNT_CN = /¥[\d,]+(?:\.\d+)?(?:万|亿)?|[\d,]+(?:\.\d+)?(?:万|亿)?[元块]/g;

/** English amounts: $ followed by numbers */
const AMOUNT_EN = /\$[\d,]+(?:\.\d+)?(?:\s?[KkMmBb])?/g;

/** Date patterns: YYYY-MM-DD, YYYY/MM/DD, or Chinese dates */
const DATE_ISO = /\d{4}[-/]\d{1,2}[-/]\d{1,2}/g;
const DATE_CN = /\d{1,4}年\d{1,2}月\d{1,2}[日号]/g;
const DATE_REL = /(?:今天|昨天|明天|前天|后天|上周|下周|上个月|下个月)/g;

/** Chinese person names: 2-4 characters after common prefixes */
const PERSON_CN_PREFIX =
  /(?:@|找|问|跟|给|叫|是|让|请|联系|通知|告诉|转告|抄送|cc)\s*([一-龥]{2,4})/g;

/** Project names: repo-style (org/name) or CamelCase */
const PROJECT_REPO = /[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+/g;
const PROJECT_CAMEL = /\b[A-Z][a-z]+(?:[A-Z][a-z]+){1,4}\b/g;

// ── Extraction ────────────────────────────────────────────

function matchAll(text: string, re: RegExp, type: EntityType): ExtractedEntity[] {
  const results: ExtractedEntity[] = [];
  // Clone regex to avoid shared state issues
  const cloned = new RegExp(re.source, re.flags);
  let m: RegExpExecArray | null;
  while ((m = cloned.exec(text)) !== null) {
    results.push({ type, value: m[0], offset: m.index });
  }
  return results;
}

function matchGroup(text: string, re: RegExp, type: EntityType, group = 1): ExtractedEntity[] {
  const results: ExtractedEntity[] = [];
  const cloned = new RegExp(re.source, re.flags);
  let m: RegExpExecArray | null;
  while ((m = cloned.exec(text)) !== null) {
    const val = m[group] ?? m[0];
    results.push({ type, value: val.trim(), offset: m.index });
  }
  return results;
}

/**
 * Extract entities from text.
 */
export function extractEntities(text: string): ExtractedEntity[] {
  if (!text || typeof text !== "string") {
    return [];
  }

  const entities: ExtractedEntity[] = [];

  // URLs first (so we don't match parts of URLs as other entities)
  entities.push(...matchAll(text, URL_RE, "url"));
  entities.push(...matchAll(text, EMAIL_RE, "email"));

  // Strip URLs before other extraction to avoid false positives
  const noUrls = text.replace(URL_RE, " ").replace(EMAIL_RE, " ");

  entities.push(...matchAll(noUrls, STOCK_CN, "stock"));
  entities.push(...matchAll(noUrls, STOCK_US, "stock"));
  entities.push(...matchAll(noUrls, AMOUNT_CN, "amount"));
  entities.push(...matchAll(noUrls, AMOUNT_EN, "amount"));
  entities.push(...matchAll(noUrls, DATE_ISO, "date"));
  entities.push(...matchAll(noUrls, DATE_CN, "date"));
  entities.push(...matchAll(noUrls, DATE_REL, "date"));
  entities.push(...matchGroup(noUrls, PERSON_CN_PREFIX, "person"));
  entities.push(...matchAll(noUrls, PROJECT_REPO, "project"));
  entities.push(...matchAll(noUrls, PROJECT_CAMEL, "project"));

  // Deduplicate by type+value
  const seen = new Set<string>();
  return entities.filter((e) => {
    const key = `${e.type}:${e.value}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * Get unique entity values of a specific type.
 */
export function getEntitiesByType(entities: ExtractedEntity[], type: EntityType): string[] {
  return [...new Set(entities.filter((e) => e.type === type).map((e) => e.value))];
}
