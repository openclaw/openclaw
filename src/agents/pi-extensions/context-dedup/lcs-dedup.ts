/**
 * Longest Common Substring (LCS) based deduplication.
 *
 * This algorithm finds repeated subsequences between messages and replaces
 * them with reference tags, enabling dedup even when messages aren't identical.
 *
 * Approach:
 * 1. For each pair of messages, find LCS using dynamic programming
 * 2. Only deduplicate substrings longer than minSubstringSize
 * 3. Replace repeated substrings with reference tags
 * 4. Sliding window: try progressively shorter windows to find max savings
 */

import { createHash } from "node:crypto";

export interface LCSConfig {
  mode: "off" | "on";
  minSubstringSize: number; // Minimum LCS length to consider
  maxSubstringSize: number; // Starting window size (e.g., half context)
  refTagSize: number; // Size of reference tag replacement
  maxIterations: number; // Max sliding window iterations
}

/**
 * Generate a short hash for a substring.
 */
function subHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 6);
}

/**
 * Find the longest common substring between two strings.
 * Uses dynamic programming with O(mn) time and O(mn) space.
 * For very long strings, falls back to a greedy approximation.
 */
// eslint-disable-next-line no-unused-vars
function findLCS(
  str1: string,
  str2: string,
  minLen: number,
): { substring: string; start1: number; start2: number } | null {
  const m = str1.length;
  const n = str2.length;

  // For very long strings, use greedy approach to avoid memory issues
  if (m * n > 10_000_000) {
    return findLCSGreedy(str1, str2, minLen);
  }

  // DP table
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));
  let maxLen = 0;
  let endIdx1 = 0;
  let endIdx2 = 0;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
        if (dp[i][j] > maxLen) {
          maxLen = dp[i][j];
          endIdx1 = i;
          endIdx2 = j;
        }
      }
    }
  }

  if (maxLen < minLen) {
    return null;
  }

  return {
    substring: str1.slice(endIdx1 - maxLen, endIdx1),
    start1: endIdx1 - maxLen,
    start2: endIdx2 - maxLen,
  };
}

/**
 * Greedy LCS for very long strings - finds longest match at start/end first.
 */
function findLCSGreedy(
  str1: string,
  str2: string,
  minLen: number,
): { substring: string; start1: number; start2: number } | null {
  // Try matching from start
  let commonLen = 0;
  const maxCheck = Math.min(str1.length, str2.length, 10000); // Limit check length

  for (let i = 0; i < maxCheck; i++) {
    if (str1[i] === str2[i]) {
      commonLen++;
    } else {
      break;
    }
  }

  if (commonLen >= minLen) {
    return { substring: str1.slice(0, commonLen), start1: 0, start2: 0 };
  }

  // Try matching from end
  commonLen = 0;
  for (let i = 0; i < maxCheck; i++) {
    const idx1 = str1.length - 1 - i;
    const idx2 = str2.length - 1 - i;
    if (idx1 >= 0 && idx2 >= 0 && str1[idx1] === str2[idx2]) {
      commonLen++;
    } else {
      break;
    }
  }

  if (commonLen >= minLen) {
    const start1 = str1.length - commonLen;
    const start2 = str2.length - commonLen;
    return { substring: str1.slice(start1), start1, start2 };
  }

  return null;
}

/**
 * Find all unique substrings that appear multiple times across messages.
 * Uses sliding window approach: start with large window, shrink down.
 */
export function findRepeatedSubstrings(
  messages: string[],
  config: LCSConfig,
): Map<string, { occurrences: number; totalSavings: number }> {
  if (config.mode === "off" || messages.length < 2) {
    return new Map();
  }

  const substringCounts = new Map<string, { occurrences: number; totalSavings: number }>();
  const refTagSize = config.refTagSize;

  // Start with max window size and decrease
  for (let windowSize = config.maxSubstringSize; windowSize >= config.minSubstringSize; ) {
    // For each message pair
    for (let i = 0; i < messages.length; i++) {
      for (let j = i + 1; j < messages.length; j++) {
        const str1 = messages[i];
        const str2 = messages[j];

        if (str1.length < windowSize || str2.length < windowSize) {
          continue;
        }

        // Slide through str1 with this window size
        const slideStep = Math.max(1, Math.floor(windowSize / 2));
        for (let pos1 = 0; pos1 <= str1.length - windowSize; pos1 += slideStep) {
          const window = str1.slice(pos1, pos1 + windowSize);

          // Check if this window exists in str2
          const pos2 = str2.indexOf(window);
          if (pos2 === -1) {
            continue;
          }

          // Found a match! Calculate savings
          const savings = window.length - refTagSize;
          if (savings <= 0) {
            continue;
          }

          const existing = substringCounts.get(window);

          if (existing) {
            existing.occurrences++;
            existing.totalSavings += savings;
          } else {
            substringCounts.set(window, { occurrences: 2, totalSavings: savings });
          }
        }
      }
    }

    const shrinkStep = Math.max(1, Math.floor(windowSize / 4));
    windowSize -= shrinkStep;
  }

  // Filter to only substrings that save space
  const result = new Map<string, { occurrences: number; totalSavings: number }>();
  for (const [hash, data] of substringCounts) {
    if (data.totalSavings > 0) {
      result.set(hash, data);
    }
  }

  return result;
}

