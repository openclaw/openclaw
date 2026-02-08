/**
 * Message Content Filter for Telegram Plugin
 * 
 * Filters messages based on regex patterns before they reach the agent.
 * Supports blockPatterns (denylist) and allowPatterns (allowlist) modes.
 */

export interface MessageFilterConfig {
  // Regex patterns to block (denylist)
  blockPatterns?: string[];

  // Regex patterns to allow (allowlist)
  allowPatterns?: string[];

  // Evaluation mode: "block-first" (default) or "allowlist-first"
  mode?: "block-first" | "allowlist-first";

  // Case sensitivity (default: false)
  caseSensitive?: boolean;

  // Apply to text content only, not captions (default: true)
  textOnly?: boolean;

  // Log filtered messages for debugging (default: true)
  logFiltered?: boolean;

  // Patterns to exclude from filtering (bypass)
  excludePatterns?: string[];
}

interface FilterResult {
  shouldFilter: boolean;
  reason?: string;
  matchedPattern?: string;
  matchedSource?: 'block' | 'allow' | 'exclude';
}

export class MessageFilter {
  private blockRegexes: RegExp[] = [];
  private allowRegexes: RegExp[] = [];
  private excludeRegexes: RegExp[] = [];
  private config: MessageFilterConfig;
  private readonly DEFAULT_FLAGS = 'i'; // Case-insensitive by default

  constructor(config: MessageFilterConfig = {}) {
    this.config = {
      mode: 'block-first',
      caseSensitive: false,
      textOnly: true,
      logFiltered: true,
      ...config,
    };

    this.compilePatterns();
  }

  private getFlags(): string {
    return this.config.caseSensitive ? '' : this.DEFAULT_FLAGS;
  }

  private compilePatterns(): void {
    const flags = this.getFlags();

    if (this.config.blockPatterns) {
      this.blockRegexes = this.config.blockPatterns.map(pattern => {
        try {
          return new RegExp(pattern, flags);
        } catch (err) {
          console.error(`[MessageFilter] Invalid block pattern: ${pattern}`, err);
          return null;
        }
      }).filter((r): r is RegExp => r !== null);
    }

    if (this.config.allowPatterns) {
      this.allowRegexes = this.config.allowPatterns.map(pattern => {
        try {
          return new RegExp(pattern, flags);
        } catch (err) {
          console.error(`[MessageFilter] Invalid allow pattern: ${pattern}`, err);
          return null;
        }
      }).filter((r): r is RegExp => r !== null);
    }

    if (this.config.excludePatterns) {
      this.excludeRegexes = this.config.excludePatterns.map(pattern => {
        try {
          return new RegExp(pattern, flags);
        } catch (err) {
          console.error(`[MessageFilter] Invalid exclude pattern: ${pattern}`, err);
          return null;
        }
      }).filter((r): r is RegExp => r !== null);
    }
  }

  /**
   * Check if message should be filtered
   * @param text - Message text
   * @param caption - Message caption (for media)
   * @returns Filter result
   */
  shouldFilter(text?: string | null, caption?: string | null): FilterResult {
    // Skip if no patterns configured
    if (this.blockRegexes.length === 0 && this.allowRegexes.length === 0) {
      return { shouldFilter: false };
    }

    // Determine text to filter
    const content = this.config.textOnly ? (text ?? '') : ((text ?? '') + ' ' + (caption ?? '')).trim();
    const isEmpty = !content || content.trim().length === 0;

    if (isEmpty) {
      // Empty messages pass through (let agent handle them)
      return { shouldFilter: false };
    }

    // Check exclude patterns first (bypass list)
    if (this.excludeRegexes.length > 0) {
      for (const regex of this.excludeRegexes) {
        if (regex.test(content)) {
          // Excluded from filtering, allow through
          return { 
            shouldFilter: false, 
            matchedSource: 'exclude',
            matchedPattern: regex.source 
          };
        }
      }
    }

    const mode = this.config.mode ?? 'block-first';

    if (mode === 'allowlist-first') {
      return this.checkAllowlistFirst(content);
    } else {
      return this.checkBlockFirst(content);
    }
  }

