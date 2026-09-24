import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeAbsence,
  completeAction,
  createRuntime,
  createTalkDriver,
  incomingCall,
  mocks,
  pendingDialCancellationResult,
  pendingDialState,
  resetRuntimeTestState,
} from "./runtime.test-support.js";

describe("FaceTime runtime carrier aliases", () => {
  beforeEach(resetRuntimeTestState);

  it("falls back to a retained carrier alias when the current helper owner disappears", async () => {
    const talk = createTalkDriver({});
    mocks.startTalk.mockResolvedValueOnce(talk);
    mocks.helper.safetyMute.mockImplementation(async (callUUID: string) =>
      callUUID === "call-1"
        ? completeAbsence()
        : completeAction({
            outcome: "safe-muted",
            downlink_muted: true,
            muted: true,
            is_uplink_muted: true,
          }),
    );
    mocks.helper.leaveCall.mockImplementation(async (callUUID: string) =>
      callUUID === "replacement-call"
        ? completeAction({ outcome: "termination-requested" })
        : completeAbsence(),
    );
    const runtime = await createRuntime();
    const incoming = incomingCall(1);
    const active = {
      ...incoming,
      data: { ...incoming.data, conversation_uuid: "shared-conversation" },
    };

    void mocks.helperParams?.onMessage(active);
    await vi.waitFor(() => expect(talk.activate).toHaveBeenCalledOnce());
    void mocks.helperParams?.onMessage({
      ...active,
      data: { ...active.data, call_uuid: "replacement-call" },
    });
    await vi.waitFor(() => expect(talk.activate).toHaveBeenCalledTimes(2));
    void mocks.helperParams?.onMessage(active);
    await vi.waitFor(() => expect(talk.activate).toHaveBeenCalledTimes(3));

    await expect(runtime.hangup()).resolves.toEqual({ callUUID: "call-1" });

    expect(mocks.helper.safetyMute.mock.calls.map(([callUUID]) => callUUID)).toEqual([
      "call-1",
      "replacement-call",
    ]);
    expect(mocks.helper.leaveCall).toHaveBeenCalledWith("replacement-call");
    expect((await runtime.status()).calls).toEqual([]);
    await runtime.stop();
  });

  it("ignores an ended event for a stale carrier alias", async () => {
    const talk = createTalkDriver({});
    mocks.startTalk.mockResolvedValueOnce(talk);
    const runtime = await createRuntime();
    const incoming = incomingCall(1);
    const active = {
      ...incoming,
      data: { ...incoming.data, conversation_uuid: "shared-conversation" },
    };

    void mocks.helperParams?.onMessage(active);
    await vi.waitFor(() => expect(talk.activate).toHaveBeenCalledOnce());
    const replacement = {
      ...active,
      data: { ...active.data, call_uuid: "replacement-call" },
    };
    void mocks.helperParams?.onMessage(replacement);
    await vi.waitFor(() => expect(talk.activate).toHaveBeenCalledTimes(2));

    void mocks.helperParams?.onMessage({
      ...active,
      data: { ...active.data, call_status: 6, has_ended: true },
    });

    expect((await runtime.status()).calls).toHaveLength(1);
    expect(talk.close).not.toHaveBeenCalled();

    void mocks.helperParams?.onMessage({
      ...replacement,
      data: { ...replacement.data, call_status: 6, has_ended: true },
    });
    await vi.waitFor(async () => expect((await runtime.status()).calls).toEqual([]));
    expect(talk.close).toHaveBeenCalledWith("native-ended");
    await runtime.stop();
  });
  it("keeps the latest pending carrier after a cancellation reply without identity", async () => {
    const state = await pendingDialState({ callUUID: "original-call" });
    let resolveReply!: (result: ReturnType<typeof pendingDialCancellationResult>) => void;
    const reply = new Promise<ReturnType<typeof pendingDialCancellationResult>>((resolve) => {
      resolveReply = resolve;
    });
    mocks.helper.cancelOutgoingCall.mockResolvedValue(pendingDialCancellationResult());
    mocks.helper.cancelOutgoingCall.mockImplementationOnce(() => reply);
    const runtime = await createRuntime(state);
    const cancellation = runtime.hangup();
    try {
      await vi.waitFor(() => expect(mocks.helper.cancelOutgoingCall).toHaveBeenCalledOnce());
      await mocks.helperParams?.onMessage(
        {
          event: "ft-outbound-call-identified",
          data: { dial_id: "approved-dial", call_uuid: "replacement-call" },
        },
        {
          bundleIdentifier: "com.apple.FaceTime",
          processId: 4321,
          processStartedAtMs: Date.parse("Tue Nov 14 22:13:20 2023"),
          connectionGeneration: 1,
        },
      );
      resolveReply(pendingDialCancellationResult());
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
      resolveReply(pendingDialCancellationResult());
      await cancellation;
      await mocks.helperParams?.onMessage({
        event: "ft-call-status-changed",
        data: {
          dial_id: "approved-dial",
          call_uuid: "replacement-call",
          call_status: 6,
          has_ended: true,
          is_outgoing: true,
        },
      });
      await runtime.stop();
    }
  });
});
