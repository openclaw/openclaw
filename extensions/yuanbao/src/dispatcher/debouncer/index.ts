/**
 * Message debounce dispatcher
 *
 * 将 SDK createChannelInboundDebouncer 的初始化和配置逻辑集中管理。
 * 防抖 flush 后通过 SessionQueue 保证同一会话的消息顺序执行管线。
 */

import {
  createChannelInboundDebouncer,
  shouldDebounceTextInbound,
} from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { isAbortRequestText, isBtwRequestText } from "openclaw/plugin-sdk/reply-runtime";
import { extractTextFromMsgBody } from "../../business/messaging/extract.js";
import { createPipeline } from "../../business/pipeline/create.js";
import type { PipelineContext, DebouncerItem } from "../../business/pipeline/types.js";
import { createLog } from "../../logger.js";
import type { ModuleLog } from "../../logger.js";
import type { YuanbaoInboundMessage } from "../../types.js";
import { SessionAbortManager } from "../queue/session-abort-manager.js";
import { SessionQueue } from "../queue/session-queue.js";

// ============ 单例 ============

const pipeline = createPipeline();
const sessionQueue = new SessionQueue();
const sessionAbortManager = new SessionAbortManager();

// ============ 防抖器（延迟初始化） ============

let debouncer: ReturnType<typeof createChannelInboundDebouncer<DebouncerItem>>["debouncer"] | null =
  null;

/** Media类型集合，用于从 msg_body 中分离文本元素和Media元素 */
const MEDIA_MSG_TYPES = new Set([
  "TIMImageElem",
  "TIMSoundElem",
  "TIMVideoFileElem",
  "TIMFileElem",
]);

/**
 * 构建基础 sessionKey（不含指令后缀）
 *
 * 群聊: `group:{accountId}:{groupCode}`
 * C2C: `direct:{accountId}:{fromAccount}`
 */
function buildBaseSessionKey(item: DebouncerItem): string {
  const { msg, isGroup, account } = item;
  return isGroup
    ? `group:${account.accountId}:${msg.group_code?.trim() || "unknown"}`
    : `direct:${account.accountId}:${msg.from_account?.trim() || "unknown"}`;
}

/**
 * 从 DebouncerItem 中Extract纯文本内容（轻量版，仅拼接 TIMTextElem）
 */
function extractRawText(item: DebouncerItem): string {
  if (!item.msg.msg_body) {
    return "";
  }
  return item.msg.msg_body
    .filter((elem: { msg_type?: string }) => elem.msg_type === "TIMTextElem")
    .map((elem: { msg_content?: { text?: string } }) => elem.msg_content?.text ?? "")
    .join("")
    .trim();
}

/**
 * 构建 sessionKey —— 参照 telegram getTelegramSequentialKey，
 * In direct chat scenarios, assign independent serial queues for different commands to prevent control commands from being blocked by regular messages.
 *
 * Direct chat scenario:
 * - abort 指令 → `{base}:control`      （停止指令需要立即响应，不排在普通消息后面）
 * - btw 指令   → `{base}:btw:{seqId}`  （插话指令独立执行，不阻塞也不被阻塞）
 * - 普通消息   → `{base}`              （同会话内顺序执行）
 *
 * Group chat scenario:
 * - 统一使用 `{base}`，不区分指令类型
 */
function buildSessionKey(item: DebouncerItem): string {
  const base = buildBaseSessionKey(item);

  // 群聊场景不区分指令，统一走同一队列
  if (item.isGroup) {
    return base;
  }

  // Direct chat scenario:按指令类型分配独立队列
  const rawText = extractRawText(item);

  // abort（/stop 等）→ 走独立的 control 队列，确保能立即中断
  if (isAbortRequestText(rawText)) {
    return `${base}:control`;
  }

  // btw（/btw ...）→ 每条插话走独立队列，互不阻塞
  if (isBtwRequestText(rawText)) {
    const seqId = item.msg.msg_seq ?? item.msg.msg_id ?? "";
    return seqId ? `${base}:btw:${seqId}` : `${base}:btw`;
  }

  return base;
}