  private checkAllowlistFirst(content: string): FilterResult {
    // If allow patterns exist, message must match one
    if (this.allowRegexes.length > 0) {
      for (const regex of this.allowRegexes) {
        if (regex.test(content)) {
          // Matched allowlist, also check block patterns
          if (this.blockRegexes.length > 0) {
            for (const blockRegex of this.blockRegexes) {
              if (blockRegex.test(content)) {
                return this.logFilter(content, blockRegex.source, 'block', 'Matched allowlist but also blocked');
              }
            }
          }
          // Matched allowlist and not blocked
          return { 
            shouldFilter: false, 
            matchedSource: 'allow',
            matchedPattern: regex.source 
          };
        }
      }
      // Didn't match any allow pattern
      return this.logFilter(content, null, 'allow', 'No allowlist match');
    }

    // No allow patterns, proceed to block check
    if (this.blockRegexes.length > 0) {
      for (const regex of this.blockRegexes) {
        if (regex.test(content)) {
          return this.logFilter(content, regex.source, 'block');
        }
      }
    }

    // No matches, allow through
    return { shouldFilter: false };
  }

  private checkBlockFirst(content: string): FilterResult {
    // Check block patterns first
    if (this.blockRegexes.length > 0) {
      for (const regex of this.blockRegexes) {
        if (regex.test(content)) {
          // Also check if it's in allowlist
          if (this.allowRegexes.length > 0) {
            for (const allowRegex of this.allowRegexes) {
              if (allowRegex.test(content)) {
                // In allowlist, bypass block
                return { 
                  shouldFilter: false,
                  matchedSource: 'allow',
                  matchedPattern: allowRegex.source 
                };
              }
            }
          }
          // Not in allowlist, block it
          return this.logFilter(content, regex.source, 'block');
        }
      }
    }

    // Check allow patterns if they exist
    if (this.allowRegexes.length > 0) {
      for (const regex of this.allowRegexes) {
        if (regex.test(content)) {
          return { 
            shouldFilter: false,
            matchedSource: 'allow',
            matchedPattern: regex.source 
          };
        }
      }
      // Didn't match any allow pattern
      return this.logFilter(content, null, 'allow', 'No allowlist match');
    }

    // No matches, allow through
    return { shouldFilter: false };
  }

  private logFilter(content: string, pattern: string | null, source: 'block' | 'allow', customReason?: string): FilterResult {
    if (!this.config.logFiltered) {
      return { shouldFilter: true };
    }

    const reason = customReason || `Matched ${source} pattern`;
    const patternInfo = pattern ? ` (${pattern})` : '';
    const preview = content.length > 50 ? content.substring(0, 50) + '...' : content;

    console.log(`[MessageFilter] Blocked: ${preview}${patternInfo} - ${reason}`);

    return { shouldFilter: true, reason, matchedPattern: pattern, matchedSource: source };
  }

  /**
   * Update filter configuration at runtime
   */
  updateConfig(newConfig: Partial<MessageFilterConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.compilePatterns();
  }

  /**
   * Get current filter statistics
   */
  getStats(): { blockPatterns: number; allowPatterns: number; excludePatterns: number } {
    return {
      blockPatterns: this.blockRegexes.length,
      allowPatterns: this.allowRegexes.length,
      excludePatterns: this.excludeRegexes.length,
    };
  }
}

/**
 * Factory function to create a message filter from config
 */
export function createMessageFilter(config?: MessageFilterConfig): MessageFilter {
  return new MessageFilter(config);
}

/**
 * Check if a group config has message filtering enabled
 */
export function hasMessageFilterEnabled(groupConfig?: { messageFilter?: MessageFilterConfig }): boolean {
  return Boolean(groupConfig?.messageFilter && (
    groupConfig.messageFilter.blockPatterns?.length > 0 ||
    groupConfig.messageFilter.allowPatterns?.length > 0
  ));
}

/**
 * Extract message filter config from group config
 */
export function resolveMessageFilterConfig(
  groupConfig?: { messageFilter?: MessageFilterConfig }
): MessageFilterConfig | undefined {
  return groupConfig?.messageFilter;
}
