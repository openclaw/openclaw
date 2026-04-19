/**
 * Shared mock factory for middleware unit tests.
 *
 * Provides customizable PipelineContext mock and next tracker.
 */

import type { PipelineContext } from "../types.js";

type DeepPartial<T> = { [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P] };

/**
 * Create mock PipelineContext with partial overrides.
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
    linkUrls: [],
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

  // Shallow merge overrides (supports one-level nested object override)
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

/** Create a trackable next function */
export function createMockNext() {
  let called = false;
  const next = async () => {
    called = true;
  };
  return { next, wasCalled: () => called };
}

/** Create a spy function that tracks call arguments */
export function createSpy<T extends (...args: never[]) => unknown>(impl?: T) {
  const calls: Parameters<T>[] = [];
  const spy = ((...args: unknown[]) => {
    calls.push(args as Parameters<T>);
    return impl?.(...(args as Parameters<T>));
  }) as unknown as T;
  return { spy, calls, callCount: () => calls.length };
}