/**
 * 判断是否为私聊场景下的普通消息（非 btw、非 abort 等控制指令）。
 *
 * 只有私聊普通消息才需要触发"新问题打断旧问题"逻辑。
 */
function isDirectNormalMessage(item: DebouncerItem): boolean {
  if (item.isGroup) {
    return false;
  }
  const rawText = extractRawText(item);
  if (isAbortRequestText(rawText)) {
    return false;
  }
  if (isBtwRequestText(rawText)) {
    return false;
  }
  return true;
}

/**
 * 构建最小上下文，兼容 extractTextFromMsgBody 的 MessageHandlerContext 参数
 */
function buildMinCtx(item: DebouncerItem, log: ReturnType<typeof createLog>) {
  return {
    account: item.account,
    config: item.config,
    core: item.core,
    log: { ...log, verbose: (...a: [string, Record<string, unknown>?]) => log.debug(...a) },
    wsClient: item.wsClient,
  };
}

/**
 * 将多条防抖消息的 msg_body 合并为一条合成消息。
 *
 * 参照 telegram onFlush 中 entries.length > 1 时的合并逻辑：
 * - 文本元素：按顺序拼接所有 items 的 TIMTextElem
 * - Media元素：按顺序收集所有 items 的Media元素
 * - 其他字段以 primary（最后一条）为准
 */
function buildSyntheticMessage(
  primary: DebouncerItem,
  items: DebouncerItem[],
): YuanbaoInboundMessage {
  const combinedBody = items.flatMap((item) => item.msg.msg_body ?? []);
  return {
    ...primary.msg,
    msg_body: combinedBody,
  };
}

/**
 * Build pipeline context
 */
function buildPipelineContext(primary: DebouncerItem, items: DebouncerItem[]): PipelineContext {
  return {
    // 不可变输入
    raw: primary.msg,
    flushedItems: items,
    isGroup: primary.isGroup,
    account: primary.account,
    config: primary.config,
    core: primary.core,
    wsClient: primary.wsClient,
    log: createLog("pipeline", primary.log as ModuleLog | undefined),
    abortSignal: (primary as DebouncerItem & { _sessionAbortSignal?: AbortSignal })
      ._sessionAbortSignal
      ? combineAbortSignals(
          primary.abortSignal,
          (primary as DebouncerItem & { _sessionAbortSignal?: AbortSignal })._sessionAbortSignal,
        )
      : primary.abortSignal,
    statusSink: primary.statusSink,

    // 可变中间状态（由各中间件逐步填充）
    fromAccount: "",
    rawBody: "",
    medias: [],
    isAtBot: false,
    mentions: [],
    linkUrls: [],
    commandAuthorized: false,
    rewrittenBody: "",
    hasControlCommand: false,
    effectiveWasMentioned: false,
    mediaPaths: [],
    mediaTypes: [],
  };
}

/**
 * 组合 gateway 级和会话级 AbortSignal。
 *
 * 任一 signal 触发 abort 时，组合后的 signal 也会 abort。
 */
function combineAbortSignals(
  gatewaySignal?: AbortSignal,
  sessionSignal?: AbortSignal,
): AbortSignal | undefined {
  if (!gatewaySignal && !sessionSignal) {
    return undefined;
  }
  if (!gatewaySignal) {
    return sessionSignal;
  }
  if (!sessionSignal) {
    return gatewaySignal;
  }

  return AbortSignal.any([gatewaySignal, sessionSignal]);
}

/**
 * 清理挂载在 DebouncerItem 上的会话级 AbortSignal（避免内存泄漏）。
 *
 * 单条和多条路径都需要在 finally 中调用。
 */
