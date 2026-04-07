/**
 * Template Card Parser
 *
 * Extracts markdown JSON code blocks from LLM reply text, validates whether they
 * are valid WeCom template cards, and returns the extracted card list and remaining text.
 *
 * Also provides the maskTemplateCardBlocks function, used to hide card code blocks
 * being constructed during streaming intermediate frames, preventing JSON source code
 * from being exposed to end users.
 */

import { VALID_CARD_TYPES } from "./const.js";
import type { ExtractedTemplateCard, TemplateCardExtractionResult } from "./interface.js";

// ============================================================================
// LLM Output Field Type Correction
// ============================================================================

/**
 * Coerces potentially string/invalid values output by the LLM into integers
 * as required by the WeCom API.
 * Returns the corrected integer, or undefined if unrecognizable (caller decides whether to delete the field).
 */
function coerceToInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    // Pure numeric string
    const num = Number(trimmed);
    if (!Number.isNaN(num) && Number.isFinite(num)) {
      return Math.round(num);
    }
  }
  return undefined;
}

/** Coerces potentially string/invalid values output by the LLM into booleans */
function coerceToBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const t = value.trim().toLowerCase();
    if (t === "true" || t === "1" || t === "yes") {
      return true;
    }
    if (t === "false" || t === "0" || t === "no") {
      return false;
    }
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  return undefined;
}

/** Semantic alias mapping for checkbox.mode */
const MODE_ALIASES: Record<string, number> = {
  single: 0,
  radio: 0,
  单选: 0,
  multi: 1,
  multiple: 1,
  多选: 1,
};

/**
 * Coerces checkbox.mode:
 * - 0 = single-select, 1 = multi-select, only these two values are allowed
 * - String digits "0"/"1" -> integer
 * - Semantic aliases "multi"/"single" etc. -> corresponding integer
 * - Other positive integers (e.g. 2) -> clamped to 1 (multi-select)
 * - Unrecognizable -> deleted (let the server use default value 0)
 */
function coerceCheckboxMode(value: unknown): number | undefined {
  let num: number | undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    num = Math.round(value);
  } else if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (trimmed in MODE_ALIASES) {
      return MODE_ALIASES[trimmed];
    }
    const parsed = Number(trimmed);
    if (!Number.isNaN(parsed)) {
      num = Math.round(parsed);
    }
  }
  if (num === undefined) {
    return undefined;
  }
  // mode only allows 0 (single-select) or 1 (multi-select), clamp out-of-range values
  if (num <= 0) {
    return 0;
  }
  return 1;
}

/**
 * Corrects field types in LLM-generated template card JSON to meet WeCom API type requirements.
 *
 * Correction scope:
 * - checkbox.mode: uint32 (0=single-select, 1=multi-select)
 * - checkbox.disable: bool
 * - checkbox.option_list[].is_checked: bool
 * - source.desc_color: int
 * - quote_area.type: int
 * - card_action.type: int
 * - image_text_area.type: int
 * - horizontal_content_list[].type: int
 * - jump_list[].type: int
 * - button_list[].style: int
 * - button_selection.disable: bool
 * - select_list[].disable: bool
 *
 * Principle: fix what can be fixed, delete what can't (let the server use defaults), never block sending.
 */
