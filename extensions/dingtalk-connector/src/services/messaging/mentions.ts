/**
 * 多机器人 @ 提及解析器
 *
 * 目的：在多 Agent / 多 bot 群场景下，让 AI 写 "@dev-agent / @开发助手机器人"
 * 这样的自然语言时，connector 能自动把它们替换成钉钉识别的
 * `@$:LWCP_v1:$xxxxx`（chatbotUserId 加密 ID），并补上 `at.atDingtalkIds`。
 *
 * 解析来源：`channels.dingtalk-connector.accounts` 下配置的所有 bot。
 * 每个 bot 提供 3 类别名：
 *   1. accountId（如 `dev-bot`）
 *   2. 配置里的友好名 name（如 `开发助手机器人`）
 *   3. 通过 bindings 反查的 agentId（如 `dev-agent`）
 *
 * 设计原则：
 * - 不改变原始 AI 文本里不相关的 @ 内容（例如 @all、@某个手机号）
 * - 只替换能明确对应到某个 bot 的 token
 * - 幂等：已经是 `@$:LWCP_v1:$xxx` 格式的文本不会被二次替换
 */
import type { DingtalkAccountConfig, DingtalkConfig } from "../../types/index.ts";

/** 单个 bot 的 @ 解析表项 */
export interface BotMentionEntry {
  accountId: string;
  /** 机器人在钉钉侧的加密用户 ID（`$:LWCP_v1:$xxx`），没填则为 undefined */
  chatbotUserId?: string;
  /** 配置里的友好名（`accounts.<id>.name`） */
  name?: string;
  /** 通过 bindings 绑定的 agentId 列表（1 个 bot 通常绑 1 个 agent） */
  agentIds: string[];
  /** 所有候选别名的去重集合（含 accountId / name / agentIds） */
  aliases: string[];
}

export interface BuildMentionTableOptions {
  /** 额外别名映射：key 为 alias，value 为 accountId。用于调用方临时补充（例如 agent prompt 里的缩写） */
  extraAliases?: Record<string, string>;
  /**
   * 是否允许把“裸别名”（例如 `dev-agent`，前面没有 `@`）识别为 mention 目标。
   * 启用后不会直接改写原文，仅会把对应 chatbotUserId 注入 `injectedChatbotUserIds`，
   * 由上层在发送前自动追加 `@<chatbotUserId>` 到文末以触发钉钉真实 @。
   */
  detectBareAliases?: boolean;
}

/**
 * 从全局 cfg 里构建「bot 别名 → chatbotUserId」的解析表。
 *
 * 会同时扫描：
 * - `channels.dingtalk-connector.accounts.*`：accountId + name + chatbotUserId
 * - `bindings[]`：根据 `match.accountId` 反查 agentId
 */
export function buildBotMentionTable(
  cfg: any,
  options: BuildMentionTableOptions = {},
): BotMentionEntry[] {
  const root = cfg?.channels?.["dingtalk-connector"] as DingtalkConfig | undefined;
  const accountsMap = (root?.accounts as Record<string, DingtalkAccountConfig | undefined>) || {};

  const byAccountId = new Map<string, BotMentionEntry>();
  for (const [accountId, acct] of Object.entries(accountsMap)) {
    if (!acct) continue;
    byAccountId.set(accountId, {
      accountId,
      chatbotUserId: (acct as any).chatbotUserId?.trim?.() || undefined,
      name: (acct as any).name?.trim?.() || undefined,
      agentIds: [],
      aliases: [],
    });
  }

  const bindings = (cfg as any)?.bindings;
  if (Array.isArray(bindings)) {
    for (const b of bindings) {
      const match = b?.match;
      if (!match) continue;
      if (match.channel && match.channel !== "dingtalk-connector") continue;
      const accountId = match.accountId;
      const agentId = b.agentId;
      if (typeof accountId !== "string" || typeof agentId !== "string") continue;
      const entry = byAccountId.get(accountId);
      if (!entry) continue;
      if (!entry.agentIds.includes(agentId)) {
        entry.agentIds.push(agentId);
      }
    }
  }

  const extraMap = new Map<string, string>();
  if (options.extraAliases) {
    for (const [alias, accountId] of Object.entries(options.extraAliases)) {
      if (alias && accountId) {
        extraMap.set(alias.toLowerCase(), accountId);
      }
    }
  }

  for (const entry of byAccountId.values()) {
    const aliasSet = new Set<string>();
    aliasSet.add(entry.accountId);
    if (entry.name) aliasSet.add(entry.name);
    for (const aid of entry.agentIds) aliasSet.add(aid);
    for (const [alias, accountId] of extraMap.entries()) {
      if (accountId === entry.accountId) aliasSet.add(alias);
    }
    entry.aliases = Array.from(aliasSet);
  }

  return Array.from(byAccountId.values());
}

/** chatbotUserId 加密 ID 的正则（用于检测文本里已经写成加密形式的 @） */
const CHATBOT_ID_PATTERN = /\$:LWCP_v1:\$[A-Za-z0-9+/=]+/g;

/**
 * 把一批 accountId 解析成对应的 chatbotUserId 数组。
 * 找不到 chatbotUserId 的账号会被跳过，并通过 `missing` 报告，方便上层 log 警告。
 */
