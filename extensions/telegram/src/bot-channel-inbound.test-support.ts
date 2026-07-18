import type { TelegramBotDeps } from "./bot-deps.js";

type ChannelInboundRuntime = typeof import("openclaw/plugin-sdk/channel-inbound");
type RunParams = Parameters<ChannelInboundRuntime["runChannelInboundEvent"]>[0];
type Preflight = Parameters<RunParams["adapter"]["resolveTurn"]>[2];
type TestTurn = {
  storePath: string;
  recordInboundSession: Parameters<
    ChannelInboundRuntime["runPreparedInboundReply"]
  >[0]["recordInboundSession"];
};

export function createTelegramChannelInboundTestRunner(
  actual: ChannelInboundRuntime,
  resolveDispatchReply: () => TelegramBotDeps["dispatchReplyWithBufferedBlockDispatcher"],
) {
  return async (params: RunParams) => {
    const input = await params.adapter.ingest(params.raw);
    if (!input) {
      return { admission: { kind: "drop" as const, reason: "ingest-null" }, dispatched: false };
    }
    const eventClass = (await params.adapter.classify?.(input)) ?? {
      kind: "message" as const,
      canStartAgentTurn: true,
    };
    if (!eventClass.canStartAgentTurn) {
      return {
        admission: { kind: "handled" as const, reason: `event:${eventClass.kind}` },
        dispatched: false,
      };
    }
    const preflightValue = await params.adapter.preflight?.(input, eventClass);
    const preflight = (
      preflightValue && "kind" in preflightValue
        ? { admission: preflightValue }
        : (preflightValue ?? {})
    ) as Preflight;
    const preflightAdmission = preflight.admission;
    if (
      preflightAdmission &&
      preflightAdmission.kind !== "dispatch" &&
      preflightAdmission.kind !== "observeOnly"
    ) {
      await actual.recordDroppedChannelInboundHistory({
        input,
        preflight,
        admission: preflightAdmission,
      });
      return { admission: preflightAdmission, dispatched: false };
    }
    const resolved = await params.adapter.resolveTurn(input, eventClass, preflight);
    if (!("route" in resolved) || !("delivery" in resolved)) {
      throw new Error("expected assembled Telegram channel turn plan");
    }
    const admission = resolved.admission ?? preflightAdmission ?? { kind: "dispatch" as const };
    const testTurn = (params.raw as { turn: TestTurn }).turn;
    let result;
    try {
      result = await actual.runPreparedInboundReply({
        channel: resolved.channel,
        accountId: resolved.accountId,
        routeSessionKey: resolved.route.sessionKey,
        storePath: testTurn.storePath,
        ctxPayload: resolved.ctxPayload,
        recordInboundSession: testTurn.recordInboundSession,
        afterRecord: resolved.afterRecord,
        record: resolved.record,
        history: resolved.history,
        admission,
        botLoopProtection: resolved.botLoopProtection,
        runDispatch: async () =>
          await resolveDispatchReply()({
            ctx: resolved.ctxPayload,
            cfg: resolved.cfg,
            dispatcherOptions: {
              ...resolved.dispatcherOptions,
              deliver: resolved.delivery.deliver,
              onError: resolved.delivery.onError,
            },
            toolsAllow: resolved.toolsAllow,
            replyOptions: resolved.replyOptions,
            replyResolver: resolved.replyResolver,
          }),
      });
    } catch (error) {
      try {
        await params.adapter.onFinalize?.({
          admission,
          dispatched: false,
          ctxPayload: resolved.ctxPayload,
          routeSessionKey: resolved.route.sessionKey,
        });
      } catch {
        // Match core: cleanup failures must not replace the dispatch error.
      }
      throw error;
    }
    await params.adapter.onFinalize?.(result);
    return result;
  };
}
