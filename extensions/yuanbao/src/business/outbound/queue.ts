/**
 * 出站队列（基于 MessageSender）
 *
 * 接收 MessageSender 实例，通过 sender.send(item) / sender.sendText(text) 统一分发。
 * 支持三种策略：immediate、merge-text、mergeOnFlush。
 *
 * Design notes:
 * - QueueSession 是单次会话的队列实例，绑定一个 MessageSender
 * - push(item) 将消息推入队列
 * - flush() 发送所有剩余缓冲内容，完成后调用 onComplete 回调
 * - abort() 中止队列，丢弃未发送内容
 * - 直接使用 MessageSender 接口，解耦发送逻辑
 */

import { createLog } from "../../logger.js";
import { mdFence, mdBlock, mdAtomic } from "../utils/markdown.js";
import type { MessageSender, OutboundItem } from "./types.js";

// ============ 队列接口 ============

/** 队列会话接口 */
export interface QueueSession {
  /** 当前使用的策略 */
  readonly strategy: "immediate" | "merge-text" | "mergeOnFlush";
  /** 向队列推入一条消息 */
  push(item: OutboundItem): Promise<void>;
  /** 刷新队列，发送所有剩余缓冲内容；返回是否已发送过内容 */
  flush(): Promise<boolean>;
  /** 中止队列，丢弃所有未发送的缓冲内容 */
  abort(): void;
  /**
   * 强制将当前缓冲区内容立即发出，但不关闭 session。
   * 用于 tool_call 开始前把已积累的文本及时投递给用户，
   * 避免等待 session.flush() 才能看到 tool_call 前的内容。
   */
  drainNow(): Promise<void>;
}

/** 创建队列会话的选项 */
export interface QueueSessionOptions {
  /** 消息发送器 */
  sender: MessageSender;
  /** 发送策略 */
  strategy: "immediate" | "merge-text";
  /**
   * 开启后 push 仅缓冲，flush 时将所有文本合并为一条消息发送。
   * 与 strategy 正交，优先级高于 strategy。
   */
  mergeOnFlush?: boolean;
  /** 会话完成时的清理回调 */
  onComplete: () => void;
  /** 会话标识（用于日志） */
  sessionKey?: string;
  /** merge-text 策略：触发发送的最小字符数，Default 2800 */
  minChars?: number;
  /** merge-text 策略：单条消息的最大字符数，Default 3000 */
  maxChars?: number;
  /**
   * Markdown 感知的文本切割函数（fence-aware）。
   * 由 channel.ts 注入，使用 OpenClaw 核心的 chunkMarkdownText 实现。
   * Falls back to even character-count splitting when not provided.
   */
  chunkText?: (text: string, maxChars: number) => string[];
}

// ============ 简单均匀切割（降级实现） ============

function defaultChunkText(text: string, max: number): string[] {
  if (text.length <= max) {
    return [text];
  }
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += max) {
    chunks.push(text.slice(i, i + max));
  }
  return chunks;
}

// ============ 队列工厂 ============

/** 创建队列会话 */
export function createQueueSession(opts: QueueSessionOptions): QueueSession {
  if (opts.mergeOnFlush) {
    return createMergeOnFlushSession(opts);
  }
  switch (opts.strategy) {
    case "immediate":
      return createImmediateSession(opts);
    case "merge-text":
      return createMergeTextSession(opts);
    default:
      return createImmediateSession(opts);
  }
}

// ============ immediate 策略 ============

/**
 * immediate 策略：每条消息直接发送，不做缓冲。
 */
function createImmediateSession(opts: QueueSessionOptions): QueueSession {
  const { sender, onComplete } = opts;
  const log = createLog("outbound-queue");
  let aborted = false;
  let sendChain: Promise<void> = Promise.resolve();
  let hasSentContent = false;

  return {
    strategy: "immediate",

    push(item) {
      if (aborted) {
        return Promise.resolve();
      }

      sendChain = sendChain.then(async () => {
        if (aborted) {
          return;
        }
        const result = await sender.send(item);
        if (!result.ok) {
          log.error(`immediate send failed: ${result.error}`);
        } else {
          hasSentContent = true;
        }
      });

      return sendChain;
    },

    async flush() {
      await sendChain;
      onComplete();
      return hasSentContent;
    },

    abort() {
      aborted = true;
      onComplete();
    },

    drainNow() {
      // immediate 策略每条消息已直接发送，无缓冲区，无需额外操作
      return sendChain;
    },
  };
}

// ============ mergeOnFlush 策略 ============