function normalizeTemplateCardFields(
  card: Record<string, unknown>,
  log?: (...args: unknown[]) => void,
): Record<string, unknown> {
  const fixes: string[] = [];

  // ── checkbox ──────────────────────────────────────────────────────────
  const checkbox = card.checkbox as Record<string, unknown> | undefined;
  if (checkbox && typeof checkbox === "object") {
    // mode
    if ("mode" in checkbox) {
      const fixed = coerceCheckboxMode(checkbox.mode);
      if (fixed !== undefined) {
        if (checkbox.mode !== fixed) {
          fixes.push(`checkbox.mode: ${JSON.stringify(checkbox.mode)} → ${fixed}`);
        }
        checkbox.mode = fixed;
      } else {
        fixes.push(`checkbox.mode: ${JSON.stringify(checkbox.mode)} → (deleted, invalid)`);
        delete checkbox.mode;
      }
    }
    // disable
    if ("disable" in checkbox) {
      const fixed = coerceToBool(checkbox.disable);
      if (fixed !== undefined && checkbox.disable !== fixed) {
        fixes.push(`checkbox.disable: ${JSON.stringify(checkbox.disable)} → ${fixed}`);
        checkbox.disable = fixed;
      }
    }
    // option_list[].is_checked
    if (Array.isArray(checkbox.option_list)) {
      for (const opt of checkbox.option_list as Record<string, unknown>[]) {
        if (opt && typeof opt === "object" && "is_checked" in opt) {
          const fixed = coerceToBool(opt.is_checked);
          if (fixed !== undefined && opt.is_checked !== fixed) {
            fixes.push(
              `checkbox.option_list.is_checked: ${JSON.stringify(opt.is_checked)} → ${fixed}`,
            );
            opt.is_checked = fixed;
          }
        }
      }
    }
  }

  // ── source.desc_color ────────────────────────────────────────────────
  const source = card.source as Record<string, unknown> | undefined;
  if (source && typeof source === "object" && "desc_color" in source) {
    const fixed = coerceToInt(source.desc_color);
    if (fixed !== undefined && source.desc_color !== fixed) {
      fixes.push(`source.desc_color: ${JSON.stringify(source.desc_color)} → ${fixed}`);
      source.desc_color = fixed;
    }
  }

  // ── card_action.type ─────────────────────────────────────────────────
  const cardAction = card.card_action as Record<string, unknown> | undefined;
  if (cardAction && typeof cardAction === "object" && "type" in cardAction) {
    const fixed = coerceToInt(cardAction.type);
    if (fixed !== undefined && cardAction.type !== fixed) {
      fixes.push(`card_action.type: ${JSON.stringify(cardAction.type)} → ${fixed}`);
      cardAction.type = fixed;
    }
  }

  // ── quote_area.type ──────────────────────────────────────────────────
  const quoteArea = card.quote_area as Record<string, unknown> | undefined;
  if (quoteArea && typeof quoteArea === "object" && "type" in quoteArea) {
    const fixed = coerceToInt(quoteArea.type);
    if (fixed !== undefined && quoteArea.type !== fixed) {
      fixes.push(`quote_area.type: ${JSON.stringify(quoteArea.type)} → ${fixed}`);
      quoteArea.type = fixed;
    }
  }

  // ── image_text_area.type ─────────────────────────────────────────────
  const imageTextArea = card.image_text_area as Record<string, unknown> | undefined;
  if (imageTextArea && typeof imageTextArea === "object" && "type" in imageTextArea) {
    const fixed = coerceToInt(imageTextArea.type);
    if (fixed !== undefined && imageTextArea.type !== fixed) {
      fixes.push(`image_text_area.type: ${JSON.stringify(imageTextArea.type)} → ${fixed}`);
      imageTextArea.type = fixed;
    }
  }

  // ── horizontal_content_list[].type ───────────────────────────────────
  if (Array.isArray(card.horizontal_content_list)) {
    for (const item of card.horizontal_content_list as Record<string, unknown>[]) {
      if (item && typeof item === "object" && "type" in item) {
        const fixed = coerceToInt(item.type);
        if (fixed !== undefined && item.type !== fixed) {
          fixes.push(`horizontal_content_list.type: ${JSON.stringify(item.type)} → ${fixed}`);
          item.type = fixed;
        }
      }
    }
  }

  // ── jump_list[].type ─────────────────────────────────────────────────
  if (Array.isArray(card.jump_list)) {
    for (const item of card.jump_list as Record<string, unknown>[]) {
      if (item && typeof item === "object" && "type" in item) {
        const fixed = coerceToInt(item.type);
        if (fixed !== undefined && item.type !== fixed) {
          fixes.push(`jump_list.type: ${JSON.stringify(item.type)} → ${fixed}`);
          item.type = fixed;
        }
      }
    }
  }

  // ── button_list[].style ──────────────────────────────────────────────
  if (Array.isArray(card.button_list)) {
    for (const btn of card.button_list as Record<string, unknown>[]) {
      if (btn && typeof btn === "object" && "style" in btn) {
        const fixed = coerceToInt(btn.style);
        if (fixed !== undefined && btn.style !== fixed) {
          fixes.push(`button_list.style: ${JSON.stringify(btn.style)} → ${fixed}`);
          btn.style = fixed;
        }
      }
    }
  }

  // ── button_selection.disable ─────────────────────────────────────────
  const buttonSelection = card.button_selection as Record<string, unknown> | undefined;
  if (buttonSelection && typeof buttonSelection === "object" && "disable" in buttonSelection) {
    const fixed = coerceToBool(buttonSelection.disable);
    if (fixed !== undefined && buttonSelection.disable !== fixed) {
      fixes.push(`button_selection.disable: ${JSON.stringify(buttonSelection.disable)} → ${fixed}`);
      buttonSelection.disable = fixed;
    }
  }

  // ── select_list[].disable ────────────────────────────────────────────
  if (Array.isArray(card.select_list)) {
    for (const sel of card.select_list as Record<string, unknown>[]) {
      if (sel && typeof sel === "object" && "disable" in sel) {
        const fixed = coerceToBool(sel.disable);
        if (fixed !== undefined && sel.disable !== fixed) {
          fixes.push(`select_list.disable: ${JSON.stringify(sel.disable)} → ${fixed}`);
          sel.disable = fixed;
        }
      }
    }
  }

  if (fixes.length > 0) {
    log?.(
      `[template-card-parser] normalizeTemplateCardFields: ${fixes.length} fix(es) applied: ${fixes.join("; ")}`,
    );
  }

  return card;
}

