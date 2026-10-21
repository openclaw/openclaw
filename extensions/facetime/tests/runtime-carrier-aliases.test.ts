import { beforeEach, expect, it, vi } from "vitest";
import {
  completeAbsence,
  completeAction,
  carrierPeer,
  createRuntime,
  createTalkDriver,
  endedCall,
  incomingCall,
  mocks,
  pendingDialCancellationResult,
  pendingDialState,
  resetRuntimeTestState,
} from "./runtime.test-support.js";

async function activateCarrierAliases() {
  const talk = createTalkDriver({});
  mocks.startTalk.mockResolvedValueOnce(talk);
  const runtime = await createRuntime();
  const send = (call_uuid = "call-1", call_status = 1) =>
    mocks.helperParams?.onMessage(
      incomingCall(call_status, { call_uuid, conversation_uuid: "shared-conversation" }),
    );
  await send();
  expect(talk.activate).toHaveBeenCalledOnce();
  await send("replacement-call");
  expect(talk.activate).toHaveBeenCalledTimes(2);
  return { talk, runtime, send };
}

beforeEach(resetRuntimeTestState);

it("falls back to a retained carrier alias when the current helper owner disappears", async () => {
  const safetyMute = mocks.helper.safetyMute.getMockImplementation()!;
  mocks.helper.safetyMute.mockImplementation(async (callUUID: string) =>
    callUUID === "call-1" ? completeAbsence() : await safetyMute(callUUID),
  );
  mocks.helper.leaveCall.mockImplementation(async (callUUID: string) =>
    callUUID === "replacement-call"
      ? completeAction({ outcome: "termination-requested" })
      : completeAbsence(),
  );
  const { talk, runtime, send } = await activateCarrierAliases();
  await send();
  expect(talk.activate).toHaveBeenCalledTimes(3);
  await expect(runtime.hangup()).resolves.toEqual({ callUUID: "call-1" });

  expect(mocks.helper.safetyMute.mock.calls).toEqual([["call-1"], ["replacement-call"]]);
  expect(mocks.helper.leaveCall).toHaveBeenCalledWith("replacement-call");
  expect((await runtime.status()).calls).toEqual([]);
  await runtime.stop();
});

it("ignores an ended event for a stale carrier alias", async () => {
  const { talk, runtime, send } = await activateCarrierAliases();

  await send("call-1", 6);

  expect((await runtime.status()).calls).toHaveLength(1);
  expect(talk.close).not.toHaveBeenCalled();

  await send("replacement-call", 6);
  expect((await runtime.status()).calls).toEqual([]);
  expect(talk.close).toHaveBeenCalledWith("native-ended");
  await runtime.stop();
});
it("keeps the latest pending carrier after a cancellation reply without identity", async () => {
  const state = await pendingDialState({ callUUID: "original-call" });
  const reply = Promise.withResolvers<ReturnType<typeof pendingDialCancellationResult>>();
  mocks.helper.cancelOutgoingCall.mockResolvedValue(pendingDialCancellationResult());
  mocks.helper.cancelOutgoingCall.mockImplementationOnce(() => reply.promise);
  const runtime = await createRuntime(state);
  const cancellation = runtime.hangup();
  try {
    await vi.waitFor(() => expect(mocks.helper.cancelOutgoingCall).toHaveBeenCalledOnce());
    await mocks.helperParams?.onMessage(
      {
        event: "ft-outbound-call-identified",
        data: { dial_id: "approved-dial", call_uuid: "replacement-call" },
      },
      { ...carrierPeer, connectionGeneration: 1 },
    );
    reply.resolve(pendingDialCancellationResult());
    await cancellation;
    expect(await state.lookup("active")).toMatchObject({
      delivery: "cancelling",
      callUUID: "replacement-call",
      callUUIDAliases: ["original-call", "replacement-call"],
    });
    await runtime.hangup();
    expect(mocks.helper.cancelOutgoingCall).toHaveBeenLastCalledWith(
      expect.objectContaining({ dialID: "approved-dial", callUUID: "replacement-call" }),
    );
    expect(mocks.startTalk).not.toHaveBeenCalled();
  } finally {
    reply.resolve(pendingDialCancellationResult());
    await cancellation;
    await mocks.helperParams?.onMessage(
      endedCall("replacement-call", { dial_id: "approved-dial" }),
    );
    await runtime.stop();
  }
});
