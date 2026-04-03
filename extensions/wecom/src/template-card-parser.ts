/**
 * 模板卡片解析器
 *
 * 从 LLM 回复文本中提取 markdown JSON 代码块，验证其是否为合法的企业微信模板卡片，
 * 返回提取到的卡片列表和剩余文本。
 *
 * 同时提供 maskTemplateCardBlocks 函数，用于在流式中间帧中隐藏正在构建的卡片代码块，
 * 避免 JSON 源码暴露给终端用户。
 */

import { VALID_CARD_TYPES } from "./const.js";
import type { ExtractedTemplateCard, TemplateCardExtractionResult } from "./interface.js";

// ============================================================================
// LLM 输出字段类型修正
// ============================================================================

/**
 * 将 LLM 可能输出的字符串/非法值修正为企业微信 API 要求的整数。
 * 返回修正后的整数，若无法识别则返回 undefined（由调用方决定是否删除该字段）。
 */
function coerceToInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    // 纯数字字符串
    const num = Number(trimmed);
    if (!Number.isNaN(num) && Number.isFinite(num)) {
      return Math.round(num);
    }
  }
  return undefined;
}

/** 将 LLM 可能输出的字符串/非法值修正为布尔值 */
function coerceToBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const t = value.trim().toLowerCase();
    if (t === "true" || t === "1" || t === "yes") return true;
    if (t === "false" || t === "0" || t === "no") return false;
  }
  if (typeof value === "number") return value !== 0;
  return undefined;
}

/** checkbox.mode 的语义别名映射 */
const MODE_ALIASES: Record<string, number> = {
  single: 0,
  radio: 0,
  "单选": 0,
  multi: 1,
  multiple: 1,
  "多选": 1,
};

/**
 * 修正 checkbox.mode：
 * - 0 → 单选，1 → 多选，仅允许这两个值
 * - 字符串数字 "0"/"1" → 整数
 * - 语义别名 "multi"/"single" 等 → 对应整数
 * - 其他正整数（如 2）→ clamp 到 1（多选）
 * - 无法识别 → 删除（让服务端使用默认值 0）
 */
function coerceCheckboxMode(value: unknown): number | undefined {
  let num: number | undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    num = Math.round(value);
  } else if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (trimmed in MODE_ALIASES) return MODE_ALIASES[trimmed];
    const parsed = Number(trimmed);
    if (!Number.isNaN(parsed)) num = Math.round(parsed);
  }
  if (num === undefined) return undefined;
  // mode 只允许 0（单选）或 1（多选），超出范围 clamp
  if (num <= 0) return 0;
  return 1;
}

/**
 * 对 LLM 生成的模板卡片 JSON 做字段类型修正，确保符合企业微信 API 的类型要求。
 *
 * 修正范围：
 * - checkbox.mode: uint32（0=单选，1=多选）
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
 * 原则：能修就修，修不了就删（让服务端走默认值），绝不阻塞发送。
 */
function normalizeTemplateCardFields(
  card: Record<string, unknown>,
  log?: (...args: any[]) => void,
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
            fixes.push(`checkbox.option_list.is_checked: ${JSON.stringify(opt.is_checked)} → ${fixed}`);
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
    log?.(`[template-card-parser] normalizeTemplateCardFields: ${fixes.length} fix(es) applied: ${fixes.join("; ")}`);
  }

  return card;
}

// ============================================================================
// 必填字段校验与自动补全
// ============================================================================

/** task_id 合法字符：数字、字母、_-@ */
const TASK_ID_RE = /^[a-zA-Z0-9_\-@]+$/;

/**
 * 生成一个合法的 task_id。
 * 格式：task_{cardType}_{timestamp}_{随机4位}，确保唯一且符合 API 要求。
 */
function generateTaskId(cardType: string): string {
  const rand = Math.random().toString(36).slice(2, 6);
  return `task_${cardType}_${Date.now()}_${rand}`;
}

