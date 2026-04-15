/**
 * 中间件单测共享 mock 工厂
 *
 * 提供可定制的 PipelineContext mock 和 next 追踪器。
 */

import type { PipelineContext } from "../types.js";

type DeepPartial<T> = { [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P] };

/**
 * 创建 mock PipelineContext，支持部分覆盖
 */
export function createMockCtx(overrides: DeepPartial<PipelineContext> = {}): PipelineContext {
  const base: Record<string, unknown> = {
    raw: { msg_body: [], from_account: "user-001", msg_id: "msg-001", msg_seq: 1 },
    flushedItems: [],
    isGroup: false,
    chatType: "c2c",
    account: {
      botId: "bot-001",
      accountId: "bot-001",
      requireMention: true,
      historyLimit: 10,
      config: { dm: { policy: "open", allowFrom: [] } },
      disableBlockStreaming: false,
    },
    config: { commands: { useAccessGroups: true } },
    core: {
      channel: {
        commands: { shouldHandleTextCommands: () => true },
        text: {
          hasControlCommand: () => false,
          convertMarkdownTables: (t: string) => t,
          chunkMarkdownText: (t: string, _max: number) => [t],
        },
        session: { recordInboundSession: async () => {} },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async () => {},
          formatAgentEnvelope: (opts: Record<string, unknown>) =>
            typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body ?? ""),
          finalizeInboundContext: (opts: Record<string, unknown>) => opts,
        },
        routing: {
          resolveAgentRoute: () => ({
            agentId: "agent-001",
            sessionKey: "session-001",
            accountId: "bot-001",
          }),
        },
      },
    },
    wsClient: {},
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      verbose: () => {},
    },
    fromAccount: "user-001",
    senderNickname: undefined,
    groupCode: undefined,
    rawBody: "",
    medias: [],
    isAtBot: false,
    mentions: [],
    effectiveWasMentioned: false,
    commandAuthorized: false,
    rewrittenBody: "",
    hasControlCommand: false,
    mediaPaths: [],
    mediaTypes: [],
    quoteInfo: undefined,
    route: undefined,
    storePath: undefined,
    envelopeOptions: undefined,
    previousTimestamp: undefined,
    ctxPayload: undefined,
    sender: undefined,
    queueSession: undefined,
    action: undefined,
  };

  // 浅合并 overrides（支持嵌套对象的一层覆盖）
  const merged = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (
      value !== undefined &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      base[key] &&
      typeof base[key] === "object" &&
      !Array.isArray(base[key])
    ) {
      merged[key] = {
        ...(base[key] as Record<string, unknown>),
        ...(value as Record<string, unknown>),
      };
    } else {
      merged[key] = value;
    }
  }

  return merged as unknown as PipelineContext;
}

/** 创建一个可追踪的 next 函数 */
export function createMockNext() {
  let called = false;
  const next = async () => {
    called = true;
  };
  return { next, wasCalled: () => called };
}

/** 创建一个可追踪调用参数的 spy 函数 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- spy 需要泛型约束
export function createSpy<T extends (...args: any[]) => any>(impl?: T) {
  const calls: Parameters<T>[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spy 需要泛型约束
  const spy = ((...args: any[]) => {
    calls.push(args as Parameters<T>);
    return impl?.(...args);
  }) as T;
  return { spy, calls, callCount: () => calls.length };
}
