import { beforeEach, describe, expect, it } from "vitest";
import {
  createRuntime,
  createTalkDriver,
  incomingCall,
  mocks,
  pendingDialState,
  resetRuntimeTestState,
} from "./runtime.test-support.js";

const verifiedTransport = incomingCall().data.transport;
const deniedCallData = [
  { name: "unlisted caller", data: { handle: { value: "unlisted@example.com" } } },
  {
    name: "cellular transport",
    data: {
      transport: {
        ...verifiedTransport,
        kind: "cellular",
        service: 1,
        provider_is_facetime: false,
        provider_is_telephony: true,
      },
    },
  },
  {
    name: "baseband transport",
    data: { transport: { ...verifiedTransport, is_using_baseband: true } },
  },
  {
    name: "Wi-Fi calling transport",
    data: { transport: { ...verifiedTransport, is_wifi_call: true } },
  },
  {
    name: "unclassified transport",
    data: { transport: { ...verifiedTransport, provider_classified: false } },
  },
  { name: "missing transport", data: { transport: undefined } },
];

describe("FaceTime runtime admission", () => {
  beforeEach(resetRuntimeTestState);

  describe.each([
    { phase: "ringing", status: 4 },
    { phase: "active", status: 1 },
  ])("$phase calls", ({ status }) => {
    it("reserves admission for the approved pending outbound call", async () => {
      const state = await pendingDialState();
      const talk = createTalkDriver({});
      const activated = new Promise<void>((resolve) => {
        talk.activate.mockImplementation(resolve);
      });
      mocks.startTalk.mockResolvedValue(talk);
      const runtime = await createRuntime(state, ["owner@example.com", "other-owner@example.com"]);
      const incoming = incomingCall(status);
      const outbound = {
        ...incomingCall(1),
        data: {
          ...incomingCall(1).data,
          call_uuid: "approved-call",
          dial_id: "approved-dial",
          is_outgoing: true,
        },
      };
      try {
        await mocks.helperParams?.onMessage({
          ...incoming,
          data: { ...incoming.data, handle: { value: "other-owner@example.com" } },
        });

        expect((await runtime.status()).calls).toEqual([]);
        expect(mocks.startTalk).not.toHaveBeenCalled();
        expect(mocks.helper.answerCall).not.toHaveBeenCalled();

        await mocks.helperParams?.onMessage(outbound);
        await activated;
        expect(mocks.startTalk).toHaveBeenCalledOnce();
        expect(mocks.startTalk).toHaveBeenCalledWith(
          expect.objectContaining({ callUUID: "approved-call", senderId: "owner@example.com" }),
        );
        expect((await runtime.status()).calls).toMatchObject([{ callUUID: "approved-call" }]);
      } finally {
        await mocks.helperParams?.onMessage(incomingCall(6));
        await mocks.helperParams?.onMessage({
          ...outbound,
          data: { ...outbound.data, call_status: 6, has_ended: true },
        });
        await runtime.stop();
      }
    });

    it.each(deniedCallData)("rejects $name before media or agent effects", async ({ data }) => {
      const talk = createTalkDriver({});
      mocks.startTalk.mockResolvedValue(talk);
      const runtime = await createRuntime();
      try {
        const helperParams = mocks.helperParams;
        if (!helperParams) {
          throw new Error("Runtime did not register its helper event handler");
        }
        const event = incomingCall(status);
        await helperParams.onMessage({ ...event, data: { ...event.data, ...data } });

        expect((await runtime.status()).calls).toEqual([]);
        expect(mocks.startTalk).not.toHaveBeenCalled();
        expect(talk.readyForAudio).not.toHaveBeenCalled();
        expect(talk.activate).not.toHaveBeenCalled();
        expect(mocks.helper.answerCall).not.toHaveBeenCalled();
        expect(mocks.helper.safetyMute).not.toHaveBeenCalled();
        expect(mocks.helper.setMuted).not.toHaveBeenCalled();
        expect(mocks.helper.startTransmission).not.toHaveBeenCalled();
      } finally {
        await runtime.stop();
      }
    });
  });
});