/**
 * 校验并补全模板卡片的必填字段。
 *
 * 在 normalizeTemplateCardFields（类型修正）之后调用，确保卡片结构满足企业微信 API 的必填要求。
 *
 * 补全策略：
 * - task_id：所有卡片统一自动补全（交互型 API 必填，通知型插件也需要用于缓存回写）
 * - main_title：除 text_notice 外的 4 种卡片 API 必填，自动补 { title: "通知" }
 *   text_notice 要求 main_title.title 与 sub_title_text 至少填一个，缺两个时补 sub_title_text
 * - card_action：text_notice / news_notice API 必填，自动补 { type: 1, url: "https://work.weixin.qq.com" }
 * - checkbox：vote_interaction API 必填，无法凭空补全，仅记告警
 * - submit_button：vote_interaction / multiple_interaction API 必填，自动补 { text: "提交", key: "submit_default" }
 * - button_list：button_interaction API 必填，无法凭空补全，仅记告警
 * - select_list：multiple_interaction API 必填，无法凭空补全，仅记告警
 */
function validateAndFixRequiredFields(
  card: Record<string, unknown>,
  log?: (...args: any[]) => void,
): Record<string, unknown> {
  const cardType = card.card_type as string;
  const fixes: string[] = [];
  const warnings: string[] = [];

  // ── task_id（所有卡片：始终确保唯一性） ─────────────────────────────
  // LLM 可能编造时间戳导致重复，因此无论是否提供了 task_id，
  // 都提取语义前缀 + 代码追加真实时间戳和随机后缀来保证唯一。
  const rawTid = (typeof card.task_id === "string" && card.task_id.trim()) ? card.task_id.trim() : "";
  const rand = Math.random().toString(36).slice(2, 6);
  const ts = Date.now();

  let finalTid: string;
  if (rawTid) {
    // 提取 LLM 的语义前缀：去掉尾部的数字串（LLM 编造的假时间戳）
    const prefix = rawTid.replace(/_\d{8,}$/, "").replace(/[^a-zA-Z0-9_\-@]/g, "_").slice(0, 80);
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
  const hasMainTitle = mainTitle && typeof mainTitle === "object" &&
    (typeof mainTitle.title === "string" && mainTitle.title.trim());
  const hasSubTitleText = typeof card.sub_title_text === "string" && (card.sub_title_text as string).trim();

  switch (cardType) {
    case "text_notice":
      // text_notice: main_title.title 和 sub_title_text 至少一个
      if (!hasMainTitle && !hasSubTitleText) {
        card.sub_title_text = card.sub_title_text || "通知";
        fixes.push(`sub_title_text: (missing, no main_title either) → fallback "通知"`);
      }
      break;

    case "news_notice":
    case "button_interaction":
    case "vote_interaction":
    case "multiple_interaction":
      // 这四种 main_title 为必填
      if (!mainTitle || typeof mainTitle !== "object") {
        card.main_title = { title: "通知" };
        fixes.push(`main_title: (missing) → { title: "通知" }`);
      } else if (!hasMainTitle) {
        (mainTitle as Record<string, unknown>).title = "通知";
        fixes.push(`main_title.title: (empty) → "通知"`);
      }
      break;
  }

  // ── card_action（text_notice / news_notice 必填） ──────────────────
  if (cardType === "text_notice" || cardType === "news_notice") {
    if (!card.card_action || typeof card.card_action !== "object") {
      card.card_action = { type: 1, url: "https://work.weixin.qq.com" };
      fixes.push(`card_action: (missing) → { type: 1, url: "https://work.weixin.qq.com" }`);
    }
  }

  // ── submit_button（vote_interaction / multiple_interaction 必填） ──
  if (cardType === "vote_interaction" || cardType === "multiple_interaction") {
    if (!card.submit_button || typeof card.submit_button !== "object") {
      card.submit_button = { text: "提交", key: `submit_${cardType}_${Date.now()}` };
      fixes.push(`submit_button: (missing) → auto-generated`);
    }
  }

  // ── 核心业务字段（无法凭空补全，仅告警） ────────────────────────────
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
    log?.(`[template-card-parser] validateAndFixRequiredFields: ${fixes.length} fix(es): ${fixes.join("; ")}`);
  }
  if (warnings.length > 0) {
    log?.(`[template-card-parser] validateAndFixRequiredFields: ${warnings.length} warning(s): ${warnings.join("; ")}`);
  }

  return card;
}

