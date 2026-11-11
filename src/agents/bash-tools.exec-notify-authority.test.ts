import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { dispatchInboundMessageWithRoutedChannelDispatcher } from "../auto-reply/dispatch.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { resetSystemEventsForTest } from "../infra/system-events.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import * as gatewayWork from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { startDeferredNotifyRun } from "./bash-tools.notify-on-exit-ack.test-support.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

const spawn = vi.hoisted(() => vi.fn());
const dispatch = vi.hoisted(() =>
  vi.fn<typeof dispatchInboundMessageWithRoutedChannelDispatcher>(),
);
// mock-isolation: Keep real exec settlement and event custody; stop at the model dispatch boundary.
vi.mock("../process/supervisor/index.js", () => ({ getProcessSupervisor: () => ({ spawn }) }));
vi.mock("../auto-reply/dispatch.js", () => ({
  dispatchInboundMessageWithRoutedChannelDispatcher: dispatch,
}));

const sessionKey = "agent:main:dashboard:exec-notify-authority";
let state: OpenClawTestState;
const receipts: sessionEvents.SessionEventReceipt[] = [];
const enqueue = sessionEvents.enqueueSessionEventForHost;
const continuation = vi.spyOn(gatewayWork, "runWithGatewayDetachedWorkContinuation");

beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only", prefix: "exec-authority-" });
  setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
  openOpenClawStateDatabase({ env: state.env });
  writeSessionEntry(openOpenClawAgentDatabase({ agentId: "main", env: state.env }), sessionKey, {
    sessionId: "original-session",
    lifecycleRevision: "original-revision",
    updatedAt: Date.now(),
  });
  vi.spyOn(sessionEvents, "enqueueSessionEventForHost").mockImplementation((text, options) => {
    const receipt = enqueue(text, options);
    receipts.push(receipt);
    return receipt;
  });
});

afterEach(async () => {
  for (const receipt of receipts.splice(0)) {
    receipt.cancel();
    await receipt.settled;
  }
  resetProcessRegistryForTests();
  resetSystemEventsForTest();
  await Promise.allSettled(
    continuation.mock.results.flatMap((result) => (result.type === "return" ? [result.value] : [])),
  );
  expect(gatewayWork.getActiveGatewayRootWorkCount()).toBe(0);
  vi.restoreAllMocks();
  spawn.mockReset();
  dispatch.mockReset();
  clearRuntimeConfigSnapshot();
  await state.cleanup();
});

it.each(["settled", "revoked"] as const)(
  "transfers original operator custody beyond the producing turn and process: %s",
  async (outcome) => {
    let holders = 1;
    let requestCurrent = true;
    const revoked = new AbortController();
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "original-operator",
      scopes: ["operator.write"],
      signal: revoked.signal,
      assertCurrent: () => {
        revoked.signal.throwIfAborted();
        if (holders === 0) {
          throw new Error("original operator custody expired");
        }
      },
      retain: () => {
        holders += 1;
        return () => {
          holders -= 1;
        };
      },
    });
    const reached = createDeferredCore();
    dispatch.mockImplementation(async ({ replyOptions }) => {
      const lifecycle = expectDefined(replyOptions?.turnAdoptionLifecycle, "event lifecycle");
      lifecycle.onDeferred?.();
      const signal = expectDefined(lifecycle.abortSignal, "event cancellation");
      signal.addEventListener(
        "abort",
        () => {
          lifecycle.onAbandoned?.();
          lifecycle.onSettled?.();
        },
        { once: true },
      );
      reached.resolve();
      return {
        deferredToActiveRun: "followup",
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      };
    });
    const process = await withPluginRuntimeGatewayRequestScope(
      { isWebchatConnect: () => true, hasCurrentClientAuthority: () => requestCurrent },
      () =>
        withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey,
            operatorAuthority: authority,
            receiptAuthority: () => requestCurrent,
          },
          () => startDeferredNotifyRun({ spawn, sessionKey }),
        ),
    );
    expect(holders).toBe(2);
    requestCurrent = false;
    holders -= 1;
    await process.finish();
    await reached.promise;
    const receipt = expectDefined(receipts[0], "real completion receipt");
    await expect(receipt.accepted).resolves.toEqual({ ok: true });
    const args = expectDefined(dispatch.mock.calls[0]?.[0], "completion dispatch");
    expect(args.replyOptions?.operatorAuthority).toBe(authority);
    expect(args.replyOptions?.operatorAuthority?.scopes).toEqual(["operator.write"]);
    expect(args.ctx.SessionKey).toBe(sessionKey);
    expect(args.replyOptions?.expectedExistingSessionId).toBe("original-session");
    expect(holders).toBe(1);
    expect(() => authority.assertCurrent()).not.toThrow();
    expect(dispatch).toHaveBeenCalledOnce();
    if (outcome === "revoked") {
      revoked.abort(new Error("operator access revoked"));
      await expect(receipt.settled).resolves.toMatchObject({
        status: "cancelled",
        executionStarted: false,
      });
      expect(args.replyOptions?.turnAdoptionLifecycle?.abortSignal?.aborted).toBe(true);
    } else {
      args.replyOptions?.turnAdoptionLifecycle?.onSettled?.();
      await receipt.settled;
    }
    expect(holders).toBe(0);
  },
);