// ============================================================================
// Required Field Validation and Auto-completion
// ============================================================================

/** Valid characters for task_id: digits, letters, _-@ */
const _TASK_ID_RE = /^[a-zA-Z0-9_\-@]+$/;

/**
 * Generates a valid task_id.
 * Format: task_{cardType}_{timestamp}_{random4chars}, ensuring uniqueness and API compliance.
 */
function _generateTaskId(cardType: string): string {
  const rand = Math.random().toString(36).slice(2, 6);
  return `task_${cardType}_${Date.now()}_${rand}`;
}

/**
 * Validates and auto-completes required fields for template cards.
 *
 * Called after normalizeTemplateCardFields (type correction) to ensure the card
 * structure meets WeCom API required field constraints.
 *
 * Auto-completion strategy:
 * - task_id: Uniformly auto-completed for all cards (required by interactive API; also needed for cache write-back in notification types)
 * - main_title: Required by API for 4 card types other than text_notice; auto-fills { title: "通知" }
 *   text_notice requires at least one of main_title.title or sub_title_text; fills sub_title_text when both are missing
 * - card_action: Required by text_notice / news_notice API; auto-fills { type: 1, url: "https://work.weixin.qq.com" }
 * - checkbox: Required by vote_interaction API; cannot be auto-filled, only logs a warning
 * - submit_button: Required by vote_interaction / multiple_interaction API; auto-fills { text: "提交", key: "submit_default" }
 * - button_list: Required by button_interaction API; cannot be auto-filled, only logs a warning
 * - select_list: Required by multiple_interaction API; cannot be auto-filled, only logs a warning
 */
