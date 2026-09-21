import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  completeAbsence,
  completeAction,
  createRuntime,
  createTalkDriver,
  incomingCall,
  mocks,
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
});
