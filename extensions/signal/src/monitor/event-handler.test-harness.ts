// Signal plugin module implements event handler harness behavior.
import type {
  ChannelInboundEventRunnerParams,
  ChannelInboundTurnPlan,
  PreparedInboundReply,
  runChannelInboundEvent,
} from "openclaw/plugin-sdk/channel-inbound";
import type { SignalEventHandlerDeps, SignalReactionMessage } from "./event-handler.types.js";

export function createBaseSignalEventHandlerDeps(
  overrides: Partial<SignalEventHandlerDeps> = {},
): SignalEventHandlerDeps {
  return {
    runtime: { log: () => {}, error: () => {} } as SignalEventHandlerDeps["runtime"],
    statusReactionTiming: {
      debounceMs: 0,
      doneHoldMs: 0,
      errorHoldMs: 0,
      stallSoftMs: 60_000,
      stallHardMs: 120_000,
    },
    cfg: {},
    baseUrl: "http://localhost",
    accountId: "default",
    historyLimit: 5,
    groupHistories: new Map(),
    textLimit: 4000,
    dmPolicy: "open",
    allowFrom: ["*"],
    groupAllowFrom: ["*"],
    groupPolicy: "open",
    reactionMode: "off",
    reactionAllowlist: [],
    mediaMaxBytes: 1024,
    ignoreAttachments: true,
    sendReadReceipts: false,
    readReceiptsViaDaemon: false,
    fetchAttachment: async () => null,
    deliverReplies: async () => {},
    resolveSignalReactionTargets: () => [],
    isSignalReactionMessage: (
      _reaction: SignalReactionMessage | null | undefined,
    ): _reaction is SignalReactionMessage => false,
    shouldEmitSignalReactionNotification: () => false,
    buildSignalReactionSystemEventText: () => "reaction",
    ...overrides,
  };
}

export function createSignalReceiveEvent(envelopeOverrides: Record<string, unknown> = {}) {
  return {
    event: "receive",
    data: JSON.stringify({
      envelope: {
        sourceNumber: "+15550001111",
        sourceName: "Alice",
        timestamp: 1700000000000,
        ...envelopeOverrides,
      },
    }),
  };
}

export function createSignalPreparedDispatchRunner(
  run: typeof runChannelInboundEvent,
  recordInboundSession: PreparedInboundReply<unknown>["recordInboundSession"],
  dispatch: (plan: ChannelInboundTurnPlan) => Promise<unknown>,
) {
  return async (params: ChannelInboundEventRunnerParams<unknown, unknown>) =>
    await run({
      ...params,
      adapter: {
        ...params.adapter,
        resolveTurn: async (...args) => {
          const resolved = await params.adapter.resolveTurn(...args);
          if (!("route" in resolved) || !("delivery" in resolved)) {
            throw new Error("expected assembled Signal channel turn plan");
          }
          return {
            channel: resolved.channel,
            accountId: resolved.accountId,
            routeSessionKey: resolved.route.sessionKey,
            storePath: "/tmp/openclaw/signal-sessions.json",
            ctxPayload: resolved.ctxPayload,
            recordInboundSession,
            afterRecord: resolved.afterRecord,
            record: resolved.record,
            history: resolved.history,
            admission: resolved.admission,
            botLoopProtection: resolved.botLoopProtection,
            runDispatch: async () => await dispatch(resolved),
            runDispatchLifecycle: {
              turnAdoptionLifecycle: resolved.replyOptions?.turnAdoptionLifecycle,
              // The mock acquires no dispatcher resources; Signal's outer flush settles skips.
              onDispatchSkipped: () => {},
            },
          };
        },
      },
    });
}
