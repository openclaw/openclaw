import path from "node:path";
import {
  runChannelInboundEvent,
  type ChannelInboundEventRunnerParams,
} from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { FinalizedMsgContext, GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import type { MatrixMonitorHandlerParams } from "./handler-types.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixReplayClaim,
  createMatrixTextMessageEvent,
  matrixDispatchResult,
} from "./handler.test-helpers.js";
import type { MatrixRawEvent } from "./types.js";

type MatrixInboundRun = MatrixMonitorHandlerParams["core"]["channel"]["inbound"]["run"];
type MatrixInboundRunParams = Parameters<MatrixInboundRun>[0];
type TurnAdoptionLifecycle = NonNullable<GetReplyOptions["turnAdoptionLifecycle"]>;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => installMatrixMonitorTestRuntime());

it("routes /steer to queue policy beside an active Matrix turn", async ({ signal }) => {
  const followupBody = "/steer use the monochrome version instead";
  const activeEventId = "$active-explicit-steer";
  const followupEventId = "$explicit-steer";
  const activeResolverStarted = createDeferred<void>();
  const releaseActiveResolver = createDeferred<void>();
  const followupResolverAdopted = createDeferred<void>();
  const followupClaim = createMatrixReplayClaim(followupEventId);
  let inboundLifecycle: TurnAdoptionLifecycle | undefined;
  let followupResolverLifecycle: TurnAdoptionLifecycle | undefined;
  let commandBody: string | undefined;

  const inboundDeduper: NonNullable<MatrixMonitorHandlerParams["inboundDeduper"]> = {
    claim: vi.fn(async ({ eventId }) => ({
      kind: "claimed" as const,
      handle: eventId === followupEventId ? followupClaim : createMatrixReplayClaim(eventId),
    })),
  };
  const queuePolicyResolver = vi.fn(async (ctx: FinalizedMsgContext, options?: GetReplyOptions) => {
    const eventId = ctx.MessageSid;
    if (eventId === activeEventId) {
      await options?.turnAdoptionLifecycle?.onAdopted();
      activeResolverStarted.resolve();
      await releaseActiveResolver.promise;
    }
    if (eventId === followupEventId) {
      commandBody = ctx.CommandBody;
      followupResolverLifecycle = options?.turnAdoptionLifecycle;
      if (!followupResolverLifecycle?.onDeferred) {
        throw new Error("expected Matrix follow-up deferral ownership");
      }
      expect(followupResolverLifecycle.onDeferred()).not.toBe(false);
      await followupResolverLifecycle.onAdopted();
      followupResolverAdopted.resolve();
    }
  });
  const runWithQueuePolicyResolver = (async (params: MatrixInboundRunParams) => {
    const eventId = (params.raw as MatrixRawEvent).event_id;
    if (eventId === followupEventId) {
      inboundLifecycle = params.turnAdoptionLifecycle;
    }
    const adapter = params.adapter;
    return await runChannelInboundEvent({
      ...params,
      adapter: {
        ...adapter,
        resolveTurn: async (...args: Parameters<typeof adapter.resolveTurn>) => {
          const turn = await adapter.resolveTurn(...args);
          if (!("route" in turn) || "runDispatch" in turn) {
            throw new Error("expected Matrix to resolve a routed channel turn");
          }
          return { ...turn, replyResolver: queuePolicyResolver as never };
        },
      },
    } as ChannelInboundEventRunnerParams<MatrixRawEvent>);
  }) as MatrixInboundRun;
  const runtime = { error: vi.fn() };
  const { handler } = createMatrixHandlerTestHarness({
    cfg: {
      session: { store: path.join(tempDirs.make("openclaw-matrix-steer-"), "sessions.json") },
      messages: { queue: { mode: "steer" } },
      channels: { matrix: { dm: { allowFrom: ["*"] } } },
    } satisfies OpenClawConfig,
    inboundDeduper,
    runtime: runtime as never,
    shouldHandleTextCommands: () => true,
    hasControlCommand: (text?: string) => text?.startsWith("/steer") === true,
    runChannelInboundEvent: runWithQueuePolicyResolver,
  });

  const turns: Promise<void>[] = [];
  const send = (eventId: string, body: string) => {
    const turn = handler("!room:example.org", createMatrixTextMessageEvent({ eventId, body }));
    turns.push(turn);
    return turn;
  };
  async function expectAdmission(turn: Promise<void>, admission: Promise<void>, calls: number) {
    expect(await Promise.race([admission.then(() => true), turn.then(() => false)])).toBe(true);
    expect(runtime.error).not.toHaveBeenCalled();
    expect(queuePolicyResolver).toHaveBeenCalledTimes(calls);
  }
  const releaseActiveTurn = () => releaseActiveResolver.resolve();
  signal.addEventListener("abort", releaseActiveTurn, { once: true });
  try {
    await expectAdmission(
      send(activeEventId, "keep this run active"),
      activeResolverStarted.promise,
      1,
    );
    await expectAdmission(send(followupEventId, followupBody), followupResolverAdopted.promise, 2);

    expect(commandBody).toBe(followupBody);
    expect(inboundLifecycle).toMatchObject({ admission: "exclusive" });
    expect(followupResolverLifecycle).toMatchObject({ admission: "exclusive" });
    expect(followupClaim.commit).toHaveBeenCalledOnce();
    expect(followupClaim.release).not.toHaveBeenCalled();
  } finally {
    signal.removeEventListener("abort", releaseActiveTurn);
    releaseActiveTurn();
    await Promise.allSettled(turns);
  }
});

it("keeps a deferred replay claim past handler return until abandonment releases it", async () => {
  const eventId = "$abandoned-followup";
  const claim = createMatrixReplayClaim(eventId);
  let deferredLifecycle: TurnAdoptionLifecycle | undefined;
  const runWithDeferredOwnership = (async (params: MatrixInboundRunParams) => {
    deferredLifecycle = params.turnAdoptionLifecycle;
    expect(deferredLifecycle?.onDeferred?.()).not.toBe(false);
    return {
      admission: { kind: "dispatch" as const },
      dispatched: true as const,
      ctxPayload: {} as FinalizedMsgContext,
      routeSessionKey: "agent:ops:main",
      dispatchResult: matrixDispatchResult(),
    };
  }) as MatrixInboundRun;
  const { handler } = createMatrixHandlerTestHarness({
    inboundDeduper: { claim: vi.fn(async () => ({ kind: "claimed" as const, handle: claim })) },
    runChannelInboundEvent: runWithDeferredOwnership,
  });

  await handler(
    "!room:example.org",
    createMatrixTextMessageEvent({ eventId, body: "wait for the active turn" }),
  );

  expect(deferredLifecycle).toMatchObject({ admission: "exclusive" });
  expect(claim.commit).not.toHaveBeenCalled();
  expect(claim.release).not.toHaveBeenCalled();

  await deferredLifecycle?.onAbandoned?.();

  expect(claim.commit).not.toHaveBeenCalled();
  expect(claim.release).toHaveBeenCalledOnce();
});