// ============================================================================
// 简化格式 → 企微 API 格式转换（vote_interaction / multiple_interaction）
// ============================================================================

/**
 * 生成唯一的 question_key / submit_button.key。
 */
function generateKey(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${Date.now()}_${rand}`;
}

/**
 * 将 vote_interaction 的简化格式转换为企微 API 格式。
 *
 * 简化格式字段：
 *   title        → main_title.title
 *   description  → main_title.desc
 *   options      → checkbox.option_list（每个 {id, text} 直接透传）
 *   mode         → checkbox.mode（0=单选 1=多选）
 *   submit_text  → submit_button.text
 *
 * 代码自动生成：checkbox.question_key, submit_button.key
 *
 * 如果 LLM 已输出了合法的 API 原始格式（有 checkbox.option_list），则跳过转换直接透传。
 */
function transformVoteInteraction(
  card: Record<string, unknown>,
  log?: (...args: any[]) => void,
): Record<string, unknown> {
  // 防御性：如果已经是合法 API 格式，跳过
  const existingCheckbox = card.checkbox as Record<string, unknown> | undefined;
  if (existingCheckbox && typeof existingCheckbox === "object" && Array.isArray(existingCheckbox.option_list)) {
    log?.(`[template-card-parser] transformVoteInteraction: already has checkbox.option_list, skipping transform`);
    return card;
  }

  // 提取 options（简化格式的核心字段）
  const options = card.options as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(options) || options.length === 0) {
    log?.(`[template-card-parser] transformVoteInteraction: no "options" array found, skipping transform`);
    return card;
  }

  log?.(`[template-card-parser] transformVoteInteraction: transforming simplified format → API format`);
  log?.(`[template-card-parser] transformVoteInteraction: input=${JSON.stringify(card)}`);

  // ── 构建 main_title ──
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

  // ── 构建 checkbox（最多 20 个选项） ──
  const mode = coerceCheckboxMode(card.mode) ?? 0;
  const questionKey = generateKey("vote");
  const clampedOptions = options.slice(0, 20);
  if (options.length > 20) {
    log?.(`[template-card-parser] transformVoteInteraction: options count ${options.length} exceeds max 20, clamped to 20`);
  }
  card.checkbox = {
    question_key: questionKey,
    mode,
    option_list: clampedOptions.map((opt) => ({
      id: String(opt.id ?? opt.value ?? `opt_${Math.random().toString(36).slice(2, 6)}`),
      text: String(opt.text ?? opt.label ?? opt.name ?? ""),
    })),
  };
  delete card.options;
  delete card.mode;

  // ── 构建 submit_button ──
  const submitText = (card.submit_text as string) || "提交";
  card.submit_button = {
    text: submitText,
    key: generateKey("submit_vote"),
  };
  delete card.submit_text;

  // ── 清理 LLM 可能杜撰的无效字段 ──
  delete card.vote_question;
  delete card.vote_option;
  delete card.vote_options;

  log?.(`[template-card-parser] transformVoteInteraction: output=${JSON.stringify(card)}`);

  return card;
}

/**
 * 将 multiple_interaction 的简化格式转换为企微 API 格式。
 *
 * 简化格式字段：
 *   title            → main_title.title
 *   description      → main_title.desc
 *   selectors        → select_list（每个 {title, options: [{id, text}]} → {question_key, title, option_list}）
 *   submit_text      → submit_button.text
 *
 * 代码自动生成：select_list[].question_key, submit_button.key
 *
 * 如果 LLM 已输出了合法的 API 原始格式（有 select_list[0].option_list），则跳过转换直接透传。
 */
function transformMultipleInteraction(
  card: Record<string, unknown>,
  log?: (...args: any[]) => void,
): Record<string, unknown> {
  // 防御性：如果已经是合法 API 格式，跳过
  const existingSelectList = card.select_list as Array<Record<string, unknown>> | undefined;
  if (
    Array.isArray(existingSelectList) &&
    existingSelectList.length > 0 &&
    Array.isArray(existingSelectList[0]?.option_list)
  ) {
    log?.(`[template-card-parser] transformMultipleInteraction: already has select_list[].option_list, skipping transform`);
    return card;
  }

  // 提取 selectors（简化格式的核心字段）
  const selectors = card.selectors as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(selectors) || selectors.length === 0) {
    log?.(`[template-card-parser] transformMultipleInteraction: no "selectors" array found, skipping transform`);
    return card;
  }

  log?.(`[template-card-parser] transformMultipleInteraction: transforming simplified format → API format`);
  log?.(`[template-card-parser] transformMultipleInteraction: input=${JSON.stringify(card)}`);

  // ── 构建 main_title ──
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

  // ── 构建 select_list（最多 3 个选择器，每个最多 10 个选项） ──
  const clampedSelectors = selectors.slice(0, 3);
  if (selectors.length > 3) {
    log?.(`[template-card-parser] transformMultipleInteraction: selectors count ${selectors.length} exceeds max 3, clamped to 3`);
  }
  card.select_list = clampedSelectors.map((sel, idx) => {
    const selectorOptions = ((sel.options as Array<Record<string, unknown>>) ?? []).slice(0, 10);
    return {
      question_key: generateKey(`sel_${idx}`),
      title: String(sel.title ?? sel.label ?? `选择${idx + 1}`),
      option_list: selectorOptions.map((opt) => ({
        id: String(opt.id ?? opt.value ?? `opt_${Math.random().toString(36).slice(2, 6)}`),
        text: String(opt.text ?? opt.label ?? opt.name ?? ""),
      })),
    };
  });
  delete card.selectors;

  // ── 构建 submit_button ──
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
 * 对 vote_interaction / multiple_interaction 执行简化格式转换。
 * 其他 card_type 直接跳过。
 */
function transformSimplifiedCard(
  card: Record<string, unknown>,
  log?: (...args: any[]) => void,
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
 * 匹配 markdown 代码块的正则表达式
 * 支持 ```json ... ``` 和 ``` ... ``` 两种格式
 */
const CODE_BLOCK_RE = /```(?:json)?\s*\n([\s\S]*?)\n```/g;

/**
 * 匹配已闭合的代码块（含 card_type 关键词，用于中间帧遮罩）
 * 与 CODE_BLOCK_RE 相同，但用于 maskTemplateCardBlocks 中单独实例化
 */
const CLOSED_BLOCK_RE = /```(?:json)?\s*\n([\s\S]*?)\n```/g;

/**
 * 匹配未闭合的代码块尾部（LLM 正在输出中的代码块）
 * 以 ```json 或 ``` 开头，后面有内容但没有闭合的 ```
 */
const UNCLOSED_BLOCK_RE = /```(?:json)?\s*\n[\s\S]*$/;

/**
 * 从文本中提取模板卡片 JSON 代码块
 *
 * 匹配规则：
 * 1. 匹配所有 ```json ... ``` 或 ``` ... ``` 格式的代码块
 * 2. 尝试 JSON.parse 解析代码块内容
 * 3. 检查解析结果中是否包含合法的 card_type 字段
 * 4. 合法的卡片从原文中移除，不合法的保留
 *
 * @param text - LLM 回复的完整文本
 * @returns 提取结果，包含卡片列表和剩余文本
 */
export function extractTemplateCards(text: string, log?: (...args: any[]) => void): TemplateCardExtractionResult {
  const cards: ExtractedTemplateCard[] = [];
  /** 需要从原文中移除的代码块（记录完整匹配内容） */
  const blocksToRemove: string[] = [];

  log?.(`[template-card-parser] extractTemplateCards called, textLength=${text.length}`);

  let match: RegExpExecArray | null;
  // 重置正则的 lastIndex，确保从头匹配
  CODE_BLOCK_RE.lastIndex = 0;

  let blockIndex = 0;
  while ((match = CODE_BLOCK_RE.exec(text)) !== null) {
    const fullMatch = match[0];
    const jsonContent = match[1].trim();
    blockIndex++;

    log?.(`[template-card-parser] Found code block #${blockIndex}, length=${fullMatch.length}, preview=${jsonContent.slice(0, 1000)}...`);

    // 尝试解析 JSON
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(jsonContent) as Record<string, unknown>;
    } catch (e) {
      // JSON 解析失败，保留在原文中
      log?.(`[template-card-parser] Code block #${blockIndex} JSON parse failed: ${String(e)}`);
      continue;
    }

    // 检查是否包含合法的 card_type
    const cardType = parsed.card_type;
    if (typeof cardType !== "string" || !VALID_CARD_TYPES.includes(cardType)) {
      // card_type 不合法，保留在原文中
      log?.(`[template-card-parser] Code block #${blockIndex} has invalid card_type="${String(cardType)}", skipping`);
      continue;
    }

    log?.(`[template-card-parser] Code block #${blockIndex} is valid template card, card_type="${cardType}"`);

    // vote_interaction / multiple_interaction：简化格式 → API 格式转换
    transformSimplifiedCard(parsed, log);

    // 修正 LLM 可能输出的错误字段类型（如 checkbox.mode: "multi" → 1）
    normalizeTemplateCardFields(parsed, log);

    // 校验并补全必填字段（如缺失的 task_id、main_title、card_action）
    validateAndFixRequiredFields(parsed, log);

    // 合法的模板卡片，收集并标记移除
    cards.push({
      cardJson: parsed,
      cardType,
    });
    blocksToRemove.push(fullMatch);
  }

  // 从原文中移除已提取的代码块，生成剩余文本
  let remainingText = text;
  for (const block of blocksToRemove) {
    remainingText = remainingText.replace(block, "");
  }
  // 清理多余空行（连续 3 个以上换行合并为 2 个）
  remainingText = remainingText.replace(/\n{3,}/g, "\n\n").trim();

  log?.(`[template-card-parser] Extraction done: ${cards.length} card(s) found, remainingTextLength=${remainingText.length}`);

  return { cards, remainingText };
}

