import type { CoinEvent, MemoHandler } from "./types";
import { LIMITS } from "./types";

export interface HandlerResult {
  matched: boolean;
  handlerName: string | null;
  formattedMessage: string | null;
}

const BUILT_IN_HANDLERS: MemoHandler[] = [
  {
    name: "any-coin",
    pattern: ".*",
    template: "💰 Received {amountXch} XCH to {addressShort}\n📝 Memo: {memo}\n📏 Height: {height}",
    enabled: true,
  },
];

/**
 * Validate a regex pattern for safety.
 * Rejects patterns that are too long or catastrophically backtracking.
 */
function validateRegex(pattern: string): RegExp | null {
  if (pattern.length > LIMITS.MAX_REGEX_LENGTH) return null;

  // Reject known ReDoS patterns: nested quantifiers like (a+)+, (a*)*
  if (/(\+|\*|\{)\s*\)(\+|\*|\{|\?)/.test(pattern)) return null;

  try {
    // Test compilation with a timeout-safe approach
    const regex = new RegExp(pattern);
    // Test against a short string to catch obvious issues
    "test".match(regex);
    return regex;
  } catch {
    return null;
  }
}

export class MemoHandlerRegistry {
  private handlers: MemoHandler[] = [];
  private compiledRegex: Map<string, RegExp> = new Map();

  constructor(customHandlers?: MemoHandler[]) {
    const custom = (customHandlers ?? [])
      .filter((h) => h.enabled !== false)
      .slice(0, LIMITS.MAX_MEMO_HANDLERS);

    // Pre-compile and validate all regex patterns
    for (const handler of custom) {
      if (handler.template.length > LIMITS.MAX_TEMPLATE_LENGTH) continue;
      const regex = validateRegex(handler.pattern);
      if (regex) {
        this.handlers.push(handler);
        this.compiledRegex.set(handler.name, regex);
      }
    }

    // Add built-in handlers
    for (const handler of BUILT_IN_HANDLERS) {
      this.handlers.push(handler);
      this.compiledRegex.set(handler.name, new RegExp(handler.pattern));
    }
  }

  process(event: CoinEvent): HandlerResult {
    const memo = event.memoDecoded ?? "";

    for (const handler of this.handlers) {
      const regex = this.compiledRegex.get(handler.name);
      if (!regex) continue;

      try {
        const match = memo.match(regex);
        if (match) {
          const formatted = this.formatTemplate(handler.template, event, match);
          return { matched: true, handlerName: handler.name, formattedMessage: formatted };
        }
      } catch {
        // Regex execution error, skip
      }
    }

    return { matched: false, handlerName: null, formattedMessage: null };
  }

  private formatTemplate(template: string, event: CoinEvent, match: RegExpMatchArray): string {
    const addressShort = event.address.slice(0, 10) + "..." + event.address.slice(-6);

    let result = template
      .replace(/\{amount\}/g, String(event.amount))
      .replace(/\{amountXch\}/g, event.amountXch.toFixed(6))
      .replace(/\{address\}/g, event.address)
      .replace(/\{addressShort\}/g, addressShort)
      .replace(/\{memo\}/g, event.memoDecoded ?? "(none)")
      .replace(/\{memoHex\}/g, event.memoHex ?? "")
      .replace(/\{height\}/g, String(event.createdHeight))
      .replace(/\{coinId\}/g, event.coinId)
      .replace(/\{network\}/g, event.network)
      .replace(/\{type\}/g, event.isCat ? "CAT" : "XCH")
      .replace(/\{assetId\}/g, event.assetId ?? "");

    // Replace match groups: {match1}, {match2}, etc. (max 9)
    for (let i = 1; i < Math.min(match.length, 10); i++) {
      result = result.replace(new RegExp(`\\{match${i}\\}`, "g"), match[i] ?? "");
    }

    return result;
  }

  updateHandlers(handlers: MemoHandler[]) {
    this.compiledRegex.clear();
    this.handlers = [];

    const custom = handlers
      .filter((h) => h.enabled !== false)
      .slice(0, LIMITS.MAX_MEMO_HANDLERS);

    for (const handler of custom) {
      if (handler.template.length > LIMITS.MAX_TEMPLATE_LENGTH) continue;
      const regex = validateRegex(handler.pattern);
      if (regex) {
        this.handlers.push(handler);
        this.compiledRegex.set(handler.name, regex);
      }
    }

    for (const handler of BUILT_IN_HANDLERS) {
      this.handlers.push(handler);
      this.compiledRegex.set(handler.name, new RegExp(handler.pattern));
    }
  }
}
