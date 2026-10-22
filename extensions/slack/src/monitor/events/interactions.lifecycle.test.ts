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

function eventOptions() {
  const options = enqueueSessionEventMock.mock.calls[0]?.[1];
  if (!options) {
    throw new Error("Expected session event options");
  }
  return options;
}

describe("Slack interaction lifecycle", () => {
  it.each(["accepted", "refused", "duplicate"] as const)(
    "keeps the captured destination through plugin dispatch and confirms only when %s",
    async (admission) => {
      const dispatchStarted = createDeferred<void>();
      const dispatch = createDeferred<DispatchPluginInteractiveHandlerResult>();
      const accepted =
        createDeferred<
          Awaited<ReturnType<PluginRuntime["system"]["enqueueSessionEvent"]>["accepted"]>
        >();
      const settled =
        createDeferred<
          Awaited<ReturnType<PluginRuntime["system"]["enqueueSessionEvent"]>["settled"]>
        >();
      const enqueued = createDeferred<void>();
      dispatchPluginInteractiveHandlerMock.mockImplementationOnce(() => {
        dispatchStarted.resolve();
        return dispatch.promise;
      });
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
      const handling = getHandler()({
        ack,
        respond,
        body: actionBody({ text: "Choose", blocks: singleButtonBlocks("choice", "pick") }),
        action: button("pick", "choice", "yes", "Yes"),
      });
      await dispatchStarted.promise;
      const expectedTarget = await captureSessionEventTargetMock.mock.results[0]?.value;
      expect(captureSessionEventTargetMock).toHaveBeenCalledOnce();
      resolveSessionKey.mockResolvedValue({ agentId: "other", sessionKey: "session:replacement" });
      dispatch.resolve({ matched: false, handled: false, duplicate: false });
      await enqueued.promise;
      expect(eventOptions()).toMatchObject({
        agentId: "ops",
        sessionKey: "agent:ops:slack:channel:C1",
      });
      expect(eventOptions().expectedTarget).toBe(expectedTarget);
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
    const started = createDeferred<void>();
    const dispatch = createDeferred<DispatchPluginInteractiveHandlerResult>();
    dispatchPluginInteractiveHandlerMock.mockImplementationOnce(() => {
      started.resolve();
      return dispatch.promise;
    });
    const { ctx, app, getHandler } = setupInteractions();
    const handling = getHandler()({
      ack,
      body: actionBody({ text: "Choose", blocks: singleButtonBlocks("choice", "pick") }),
      action: button("pick", "choice", "yes", "Yes"),
    });
    await started.promise;
    Object.assign(ctx, { isRuntimePolicyCurrent: () => false });
    dispatch.resolve({ matched: false, handled: false, duplicate: false });
    await handling;
    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
    expect(app.client.chat.update).not.toHaveBeenCalled();
  });
});