/**
 * 遮罩文本中的模板卡片代码块（用于流式中间帧展示）
 *
 * 在 LLM 流式输出过程中，累积文本可能包含：
 * 1. 已闭合的模板卡片 JSON 代码块 → 替换为友好提示文本
 * 2. 正在构建中的未闭合代码块 → 截断隐藏，避免 JSON 源码暴露
 *
 * 此函数仅做文本替换，不做 JSON 解析验证（中间帧性能优先）。
 * 只要代码块内容中出现 "card_type" 关键词就认为是模板卡片并遮罩。
 *
 * @param text - 当前累积文本
 * @returns 遮罩后的展示文本
 */
export function maskTemplateCardBlocks(text: string, log?: (...args: any[]) => void): string {
  let masked = text;
  let closedMaskCount = 0;
  let unclosedMasked = false;

  // 步骤一：处理已闭合的代码块
  CLOSED_BLOCK_RE.lastIndex = 0;
  masked = masked.replace(CLOSED_BLOCK_RE, (fullMatch, content: string) => {
    // 检查代码块内容是否包含 card_type 关键词
    if (/["']card_type["']/.test(content)) {
      closedMaskCount++;
      return "\n\n📋 *正在生成卡片消息...*\n\n";
    }
    // 非模板卡片代码块，保留原样
    return fullMatch;
  });

  // 步骤二：处理未闭合的代码块尾部（LLM 仍在输出中）
  // 检查是否有以 ``` 开头但没有闭合的代码块
  const unclosedMatch = UNCLOSED_BLOCK_RE.exec(masked);
  if (unclosedMatch) {
    const unclosedContent = unclosedMatch[0];
    // 如果未闭合部分包含 card_type 关键词，说明正在构建模板卡片 → 截断
    if (/["']card_type["']/.test(unclosedContent)) {
      unclosedMasked = true;
      masked = masked.slice(0, unclosedMatch.index) + "\n\n📋 *正在生成卡片消息...*";
    }
  }

  // 有遮罩行为时才打日志，避免每帧都刷屏
  if (closedMaskCount > 0 || unclosedMasked) {
    // log?.(`[template-card-parser] maskTemplateCardBlocks: closedMasked=${closedMaskCount}, unclosedMasked=${unclosedMasked}, textLength=${text.length}, maskedLength=${masked.length}`);
  }

  return masked;
}