function validateAndFixRequiredFields(
  card: Record<string, unknown>,
  log?: (...args: unknown[]) => void,
): Record<string, unknown> {
  const cardType = card.card_type as string;
  const fixes: string[] = [];
  const warnings: string[] = [];

  // ── task_id (all cards: always ensure uniqueness) ─────────────────────
  // LLM may fabricate timestamps leading to duplicates, so regardless of whether
  // a task_id is provided, we extract the semantic prefix and append a real
  // timestamp and random suffix to guarantee uniqueness.
  const rawTid = typeof card.task_id === "string" && card.task_id.trim() ? card.task_id.trim() : "";
  const rand = Math.random().toString(36).slice(2, 6);
  const ts = Date.now();

  let finalTid: string;
  if (rawTid) {
    // Extract the LLM's semantic prefix: strip trailing digit sequences (fake timestamps fabricated by LLM)
    const prefix = rawTid
      .replace(/_\d{8,}$/, "")
      .replace(/[^a-zA-Z0-9_\-@]/g, "_")
      .slice(0, 80);
    finalTid = prefix ? `${prefix}_${ts}_${rand}` : `task_${cardType}_${ts}_${rand}`;
  } else {
    finalTid = `task_${cardType}_${ts}_${rand}`;
  }

  if (finalTid !== rawTid) {
    fixes.push(`task_id: "${rawTid || "(missing)"}" → "${finalTid}"`);
  }
  card.task_id = finalTid;

  // ── main_title ────────────────────────────────────────────────────────
  const mainTitle = card.main_title as Record<string, unknown> | undefined;
  const hasMainTitle =
    mainTitle &&
    typeof mainTitle === "object" &&
    typeof mainTitle.title === "string" &&
    mainTitle.title.trim();
  const hasSubTitleText = typeof card.sub_title_text === "string" && card.sub_title_text.trim();

  switch (cardType) {
    case "text_notice":
      // text_notice: at least one of main_title.title and sub_title_text is required
      if (!hasMainTitle && !hasSubTitleText) {
        card.sub_title_text = card.sub_title_text || "通知";
        fixes.push(`sub_title_text: (missing, no main_title either) → fallback "通知"`);
      }
      break;

    case "news_notice":
    case "button_interaction":
    case "vote_interaction":
    case "multiple_interaction":
      // These four types require main_title
      if (!mainTitle || typeof mainTitle !== "object") {
        card.main_title = { title: "通知" };
        fixes.push(`main_title: (missing) → { title: "通知" }`);
      } else if (!hasMainTitle) {
        mainTitle.title = "通知";
        fixes.push(`main_title.title: (empty) → "通知"`);
      }
      break;
  }

  // ── card_action (required for text_notice / news_notice) ──────────────
  if (cardType === "text_notice" || cardType === "news_notice") {
    if (!card.card_action || typeof card.card_action !== "object") {
      card.card_action = { type: 1, url: "https://work.weixin.qq.com" };
      fixes.push(`card_action: (missing) → { type: 1, url: "https://work.weixin.qq.com" }`);
    }
  }

  // ── submit_button (required for vote_interaction / multiple_interaction) ──
  if (cardType === "vote_interaction" || cardType === "multiple_interaction") {
    if (!card.submit_button || typeof card.submit_button !== "object") {
      card.submit_button = { text: "提交", key: `submit_${cardType}_${Date.now()}` };
      fixes.push(`submit_button: (missing) → auto-generated`);
    }
  }

  // ── Core business fields (cannot be auto-filled, only warn) ────────────
  if (cardType === "button_interaction") {
    if (!Array.isArray(card.button_list) || card.button_list.length === 0) {
      warnings.push(`button_list is missing or empty (required for button_interaction)`);
    }
  }

  if (cardType === "vote_interaction") {
    if (!card.checkbox || typeof card.checkbox !== "object") {
      warnings.push(`checkbox is missing (required for vote_interaction)`);
    }
  }

  if (cardType === "multiple_interaction") {
    if (!Array.isArray(card.select_list) || card.select_list.length === 0) {
      warnings.push(`select_list is missing or empty (required for multiple_interaction)`);
    }
  }

  if (fixes.length > 0) {
    log?.(
      `[template-card-parser] validateAndFixRequiredFields: ${fixes.length} fix(es): ${fixes.join("; ")}`,
    );
  }
  if (warnings.length > 0) {
    log?.(
      `[template-card-parser] validateAndFixRequiredFields: ${warnings.length} warning(s): ${warnings.join("; ")}`,
    );
  }

  return card;
}

// ============================================================================
// Simplified Format -> WeCom API Format Conversion (vote_interaction / multiple_interaction)
// ============================================================================

/**
 * Generates a unique question_key / submit_button.key.
 */