/**
 * mergeOnFlush 模式：push 仅缓冲，flush 时将所有文本合并为一条消息发送。
 *
 * 用于 disableBlockStreaming=true 场景，避免多段回复分段发给用户。
 */
function createMergeOnFlushSession(opts: QueueSessionOptions): QueueSession {
  const { sender, onComplete } = opts;
  const log = createLog("outbound-queue");
  let aborted = false;
  const textBuf: string[] = [];
  const mediaBuf: OutboundItem[] = [];
  let hasSentContent = false;

  return {
    strategy: "mergeOnFlush",

    push(item) {
      if (aborted) {
        return Promise.resolve();
      }
      if (item.type === "text") {
        if (item.text.trim()) {
          textBuf.push(item.text);
        }
      } else {
        mediaBuf.push(item);
      }
      return Promise.resolve();
    },

    async flush() {
      if (aborted) {
        return hasSentContent;
      }

      // 合并所有文本为一条消息
      if (textBuf.length > 0) {
        const merged = mdFence.stripOuter(textBuf.join("")).trim();
        textBuf.length = 0;
        if (merged) {
          const result = await sender.sendText(merged);
          if (!result.ok) {
            log.error(`mergeOnFlush send merged text failed: ${result.error}`);
          } else {
            hasSentContent = true;
          }
        }
      }

      // 逐个发送Media/贴图
      for (const item of mediaBuf) {
        if (aborted) {
          break;
        }
        const result = await sender.send(item);
        if (!result.ok) {
          log.error(`mergeOnFlush send media failed: ${result.error}`);
        } else {
          hasSentContent = true;
        }
      }
      mediaBuf.length = 0;

      onComplete();
      return hasSentContent;
    },

    abort() {
      aborted = true;
      textBuf.length = 0;
      mediaBuf.length = 0;
      onComplete();
    },

    drainNow() {
      // mergeOnFlush 策略在 flush 前不发送任何内容，drainNow 为空操作
      return Promise.resolve();
    },
  };
}

// ============ merge-text 策略 ============

/**
 * merge-text 策略（Default策略）：
 * - 每次 deliver 到达时立即处理：直接拼接后用 chunkText（chunkMarkdownText）
 *   做 fence-aware 切割，超出 maxChars 的前 n-1 块立即发出，
 *   最后一块（可能处于围栏内）留在 buffer 等下一次 push 或 flush
 * - 遇到Media时先 flush 文本缓冲再发Media，保证顺序正确
 * - 积累与空闲超时由 OpenClaw streaming.blockStreamingCoalesceDefaults 统一管理，
 *   本层不再维护额外的 idleTimer
 */