export function resolveAtAccountIdsToChatbotUserIds(
  cfg: any,
  atAccountIds: string[] | undefined,
): { resolved: string[]; missing: string[] } {
  if (!atAccountIds || atAccountIds.length === 0) {
    return { resolved: [], missing: [] };
  }
  const table = buildBotMentionTable(cfg);
  const byAccountId = new Map(table.map((e) => [e.accountId, e]));
  const resolved: string[] = [];
  const missing: string[] = [];
  for (const id of atAccountIds) {
    if (!id) continue;
    const entry = byAccountId.get(id);
    if (entry?.chatbotUserId) {
      resolved.push(entry.chatbotUserId);
    } else {
      missing.push(id);
    }
  }
  return { resolved, missing };
}

/**
 * 对文本中的 @ 别名做自动替换：
 * 1. `@<alias>` → `@<chatbotUserId>`（alias 命中某个 bot 时）
 * 2. 已经是 `@$:LWCP_v1:$xxx` 形式的 @ 原样保留
 *
 * 返回：
 * - `text`：替换后的文本
 * - `injectedChatbotUserIds`：本次替换中涉及到的 chatbotUserId 列表（调用方可合并到 atDingtalkIds）
 */
export function substituteBotMentions(
  text: string,
  cfg: any,
  options: BuildMentionTableOptions = {},
): { text: string; injectedChatbotUserIds: string[] } {
  if (!text || typeof text !== "string") {
    return { text: text ?? "", injectedChatbotUserIds: [] };
  }
  const table = buildBotMentionTable(cfg, options);

  // 别名 → chatbotUserId 查找表（不区分大小写，长别名优先匹配）
  const aliasToChatbotUserId = new Map<string, string>();
  for (const entry of table) {
    if (!entry.chatbotUserId) continue;
    for (const alias of entry.aliases) {
      const key = alias.toLowerCase();
      if (!aliasToChatbotUserId.has(key)) {
        aliasToChatbotUserId.set(key, entry.chatbotUserId);
      }
    }
  }

  if (aliasToChatbotUserId.size === 0) {
    return { text, injectedChatbotUserIds: [] };
  }

  // 按别名长度降序替换，避免 "dev-agent" 被短别名 "dev" 先匹配掉
  const aliases = Array.from(aliasToChatbotUserId.keys()).sort(
    (a, b) => b.length - a.length,
  );

  const injected = new Set<string>();
  let out = text;

  for (const alias of aliases) {
    const chatbotUserId = aliasToChatbotUserId.get(alias)!;
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 前置允许：开头 / 空白 / 标点；尾随允许：结尾 / 空白 / 标点（但不能是 id 字符）
    const pattern = new RegExp(
      `@(${escaped})(?![A-Za-z0-9_\\u4e00-\\u9fff\\-])`,
      "gi",
    );
    out = out.replace(pattern, (match, _matched, offset: number) => {
      // 跳过已经在 chatbotUserId 里的片段（保险起见）
      const before = out.slice(Math.max(0, offset - 1), offset);
      if (before === "$") return match;
      injected.add(chatbotUserId);
      return `@${chatbotUserId}`;
    });
  }

  // 可选兜底：识别裸别名（无 @ 前缀），并注入对应 chatbotUserId。
  // 说明：不少模型会输出“已拉上 dev-agent review”而不是“@dev-agent ...”，
  // 该兜底可强制触发真实 mention（通过发送层追加 @<chatbotUserId>）。
  if (options.detectBareAliases) {
    for (const alias of aliases) {
      const chatbotUserId = aliasToChatbotUserId.get(alias)!;
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(
        `(?<![@A-Za-z0-9_\\u4e00-\\u9fff\\-])(${escaped})(?![A-Za-z0-9_\\u4e00-\\u9fff\\-])`,
        "gi",
      );
      if (pattern.test(out)) {
        injected.add(chatbotUserId);
      }
    }
  }

  // 把文本里用户已经写好的 `@$:LWCP_v1:$xxx` 也收集起来
  const rawIds = out.match(CHATBOT_ID_PATTERN) || [];
  for (const id of rawIds) injected.add(id);

  return { text: out, injectedChatbotUserIds: Array.from(injected) };
}

/**
 * 高层入口：同时处理显式 `atAccountIds` 与文本里的自然语言 @。
 *
 * 用于 `dingtalk-connector.send*` 系列 Gateway 方法，在调 `sendProactive` 前把最终
 * 的 `content / atDingtalkIds` 准备好。
 */
export function prepareMultiBotMentions(params: {
  cfg: any;
  content: string;
  atAccountIds?: string[];
  atDingtalkIds?: string[];
  /** 额外别名：agent prompt 里有时会用缩写/昵称指代某个 bot */
  extraAliases?: Record<string, string>;
}): {
  content: string;
  atDingtalkIds: string[];
  /** atAccountIds 里那些没在 accounts.*.chatbotUserId 里配出来的 id，用于 log 警告 */
  missingAccountIds: string[];
} {
  const { cfg, content, atAccountIds, atDingtalkIds = [], extraAliases } = params;

  const explicit = resolveAtAccountIdsToChatbotUserIds(cfg, atAccountIds);
  const substituted = substituteBotMentions(content, cfg, { extraAliases });

  const merged = new Set<string>();
  for (const id of atDingtalkIds) if (id) merged.add(id);
  for (const id of explicit.resolved) merged.add(id);
  for (const id of substituted.injectedChatbotUserIds) merged.add(id);

  // 文本尾巴确保带 `@<chatbotUserId>`。buildMsgPayload 还会补一次，保证万无一失
  let finalContent = substituted.text;
  for (const id of explicit.resolved) {
    if (!finalContent.includes(`@${id}`)) {
      finalContent = `${finalContent} @${id}`;
    }
  }

  return {
    content: finalContent,
    atDingtalkIds: Array.from(merged),
    missingAccountIds: explicit.missing,
  };
}