function generateKey(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${Date.now()}_${rand}`;
}

/**
 * Converts vote_interaction from simplified format to WeCom API format.
 *
 * Simplified format fields:
 *   title        -> main_title.title
 *   description  -> main_title.desc
 *   options      -> checkbox.option_list (each {id, text} passed through directly)
 *   mode         -> checkbox.mode (0=single-select, 1=multi-select)
 *   submit_text  -> submit_button.text
 *
 * Auto-generated by code: checkbox.question_key, submit_button.key
 *
 * If the LLM has already output a valid API raw format (has checkbox.option_list), the transform is skipped.
 */
function transformVoteInteraction(
  card: Record<string, unknown>,
  log?: (...args: unknown[]) => void,
): Record<string, unknown> {
  // Defensive: skip if already in valid API format
  const existingCheckbox = card.checkbox as Record<string, unknown> | undefined;
  if (
    existingCheckbox &&
    typeof existingCheckbox === "object" &&
    Array.isArray(existingCheckbox.option_list)
  ) {
    log?.(
      `[template-card-parser] transformVoteInteraction: already has checkbox.option_list, skipping transform`,
    );
    return card;
  }

  // Extract options (core field of the simplified format)
  const options = card.options as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(options) || options.length === 0) {
    log?.(
      `[template-card-parser] transformVoteInteraction: no "options" array found, skipping transform`,
    );
    return card;
  }

  log?.(
    `[template-card-parser] transformVoteInteraction: transforming simplified format → API format`,
  );
  log?.(`[template-card-parser] transformVoteInteraction: input=${JSON.stringify(card)}`);

  // ── Build main_title ──
  const title = card.title as string | undefined;
  const description = card.description as string | undefined;
  if (title || description) {
    card.main_title = {
      ...(title ? { title } : {}),
      ...(description ? { desc: description } : {}),
    };
    delete card.title;
    delete card.description;
  }

  // ── Build checkbox (max 20 options) ──
  const mode = coerceCheckboxMode(card.mode) ?? 0;
  const questionKey = generateKey("vote");
  const clampedOptions = options.slice(0, 20);
  if (options.length > 20) {
    log?.(
      `[template-card-parser] transformVoteInteraction: options count ${options.length} exceeds max 20, clamped to 20`,
    );
  }
  card.checkbox = {
    question_key: questionKey,
    mode,
    option_list: clampedOptions.map((opt) => ({
      // oxlint-disable-next-line typescript/no-base-to-string -- SDK response fields have unknown shape
      id: String(opt.id ?? opt.value ?? `opt_${Math.random().toString(36).slice(2, 6)}`),
      // oxlint-disable-next-line typescript/no-base-to-string -- SDK response fields have unknown shape
      text: String(opt.text ?? opt.label ?? opt.name ?? ""),
    })),
  };
  delete card.options;
  delete card.mode;

  // ── Build submit_button ──
  const submitText = (card.submit_text as string) || "提交";
  card.submit_button = {
    text: submitText,
    key: generateKey("submit_vote"),
  };
  delete card.submit_text;

  // ── Clean up invalid fields potentially fabricated by LLM ──
  delete card.vote_question;
  delete card.vote_option;
  delete card.vote_options;

  log?.(`[template-card-parser] transformVoteInteraction: output=${JSON.stringify(card)}`);

  return card;
}

/**
 * Converts multiple_interaction from simplified format to WeCom API format.
 *
 * Simplified format fields:
 *   title            -> main_title.title
 *   description      -> main_title.desc
 *   selectors        -> select_list (each {title, options: [{id, text}]} -> {question_key, title, option_list})
 *   submit_text      -> submit_button.text
 *
 * Auto-generated by code: select_list[].question_key, submit_button.key
 *
 * If the LLM has already output a valid API raw format (has select_list[0].option_list), the transform is skipped.
 */
function transformMultipleInteraction(
  card: Record<string, unknown>,
  log?: (...args: unknown[]) => void,
): Record<string, unknown> {
  // Defensive: skip if already in valid API format
  const existingSelectList = card.select_list as Array<Record<string, unknown>> | undefined;
  if (
    Array.isArray(existingSelectList) &&
    existingSelectList.length > 0 &&
    Array.isArray(existingSelectList[0]?.option_list)
  ) {
    log?.(
      `[template-card-parser] transformMultipleInteraction: already has select_list[].option_list, skipping transform`,
    );
    return card;
  }

  // Extract selectors (core field of the simplified format)
  const selectors = card.selectors as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(selectors) || selectors.length === 0) {
    log?.(
      `[template-card-parser] transformMultipleInteraction: no "selectors" array found, skipping transform`,
    );
    return card;
  }

  log?.(
    `[template-card-parser] transformMultipleInteraction: transforming simplified format → API format`,
  );
  log?.(`[template-card-parser] transformMultipleInteraction: input=${JSON.stringify(card)}`);

  // ── Build main_title ──
  const title = card.title as string | undefined;
  const description = card.description as string | undefined;
  if (title || description) {
    card.main_title = {
      ...(title ? { title } : {}),
      ...(description ? { desc: description } : {}),
    };
    delete card.title;
    delete card.description;
  }

  // ── Build select_list (max 3 selectors, each with max 10 options) ──
  const clampedSelectors = selectors.slice(0, 3);
  if (selectors.length > 3) {
    log?.(
      `[template-card-parser] transformMultipleInteraction: selectors count ${selectors.length} exceeds max 3, clamped to 3`,
    );
  }
  card.select_list = clampedSelectors.map((sel, idx) => {
    const selectorOptions = ((sel.options as Array<Record<string, unknown>>) ?? []).slice(0, 10);
    return {
      question_key: generateKey(`sel_${idx}`),
      // oxlint-disable-next-line typescript/no-base-to-string -- SDK response fields have unknown shape
      title: String(sel.title ?? sel.label ?? `选择${idx + 1}`),
      option_list: selectorOptions.map((opt) => ({
        // oxlint-disable-next-line typescript/no-base-to-string -- SDK response fields have unknown shape
        id: String(opt.id ?? opt.value ?? `opt_${Math.random().toString(36).slice(2, 6)}`),
        // oxlint-disable-next-line typescript/no-base-to-string -- SDK response fields have unknown shape
        text: String(opt.text ?? opt.label ?? opt.name ?? ""),
      })),
    };
  });
  delete card.selectors;

  // ── Build submit_button ──
  const submitText = (card.submit_text as string) || "提交";
  card.submit_button = {
    text: submitText,
    key: generateKey("submit_multi"),
  };
  delete card.submit_text;

  log?.(`[template-card-parser] transformMultipleInteraction: output=${JSON.stringify(card)}`);

  return card;
}

/**
 * Performs simplified format conversion for vote_interaction / multiple_interaction.
 * Other card_types are skipped directly.
 */
function transformSimplifiedCard(
  card: Record<string, unknown>,
  log?: (...args: unknown[]) => void,
): Record<string, unknown> {
  const cardType = card.card_type as string;
  if (cardType === "vote_interaction") {
    return transformVoteInteraction(card, log);
  }
  if (cardType === "multiple_interaction") {
    return transformMultipleInteraction(card, log);
  }
  return card;
}

/**
 * Regex to match markdown code blocks.
 * Supports both ```json ... ``` and ``` ... ``` formats.
 */
const CODE_BLOCK_RE = /```(?:json)?\s*\n([\s\S]*?)\n```/g;

/**
 * Regex to match closed code blocks (containing the card_type keyword, used for intermediate frame masking).
 * Same as CODE_BLOCK_RE, but instantiated separately for use in maskTemplateCardBlocks.
 */
const CLOSED_BLOCK_RE = /```(?:json)?\s*\n([\s\S]*?)\n```/g;

/**
 * Regex to match unclosed code block tails (code blocks being output by the LLM).
 * Starts with ```json or ```, followed by content but without a closing ```.
 */
const UNCLOSED_BLOCK_RE = /```(?:json)?\s*\n[\s\S]*$/;

/**
 * Extracts template card JSON code blocks from text.
 *
 * Matching rules:
 * 1. Match all ```json ... ``` or ``` ... ``` format code blocks
 * 2. Attempt to JSON.parse the code block content
 * 3. Check if the parsed result contains a valid card_type field
 * 4. Valid cards are removed from the original text; invalid ones are kept
 *
 * @param text - The full LLM reply text
 * @returns Extraction result containing the card list and remaining text
 */
export function extractTemplateCards(
  text: string,
  log?: (...args: unknown[]) => void,
): TemplateCardExtractionResult {
  const cards: ExtractedTemplateCard[] = [];
  /** Code blocks to be removed from the original text (records the full match content) */
  const blocksToRemove: string[] = [];

  log?.(`[template-card-parser] extractTemplateCards called, textLength=${text.length}`);

  let match: RegExpExecArray | null;
  // Reset regex lastIndex to ensure matching starts from the beginning
  CODE_BLOCK_RE.lastIndex = 0;

  let blockIndex = 0;
  while ((match = CODE_BLOCK_RE.exec(text)) !== null) {
    const fullMatch = match[0];
    const jsonContent = match[1].trim();
    blockIndex++;

    log?.(
      `[template-card-parser] Found code block #${blockIndex}, length=${fullMatch.length}, preview=${jsonContent.slice(0, 1000)}...`,
    );

    // Attempt to parse JSON
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonContent) as Record<string, unknown>;
    } catch (e) {
      // JSON parse failed, keep in the original text
      log?.(`[template-card-parser] Code block #${blockIndex} JSON parse failed: ${String(e)}`);
      continue;
    }

    // Check if it contains a valid card_type
    const cardType = parsed.card_type;
    if (typeof cardType !== "string" || !VALID_CARD_TYPES.includes(cardType)) {
      // Invalid card_type, keep in the original text
      log?.(
        `[template-card-parser] Code block #${blockIndex} has invalid card_type="${String(cardType)}", skipping`,
      );
      continue;
    }

    log?.(
      `[template-card-parser] Code block #${blockIndex} is valid template card, card_type="${cardType}"`,
    );

    // vote_interaction / multiple_interaction: simplified format -> API format conversion
    transformSimplifiedCard(parsed, log);

    // Fix incorrect field types potentially output by LLM (e.g. checkbox.mode: "multi" -> 1)
    normalizeTemplateCardFields(parsed, log);

    // Validate and auto-complete required fields (e.g. missing task_id, main_title, card_action)
    validateAndFixRequiredFields(parsed, log);

    // Valid template card: collect and mark for removal
    cards.push({
      cardJson: parsed,
      cardType,
    });
    blocksToRemove.push(fullMatch);
  }

  // Remove extracted code blocks from the original text to produce remaining text
  let remainingText = text;
  for (const block of blocksToRemove) {
    remainingText = remainingText.replace(block, "");
  }
  // Clean up excess blank lines (merge 3+ consecutive newlines into 2)
  remainingText = remainingText.replace(/\n{3,}/g, "\n\n").trim();

  log?.(
    `[template-card-parser] Extraction done: ${cards.length} card(s) found, remainingTextLength=${remainingText.length}`,
  );

  return { cards, remainingText };
}