function createMergeTextSession(opts: QueueSessionOptions): QueueSession {
  const { sender, onComplete, sessionKey = "" } = opts;
  const minChars = opts.minChars ?? 2800;
  const maxChars = opts.maxChars ?? 3000;
  const baseChunkText = opts.chunkText ?? defaultChunkText;
  // 在 fence-aware 切割基础上叠加原子块感知：保证表格和图表围栏块不被跨消息切割
  const chunkText = (text: string, max: number) => mdAtomic.chunkAware(text, max, baseChunkText);
  const log = createLog("outbound-queue");
  let aborted = false;
  let textBuffer = "";
  let sendChain: Promise<void> = Promise.resolve();
  let hasSentContent = false;

  /**
   * Split buffer content and send.
   *
   * - `force=true`：以 maxChars 为上限切割并发送全部内容，清空 buffer。
   * - `force=false`：以 maxChars 为上限做 fence-aware 切割；若产生多块，发送前 n-1 块，
   *   将最后一块留回 buffer；若只有 1 块且围栏未关闭则暂不发送。
   */
  async function drainBuffer(force: boolean): Promise<void> {
    if (textBuffer.length === 0) {
      return;
    }

    const chunks = chunkText(textBuffer, maxChars);
    log.debug(
      `[${sessionKey}] drainBuffer force=${force}: inputLen=${textBuffer.length}, chunks=${chunks.length}`,
    );

    if (force || chunks.length <= 1) {
      // 非强制单块：围栏未关闭时暂不发送
      if (!force && chunks.length === 1 && mdFence.hasUnclosed(chunks[0])) {
        log.debug(
          `[${sessionKey}] drainBuffer: single chunk has unclosed fence, keeping in buffer`,
        );
        return;
      }
      // 非强制单块：以表格行结尾时暂不发送
      if (!force && chunks.length === 1 && mdBlock.endsWithTableRow(chunks[0])) {
        log.debug(
          `[${sessionKey}] drainBuffer: single chunk ends with table row, keeping in buffer`,
        );
        return;
      }
      // 非强制单块：未达到 minChars 阈值时暂不发送
      if (!force && chunks.length === 1 && textBuffer.length < minChars) {
        log.debug(
          `[${sessionKey}] drainBuffer: bufLen=${textBuffer.length} < minChars=${minChars}, waiting`,
        );
        return;
      }
      textBuffer = "";
      for (const chunk of chunks) {
        if (aborted) {
          return;
        }
        if (!chunk.trim()) {
          continue;
        }
        const result = await sender.sendText(chunk);
        if (!result.ok) {
          log.error(`[${sessionKey}] send failed: ${result.error}`);
        } else {
          hasSentContent = true;
        }
      }
    } else {
      // 发送前 n-1 块（fence-safe 边界），最后一块留回 buffer
      const toSend = chunks.slice(0, -1);
      textBuffer = chunks[chunks.length - 1]!;
      log.debug(
        `[${sessionKey}] drainBuffer: sending ${toSend.length} chunk(s), remainder len=${textBuffer.length}`,
      );
      for (const chunk of toSend) {
        if (aborted) {
          return;
        }
        if (!chunk.trim()) {
          continue;
        }
        const result = await sender.sendText(chunk);
        if (!result.ok) {
          log.error(`[${sessionKey}] merge-text send failed: ${result.error}`);
        } else {
          hasSentContent = true;
        }
      }
    }
  }

  return {
    strategy: "merge-text",

    push(item) {
      if (aborted) {
        return Promise.resolve();
      }

      sendChain = sendChain.then(async () => {
        if (aborted) {
          return;
        }

        if (item.type === "text") {
          if (!item.text.trim()) {
            return;
          }
          if (textBuffer) {
            // block-streaming 的 trimEnd/trimStart 会剥除每个块边界的换行符，
            // 需要根据上下文推断补回正确的分隔符：
            //  - 块级元素开头（heading/hr/blockquote/list/fence）→ 补 \n\n
            //  - 连续表格行被切割 → 补 \n（表格行间不能有空行）
            //  - 围栏内 / 已有换行 / 纯文本续接 → 不补
            const separator = mdBlock.inferSeparator(textBuffer, item.text);
            textBuffer = mdFence.mergeBlockStreaming(
              separator ? `${textBuffer}${separator}` : textBuffer,
              item.text,
            );
          } else {
            textBuffer = item.text;
          }
          log.debug(`[${sessionKey}] merge-text push: bufLen=${textBuffer.length}`);
          hasSentContent = true;
          await drainBuffer(false);
        } else {
          // 遇到Media/贴图：先强制发出缓冲的文本，再发送
          if (textBuffer.length > 0) {
            log.debug(`[${sessionKey}] merge-text media push: flushing text buffer first`);
            await drainBuffer(true);
          }
          if (aborted) {
            return;
          }
          const result = await sender.send(item);
          if (!result.ok) {
            log.error(`[${sessionKey}] merge-text send media failed: ${result.error}`);
          } else {
            hasSentContent = true;
          }
        }
      });

      return sendChain;
    },

    async flush() {
      log.debug(`[${sessionKey}] merge-text session flush: bufLen=${textBuffer.length}`);
      await sendChain;
      if (aborted) {
        return hasSentContent;
      }
      textBuffer = mdFence.stripOuter(textBuffer);
      await drainBuffer(true);
      onComplete();
      return hasSentContent;
    },

    abort() {
      const bufLen = textBuffer.length;
      log.info(`[${sessionKey}] merge-text session aborted, discarding bufLen=${bufLen}`);
      aborted = true;
      textBuffer = "";
      onComplete();
    },

    drainNow() {
      if (aborted || !textBuffer) {
        return Promise.resolve();
      }
      // 强制将当前 textBuffer 内容立即发出，不关闭 session。
      // 挂在 sendChain 上保证与正在进行中的 push() 串行执行。
      sendChain = sendChain.then(async () => {
        if (aborted || !textBuffer) {
          return;
        }
        log.debug(
          `[${sessionKey}] drainNow: force flushing bufLen=${textBuffer.length} before tool call`,
        );
        await drainBuffer(true);
      });
      return sendChain;
    },
  };
}

/**
 * merge-text 策略会话工厂，导出仅供单元测试使用。
 * @internal
 */
export { createMergeTextSession as createMergeTextSessionForTest };