/**
 * Apply LCS deduplication to a set of messages.
 * Returns modified messages with refs and the ref table.
 */
export function applyLCSDedup(
  messages: { content: string }[],
  config: LCSConfig,
): { messages: { content: string }[]; refTable: Record<string, string>; totalSavings: number } {
  if (config.mode === "off" || messages.length < 2) {
    return { messages, refTable: {}, totalSavings: 0 };
  }

  const rawContents = messages.map((m) =>
    typeof m.content === "string" ? m.content : JSON.stringify(m.content),
  );
  const repeatedSubs = findRepeatedSubstrings(rawContents, config);

  if (repeatedSubs.size === 0) {
    return { messages, refTable: {}, totalSavings: 0 };
  }

  const sortedSubs = [...repeatedSubs.entries()].toSorted((a, b) => {
    const bySavings = b[1].totalSavings - a[1].totalSavings;
    if (bySavings !== 0) {
      return bySavings;
    }
    return b[0].length - a[0].length;
  });

  const refTable: Record<string, string> = {};
  const modifiedContents = [...rawContents];
  const usedRefIds = new Set<string>();
  let totalSavings = 0;

  const nextRefId = (substring: string): { key: string; tag: string } => {
    const base = subHash(substring).toUpperCase();
    let candidate = base;
    let counter = 2;
    while (usedRefIds.has(candidate)) {
      candidate = `${base}_${counter}`;
      counter++;
    }
    usedRefIds.add(candidate);
    return {
      key: `REF_${candidate}`,
      tag: `<¯REF_${candidate}¯>`,
    };
  };

  for (const [substring] of sortedSubs) {
    if (!substring || substring.length < config.minSubstringSize) {
      continue;
    }

    const { key, tag } = nextRefId(substring);
    if (substring.length <= tag.length) {
      continue;
    }

    let seenFirst = false;
    let replacements = 0;

    for (let msgIdx = 0; msgIdx < modifiedContents.length; msgIdx++) {
      let content = modifiedContents[msgIdx] ?? "";
      if (!content.includes(substring)) {
        continue;
      }

      let searchFrom = 0;
      while (searchFrom < content.length) {
        const idx = content.indexOf(substring, searchFrom);
        if (idx === -1) {
          break;
        }

        if (!seenFirst) {
          seenFirst = true;
          searchFrom = idx + substring.length;
          continue;
        }

        content = content.slice(0, idx) + tag + content.slice(idx + substring.length);
        totalSavings += substring.length - tag.length;
        replacements++;
        searchFrom = idx + tag.length;
      }

      modifiedContents[msgIdx] = content;
    }

    if (replacements > 0) {
      refTable[key] = substring;
    }
  }

  if (totalSavings <= 0) {
    return { messages, refTable: {}, totalSavings: 0 };
  }

  return {
    messages: messages.map((msg, idx) => ({
      ...msg,
      content: modifiedContents[idx] ?? msg.content,
    })),
    refTable,
    totalSavings,
  };
}

/**
 * Simplified LCS dedup - find common prefixes/suffixes between consecutive messages.
 * Much faster than full LCS and handles the common file editing case.
 */
export function findCommonEdges(
  messages: string[],
  minSize: number = 50,
): { prefix?: string; suffix?: string; fromMsg: number; toMsg: number }[] {
  const results: { prefix?: string; suffix?: string; fromMsg: number; toMsg: number }[] = [];

  for (let i = 0; i < messages.length - 1; i++) {
    const curr = messages[i];
    const next = messages[i + 1];

    // Find common prefix
    let prefixLen = 0;
    const maxPrefix = Math.min(curr.length, next.length);
    while (prefixLen < maxPrefix && curr[prefixLen] === next[prefixLen]) {
      prefixLen++;
    }

    if (prefixLen >= minSize) {
      results.push({
        prefix: curr.slice(0, prefixLen),
        fromMsg: i,
        toMsg: i + 1,
      });
    }

    // Find common suffix
    let suffixLen = 0;
    const maxSuffix = Math.min(curr.length, next.length);
    while (
      suffixLen < maxSuffix &&
      curr[curr.length - 1 - suffixLen] === next[next.length - 1 - suffixLen]
    ) {
      suffixLen++;
    }

    if (suffixLen >= minSize) {
      results.push({
        suffix: curr.slice(-suffixLen),
        fromMsg: i,
        toMsg: i + 1,
      });
    }
  }

  return results;
}
