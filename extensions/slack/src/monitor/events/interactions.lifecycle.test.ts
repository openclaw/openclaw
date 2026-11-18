import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it } from "vitest";
import {
  getSlackInteractionMocks,
  setupInteractions,
  type DispatchPluginInteractiveHandlerResult,
} from "./interactions.test-runtime.js";
import { actionBody, button, singleButtonBlocks } from "./interactions.test-support.js";

const {
  ack,
  captureSessionEventTargetMock,
  dispatchPluginInteractiveHandlerMock,
  enqueueSessionEventMock,
  respond,
} = getSlackInteractionMocks();

type SessionEvent = ReturnType<PluginRuntime["system"]["enqueueSessionEvent"]>;
const interaction = () => ({
  ack,
  body: actionBody({ text: "Choose", blocks: singleButtonBlocks("choice", "pick") }),
  action: button("pick", "choice", "yes", "Yes"),
});

function pauseDispatch() {
  const started = createDeferred<void>();
  const dispatch = createDeferred<DispatchPluginInteractiveHandlerResult>();
  dispatchPluginInteractiveHandlerMock.mockImplementationOnce(() => {
    started.resolve();
    return dispatch.promise;
  });
  return { started, dispatch };
}

describe("Slack interaction lifecycle", () => {
  it.each(["accepted", "refused", "duplicate"] as const)(
    "keeps the captured destination through plugin dispatch and confirms only when %s",
    async (admission) => {
      const { started, dispatch } = pauseDispatch();
      const accepted = createDeferred<Awaited<SessionEvent["accepted"]>>();
      const settled = createDeferred<Awaited<SessionEvent["settled"]>>();
      const enqueued = createDeferred<void>();
      enqueueSessionEventMock.mockImplementationOnce(() => {
        enqueued.resolve();
        if (admission === "duplicate") {
          throw new Error(
            "Session event was not enqueued: an identical occurrence is already pending",
          );
        }
        return {
          id: "interaction",
          cancel: () => false,
          accepted: accepted.promise,
          settled: settled.promise,
        };
      });
      const { app, getHandler, resolveSessionKey, runtimeLog } = setupInteractions();
      const handling = getHandler()({ ...interaction(), respond });
      await started.promise;
      const expectedTarget = await captureSessionEventTargetMock.mock.results[0]?.value;
      expect(captureSessionEventTargetMock).toHaveBeenCalledOnce();
      resolveSessionKey.mockResolvedValue({ agentId: "other", sessionKey: "session:replacement" });
      dispatch.resolve({ matched: false, handled: false, duplicate: false });
      await enqueued.promise;
      const options = enqueueSessionEventMock.mock.calls[0]?.[1];
      expect(options).toMatchObject({
        agentId: "ops",
        sessionKey: "agent:ops:slack:channel:C1",
      });
      expect(options?.expectedTarget).toBe(expectedTarget);
      expect(app.client.chat.update).not.toHaveBeenCalled();
      accepted.resolve(
        admission === "accepted" ? { ok: true } : { ok: false, error: "session replaced" },
      );
      await handling;
      expect(app.client.chat.update).toHaveBeenCalledTimes(admission === "accepted" ? 1 : 0);
      settled.resolve({
        status: "failed",
        executionStarted: false,
        delivered: false,
        error: "session replaced",
      });
      await settled.promise;
      await Promise.resolve();
      expect(runtimeLog).toHaveBeenCalledWith(
        expect.stringContaining(
          admission === "accepted" ? "follow-up failed" : "follow-up refused",
        ),
      );
    },
  );

  it("drops an interaction when its policy retires during plugin dispatch", async () => {
    const { started, dispatch } = pauseDispatch();
    const { ctx, app, getHandler } = setupInteractions();
    const handling = getHandler()(interaction());
    await started.promise;
    Object.assign(ctx, { isRuntimePolicyCurrent: () => false });
    dispatch.resolve({ matched: false, handled: false, duplicate: false });
    await handling;
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
    expect(app.client.chat.update).not.toHaveBeenCalled();
  });
});