function cleanupSessionSignal(primary: DebouncerItem): void {
  const sessionSignal = (primary as DebouncerItem & { _sessionAbortSignal?: AbortSignal })
    ._sessionAbortSignal;
  if (sessionSignal) {
    const baseKey = buildBaseSessionKey(primary);
    sessionAbortManager.cleanup(baseKey, sessionSignal);
  }
}

/**
 * Ensure the debouncer is initialized and return it
 */
export function ensureDebouncer(config: OpenClawConfig) {
  if (debouncer) {
    return debouncer;
  }

  const debouncerLog = createLog("debouncer");

  const result = createChannelInboundDebouncer<DebouncerItem>({
    cfg: config,
    channel: "yuanbao",

    buildKey: (item) => buildSessionKey(item),

    shouldDebounce: (item) => {
      const minCtx = buildMinCtx(item, debouncerLog);
      const { rawBody } = extractTextFromMsgBody(minCtx, item.msg.msg_body);
      return shouldDebounceTextInbound({
        text: rawBody,
        cfg: item.config,
        hasMedia: Boolean(
          item.msg.msg_body?.some((elem: { msg_type?: string }) =>
            MEDIA_MSG_TYPES.has(elem.msg_type ?? ""),
          ),
        ),
      });
    },

    onFlush: async (items) => {
      const primary = items.at(-1);
      if (!primary) {
        return;
      }

      const sessionKey = buildSessionKey(primary);

      // ⭐ 私聊普通消息：打断旧推理 + 使排队中的旧任务失效
      if (isDirectNormalMessage(primary)) {
        const baseKey = buildBaseSessionKey(primary);
        // 使 base 队列中排队的旧任务失效（跳过执行）
        sessionQueue.invalidate(baseKey);
        // 轮换 AbortController：abort 旧推理，获取新 signal
        const sessionSignal = sessionAbortManager.rotate(baseKey);
        // 将会话级 signal 挂载到 primary 上，供 buildPipelineContext 组合使用
        (primary as DebouncerItem & { _sessionAbortSignal?: AbortSignal })._sessionAbortSignal =
          sessionSignal;
      }

      if (items.length === 1) {
        await sessionQueue.enqueue(sessionKey, async () => {
          const pipelineCtx = buildPipelineContext(primary, items);
          try {
            await pipeline.execute(pipelineCtx);
          } finally {
            cleanupSessionSignal(primary);
          }
        });
        return;
      }

      // 多条消息合并文本 + Media，空内容则跳过
      const combinedText = items
        .map((item) => extractRawText(item))
        .filter(Boolean)
        .join("\n");
      const combinedMedia = items.flatMap((item) =>
        (item.msg.msg_body ?? []).filter((elem: { msg_type?: string }) =>
          MEDIA_MSG_TYPES.has(elem.msg_type ?? ""),
        ),
      );
      if (!combinedText.trim() && combinedMedia.length === 0) {
        debouncerLog.info("flush skipped: no text or media after merge", {
          count: items.length,
        });
        return;
      }

      // 构建合成消息：将多条 items 的 msg_body 合并到 primary 上
      const syntheticPrimary: DebouncerItem = {
        ...primary,
        msg: buildSyntheticMessage(primary, items),
      };

      await sessionQueue.enqueue(sessionKey, async () => {
        const pipelineCtx = buildPipelineContext(syntheticPrimary, items);
        try {
          await pipeline.execute(pipelineCtx);
        } finally {
          cleanupSessionSignal(primary);
        }
      });
    },

    // 参照 telegram：onError 接收 items 参数，记录更丰富的上下文信息
    onError: (err, items) => {
      const primary = items.at(-1);
      const sessionKey = primary ? buildSessionKey(primary) : "unknown";
      debouncerLog.error("debouncer flush error", {
        error: String(err),
        sessionKey,
        itemCount: items.length,
      });
    },
  });

  debouncer = result.debouncer;
  return debouncer;
}
