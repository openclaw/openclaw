/**
 * DingTalk message sending API
 *
 * Provides:
 * - sendMessageDingtalk: send Markdown messages (direct/group chat)
 *
 * API Docs:
 * - Direct chat: https://open.dingtalk.com/document/orgapp/chatbots-send-one-on-one-chat-messages-in-batches
 * - Group chat: https://open.dingtalk.com/document/orgapp/the-robot-sends-a-group-message
 */

import { getAccessToken } from "./client.js";
import type { DingtalkConfig, DingtalkSendResult } from "./types.js";

/** DingTalk API base URL */
const DINGTALK_API_BASE = "https://api.dingtalk.com";

/** HTTP request timeout (milliseconds) */
const REQUEST_TIMEOUT = 30000;

/** Default Markdown title */
const DEFAULT_MARKDOWN_TITLE = "Moltbot";

/**
 * Extract title from text (take first line, remove markdown symbols)
 */
function extractTitle(text: string, defaultTitle: string): string {
  const firstLine = text.split("\n")[0] || "";
  const cleaned = firstLine.replace(/^[#*\s\->]+/, "").slice(0, 20);
  return cleaned || defaultTitle;
}

/**
 * CJK (Chinese, Japanese, Korean) character range regex
 * Includes: CJK unified ideographs, extension areas, Japanese kana, Korean syllables, full-width punctuation, etc.
 */
const CJK_CHAR_REGEX =
  /[\u2E80-\u2FFF\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u3100-\u312F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u{20000}-\u{2A6DF}\u{2A700}-\u{2B73F}\u{2B740}-\u{2B81F}]/u;

/**
 * Determine whether to insert a space when merging two lines
 *
 * Standard Markdown soft break rules within paragraphs:
 * - Between CJK characters: direct concatenation (no space)
 * - Between CJK and Latin: insert space (mixed CJK/Latin text needs space separator)
 * - Between Latin and Latin: insert space
 */
function needsSpaceBetween(previousLine: string, nextLine: string): boolean {
  if (!previousLine || !nextLine) return false;

  const lastChar = previousLine[previousLine.length - 1];
  const firstChar = nextLine[0];

  const lastIsCJK = CJK_CHAR_REGEX.test(lastChar);
  const firstIsCJK = CJK_CHAR_REGEX.test(firstChar);

  // 两边都是 CJK 字符：直接拼接（无空格）
  if (lastIsCJK && firstIsCJK) {
    return false;
  }

  // 其他情况（CJK+Latin、Latin+CJK、Latin+Latin）都需要空格
  return true;
}

/**
 * DingTalk Markdown preprocessing: merge fragmented newlines
 *
 * DingTalk's sampleMarkdown template renders each \n as a real line break,
 * while standard Markdown treats single newlines within paragraphs as spaces (soft break).
 *
 * This function merges fragmented newlines within paragraphs into spaces, while preserving
 * true structural line breaks. Key rules:
 * - Empty lines (paragraph separators) are always preserved (only when both before and after are complete paragraphs)
 * - Code block content is preserved as-is
 * - New structural lines (headings/lists/quotes/separators) always start a new line
 * - Table rows are handled specially: all table-related lines after table start (starting with | or separator) are kept on separate lines
 * - Non-structural continuation lines are appended to the end of the previous line (only when previous line is plain text or list item)
 * - Plain text after heading lines is not appended to the heading line (headings are independent block elements)
 * - Trailing spaces and <br> tags at line end are removed (in DingTalk \n itself is a hard break,
 *   no need for Markdown hard break semantics, keeping them would prevent line merging)
 *
 * Fragmented empty line merging:
 * The block streaming coalescer uses "\n\n" as joiner to concatenate token chunks,
 * causing fake empty lines between words/phrases. This function detects this:
 * If an empty line is between two non-structural plain text fragments, treat the empty line as soft break
 * rather than true paragraph separator, thus merging fragmented text.
 */
export function preprocessDingtalkMarkdown(text: string): string {
  if (!text) return text;

  // Phase 1: Downgrade fragmented empty lines to single newlines
  // The block streaming coalescer uses "\n\n" to join token chunks, causing fake
  // paragraph separators between words. Remove these fake empty lines first,
  // so subsequent logic can correctly merge soft breaks.
  const normalizedText = collapseSpuriousBlankLines(text);

  const lines = normalizedText.split("\n");
  const result: string[] = [];
  let insideCodeBlock = false;
  let insideTable = false;

  for (const line of lines) {
    // Track code block fences
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
      insideCodeBlock = !insideCodeBlock;
      insideTable = false; // Code blocks interrupt tables
      result.push(line);
      continue;
    }

    // Preserve content inside code blocks as-is
    if (insideCodeBlock) {
      result.push(line);
      continue;
    }

    // Empty lines are always preserved (paragraph separators), and exit table mode
    if (line.trim() === "") {
      result.push(line);
      insideTable = false;
      continue;
    }

    const trimmedLine = line.trimStart();

    // Detect table rows (starting with |)
    const isTableRow = /^\|/.test(trimmedLine);
    // Detect table separator lines (like |---|---| or |:-:|:-:|)
    const isTableSeparator = /^\|[-:\|]+\|$/.test(trimmedLine);

    // Table mode handling
    if (isTableRow || isTableSeparator) {
      // If previous line is plain text and not a table row, end it first
      if (!insideTable && result.length > 0) {
        const prevLine = result[result.length - 1];
        if (prevLine && !prevLine.trim().startsWith("|") && prevLine.trim() !== "") {
          // Previous line is plain text, keep it separate
        }
      }
      insideTable = true;
      result.push(line);
      continue;
    }

    // If encountering non-table line while in table mode, exit table mode
    if (insideTable && !isTableRow && !isTableSeparator) {
      insideTable = false;
    }

    // Determine if current line is a new structural line (needs to be on its own line)
    const isNewStructuralLine =
      /^#{1,6}\s/.test(trimmedLine) || // Heading
      /^[-*+]\s/.test(trimmedLine) || // Unordered list
      /^\d+[.)]\s/.test(trimmedLine) || // Ordered list
      /^>\s?/.test(trimmedLine) || // Blockquote
      /^[-*_]{3,}\s*$/.test(trimmedLine); // Separator

    // New structural lines always stand alone
    if (isNewStructuralLine) {
      result.push(line);
      continue;
    }

    // Non-structural lines (plain text continuation): try to append to previous line
    // Condition: previous line exists, non-empty, and is not a block element
    const previousLine = result.length > 0 ? result[result.length - 1] : null;
    if (previousLine !== null && previousLine.trim() !== "") {
      // Headings, blockquotes, code block fences, table rows, separators are independent block elements,
      // should not append subsequent text
      const prevTrimmed = previousLine.trimStart();
      const prevIsBlockElement =
        /^#{1,6}\s/.test(prevTrimmed) ||
        /^>\s?/.test(prevTrimmed) ||
        /^\|/.test(prevTrimmed) ||
        /^[-*_]{3,}\s*$/.test(prevTrimmed) ||
        /^ {0,3}(`{3,}|~{3,})/.test(previousLine);
      if (prevIsBlockElement) {
        result.push(line);
        continue;
      }

      // Remove trailing spaces and <br> tags from end of previous line before checking
      // In DingTalk \n itself is a hard break, no need for Markdown hard break semantics
      // LLMs often add trailing spaces at line end, which prevents line merging
      const prevStripped = previousLine.replace(/\s+$/, "").replace(/<br\s*\/?>$/i, "");

      // Append to end of previous line
      // Soft break between CJK characters: direct concatenation (no space),
      // otherwise insert space (Latin characters need space separator)
      const separator = needsSpaceBetween(prevStripped, trimmedLine) ? " " : "";
      result[result.length - 1] = prevStripped + separator + trimmedLine;
      continue;
    }

    result.push(line);
  }

  return result.join("\n");
}

/**
 * Determine if a line is a Markdown structural line (element that needs to be on its own line)
 */
function isStructuralLine(line: string): boolean {
  const trimmed = line.trimStart();
  if (!trimmed) return false;
  return (
    /^#{1,6}\s/.test(trimmed) || // Heading
    /^[-*+]\s/.test(trimmed) || // Unordered list
    /^\d+[.)]\s/.test(trimmed) || // Ordered list
    /^>\s?/.test(trimmed) || // Blockquote
    /^[-*_]{3,}\s*$/.test(trimmed) || // Separator
    /^\|/.test(trimmed) || // Table row
    /^ {0,3}(`{3,}|~{3,})/.test(line) // Code block fence
  );
}

/**
 * Collapse spurious blank lines introduced by the block streaming coalescer.
 *
 * The coalescer joins token chunks with "\n\n" (paragraph joiner), which
 * creates fake paragraph separators between words/phrases. For example:
 *   "已启动\n\nopencode\n\n写快排"
 * should become:
 *   "已启动\nopencode\n写快排"
 *
 * Detection: a blank line between two non-structural plain-text lines is
 * considered spurious **unless** the previous line ends with sentence-ending
 * punctuation (period, exclamation, question mark, colon, semicolon, or
 * closing brackets/quotes), which signals a genuine paragraph boundary.
 *
 * Blank lines are always preserved when:
 * - Adjacent to structural lines (headings, lists, blockquotes, tables, etc.)
 * - The previous line ends with sentence-ending punctuation
 * - Inside code blocks
 */
function collapseSpuriousBlankLines(text: string): string {
  const lines = text.split("\n");
  if (lines.length < 3) return text;

  const result: string[] = [];
  let insideCodeBlock = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];

    // Track code blocks
    if (/^ {0,3}(`{3,}|~{3,})/.test(line)) {
      insideCodeBlock = !insideCodeBlock;
      result.push(line);
      continue;
    }

    if (insideCodeBlock) {
      result.push(line);
      continue;
    }

    // Non-empty lines are preserved directly
    if (line.trim() !== "") {
      result.push(line);
      continue;
    }

    // Current line is empty: check if it's a spurious paragraph separator
    // Find the most recent non-empty line going backward
    const prevNonEmpty = findLastNonEmptyLine(result);
    // Find the next non-empty line going forward
    const nextNonEmpty = findNextNonEmptyLine(lines, lineIndex + 1);

    // If no non-empty lines before or after, preserve empty line
    if (prevNonEmpty === null || nextNonEmpty === null) {
      result.push(line);
      continue;
    }

    // If adjacent to structural lines, preserve empty line (true paragraph separator)
    if (isStructuralLine(prevNonEmpty) || isStructuralLine(nextNonEmpty)) {
      result.push(line);
      continue;
    }

    // Determine whether this blank line is a genuine paragraph separator or a
    // spurious joiner inserted by the block streaming coalescer.
    //
    // Heuristic: a blank line is genuine when the previous line ends with
    // sentence-ending punctuation (period, exclamation, question mark, or their
    // CJK equivalents, or a closing parenthesis/bracket after such punctuation).
    // In all other cases between two non-structural plain-text lines, the blank
    // line is likely a coalescer artifact and should be collapsed.
    const prevTrimmed = prevNonEmpty.trimEnd();

    const prevEndsWithSentencePunctuation = /[.。!！?？:：;；)\]）】"'」』]$/.test(prevTrimmed);

    // If the previous line looks like a complete sentence/paragraph, keep the
    // blank line as a real paragraph separator.
    if (prevEndsWithSentencePunctuation) {
      result.push(line);
      continue;
    }

    // Skip redundant empty lines in consecutive empty lines (keep only one)
    const nextLineRaw = lines[lineIndex + 1];
    if (nextLineRaw !== undefined && nextLineRaw.trim() === "") {
      result.push(line);
      continue;
    }

    // Otherwise consider it a spurious empty line, skip (don't add to result)
    // This makes the text lines before and after adjacent, and subsequent soft break
    // merging logic will handle them
  }

  return result.join("\n");
}

/** Find the last non-empty line from the result array */
function findLastNonEmptyLine(lines: string[]): string | null {
  for (let resultIndex = lines.length - 1; resultIndex >= 0; resultIndex--) {
    if (lines[resultIndex].trim() !== "") return lines[resultIndex];
  }
  return null;
}

/** Find the next non-empty line from the source array */
function findNextNonEmptyLine(lines: string[], startIndex: number): string | null {
  for (let searchIndex = startIndex; searchIndex < lines.length; searchIndex++) {
    if (lines[searchIndex].trim() !== "") return lines[searchIndex];
  }
  return null;
}

/**
 * Send message parameters
 */
export interface SendMessageParams {
  /** DingTalk config */
  cfg: DingtalkConfig;
  /** Target ID (user ID or conversation ID) */
  to: string;
  /** Message text content */
  text: string;
  /** Chat type */
  chatType: "direct" | "group";
  /** Markdown message title (optional) */
  title?: string;
}

/**
 * DingTalk API error response
 */
interface DingtalkApiError {
  code?: string;
  message?: string;
  requestid?: string;
}

/**
 * Send Markdown message to DingTalk
 *
 * Calls different APIs based on chatType:
 * - direct: /v1.0/robot/oToMessages/batchSend (direct chat batch send)
 * - group: /v1.0/robot/groupMessages/send (group chat send)
 *
 * Always uses sampleMarkdown template, supports tables, code blocks, etc.
 *
 * @param params Send parameters
 * @returns Send result
 * @throws Error if credentials not configured or API call fails
 */
export async function sendMessageDingtalk(params: SendMessageParams): Promise<DingtalkSendResult> {
  const { cfg, to, text, chatType, title } = params;

  // Validate credentials
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error("DingTalk credentials not configured (clientId, clientSecret required)");
  }

  // Get Access Token
  const accessToken = await getAccessToken(cfg.clientId, cfg.clientSecret);

  // Extract title
  const msgTitle = title || extractTitle(text, DEFAULT_MARKDOWN_TITLE);

  if (chatType === "direct") {
    return sendDirectMessage({ cfg, to, text, accessToken, title: msgTitle });
  } else {
    return sendGroupMessage({ cfg, to, text, accessToken, title: msgTitle });
  }
}

/**
 * Send direct chat message
 *
 * Calls /v1.0/robot/oToMessages/batchSend API
 * Always uses sampleMarkdown template
 *
 * @internal
 */
async function sendDirectMessage(params: {
  cfg: DingtalkConfig;
  to: string;
  text: string;
  accessToken: string;
  title: string;
}): Promise<DingtalkSendResult> {
  const { cfg, to, text, accessToken, title } = params;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const response = await fetch(`${DINGTALK_API_BASE}/v1.0/robot/oToMessages/batchSend`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": accessToken,
      },
      body: JSON.stringify({
        robotCode: cfg.clientId,
        userIds: [to],
        msgKey: "sampleMarkdown",
        msgParam: JSON.stringify({ title, text: preprocessDingtalkMarkdown(text) }),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `DingTalk direct message send failed: HTTP ${response.status}`;

      try {
        const errorData = JSON.parse(errorText) as DingtalkApiError;
        if (errorData.message) {
          errorMessage = `DingTalk direct message send failed: ${errorData.message} (code: ${errorData.code ?? "unknown"})`;
        }
      } catch {
        errorMessage = `${errorMessage} - ${errorText}`;
      }

      throw new Error(errorMessage);
    }

    const data = (await response.json()) as {
      processQueryKey?: string;
      invalidStaffIdList?: string[];
      flowControlledStaffIdList?: string[];
    };

    // 检查是否有无效用户
    if (data.invalidStaffIdList && data.invalidStaffIdList.length > 0) {
      throw new Error(
        `DingTalk direct message send failed: invalid user IDs: ${data.invalidStaffIdList.join(", ")}`,
      );
    }

    return {
      messageId: data.processQueryKey ?? `dm_${Date.now()}`,
      conversationId: to,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`DingTalk direct message send timed out after ${REQUEST_TIMEOUT}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Send group chat message
 *
 * Calls /v1.0/robot/groupMessages/send API
 * Always uses sampleMarkdown template
 *
 * @internal
 */
async function sendGroupMessage(params: {
  cfg: DingtalkConfig;
  to: string;
  text: string;
  accessToken: string;
  title: string;
}): Promise<DingtalkSendResult> {
  const { cfg, to, text, accessToken, title } = params;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const response = await fetch(`${DINGTALK_API_BASE}/v1.0/robot/groupMessages/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": accessToken,
      },
      body: JSON.stringify({
        robotCode: cfg.clientId,
        openConversationId: to,
        msgKey: "sampleMarkdown",
        msgParam: JSON.stringify({ title, text: preprocessDingtalkMarkdown(text) }),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `DingTalk group message send failed: HTTP ${response.status}`;

      try {
        const errorData = JSON.parse(errorText) as DingtalkApiError;
        if (errorData.message) {
          errorMessage = `DingTalk group message send failed: ${errorData.message} (code: ${errorData.code ?? "unknown"})`;
        }
      } catch {
        errorMessage = `${errorMessage} - ${errorText}`;
      }

      throw new Error(errorMessage);
    }

    const data = (await response.json()) as {
      processQueryKey?: string;
    };

    return {
      messageId: data.processQueryKey ?? `gm_${Date.now()}`,
      conversationId: to,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`DingTalk group message send timed out after ${REQUEST_TIMEOUT}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