/**
 * Masks template card code blocks in text (for streaming intermediate frame display).
 *
 * During LLM streaming output, accumulated text may contain:
 * 1. Closed template card JSON code blocks -> replaced with a friendly prompt text
 * 2. Unclosed code blocks being constructed -> truncated and hidden to prevent JSON source exposure
 *
 * This function only performs text replacement without JSON parse validation (performance first for intermediate frames).
 * Any code block containing the "card_type" keyword is considered a template card and masked.
 *
 * @param text - Current accumulated text
 * @returns Masked display text
 */
export function maskTemplateCardBlocks(text: string, _log?: (...args: unknown[]) => void): string {
  let masked = text;
  let closedMaskCount = 0;
  let unclosedMasked = false;

  // Step 1: Handle closed code blocks
  CLOSED_BLOCK_RE.lastIndex = 0;
  masked = masked.replace(CLOSED_BLOCK_RE, (fullMatch, content: string) => {
    // Check if code block content contains the card_type keyword
    if (/["']card_type["']/.test(content)) {
      closedMaskCount++;
      return "\n\n📋 *正在生成卡片消息...*\n\n";
    }
    // Not a template card code block, keep as-is
    return fullMatch;
  });

  // Step 2: Handle unclosed code block tails (LLM is still outputting)
  // Check if there's a code block starting with ``` but not closed
  const unclosedMatch = UNCLOSED_BLOCK_RE.exec(masked);
  if (unclosedMatch) {
    const unclosedContent = unclosedMatch[0];
    // If the unclosed portion contains the card_type keyword, it's a template card being built -> truncate
    if (/["']card_type["']/.test(unclosedContent)) {
      unclosedMasked = true;
      masked = masked.slice(0, unclosedMatch.index) + "\n\n📋 *正在生成卡片消息...*";
    }
  }

  // Only log when masking occurs, to avoid flooding logs every frame
  if (closedMaskCount > 0 || unclosedMasked) {
    // log?.(`[template-card-parser] maskTemplateCardBlocks: closedMasked=${closedMaskCount}, unclosedMasked=${unclosedMasked}, textLength=${text.length}, maskedLength=${masked.length}`);
  }

  return masked;
}
