import type { RealtimeVoiceBridgeCreateRequest } from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, vi } from "vitest";
import {
  connectCarrierStream,
  createBridge,
  createCarrierLifecycleHarness,
  makeRealtimeProvider,
} from "./realtime-handler.lifecycle.test-helpers.js";

describe("Voice Call provider-owned delegation", () => {
  it("speaks the consent-timeout goodbye before directly ending a native-delegation call", async () => {
    let request: RealtimeVoiceBridgeCreateRequest | undefined;
    const sendUserMessage = vi.fn();
    const provider = makeRealtimeProvider((params) => {
      request = params;
      return createBridge(() => {}, { sendUserMessage });
    });
    const capabilities = {
      transports: ["gateway-relay" as const],
      inputAudioFormats: [],
      outputAudioFormats: [],
      handlesAgentConsult: true,
      supportsBargeIn: false,
      handlesInputAudioBargeIn: true,
    };
    const harness = createCarrierLifecycleHarness(provider.createBridge, {
      consentWindow: { enabled: true, windowMs: 100 },
      resolveCallRegistration: () => ({
        agentId: "main",
        instructions: "Ask for consent.",
        provider,
        providerConfig: {},
        capabilities,
      }),
    });
    const { ws, server } = await connectCarrierStream(harness.handler);

    try {
      ws.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZ-native-consent", callSid: "CA-startup" },
        }),
      );
      await vi.waitFor(() => expect(request).toBeDefined());

      vi.useFakeTimers();
      request?.onTranscript?.("assistant", "Do you consent to this call being recorded?", true);
      // The consent playback mark is queued only once the provider reports the response done (after
      // the question audio), so the watchdog only arms from that signal; fire it before the window
      // is allowed to expire.
      request?.onResponseDone?.({ status: "completed", responseId: "response-1" });
      // No goodbye audio is emitted by the stubbed bridge, so the close waits out the
      // bounded 20s ceiling before ending the call.
      vi.advanceTimersByTime(31_000);
      await Promise.resolve();

      expect(sendUserMessage).toHaveBeenCalledExactlyOnceWith(
        expect.stringMatching(/Goodbye.*host will end the call/s),
      );
      expect(harness.endCall).toHaveBeenCalledExactlyOnceWith(harness.call.callId, {
        reason: "timeout",
      });
      expect(sendUserMessage.mock.invocationCallOrder[0]).toBeLessThan(
        harness.endCall.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
    } finally {
      vi.useRealTimers();
      ws.terminate();
      await harness.handler.close();
      await server.close();
    }
  });

  it.each(["complete", "abort", "close", "disabled"] as const)(
    "uses the call-owned consult handler and preserves its %s outcome",
    async (outcome) => {
      let request: RealtimeVoiceBridgeCreateRequest | undefined;
      const connect = vi.fn(async () => {});
      const submitToolResult = vi.fn();
      const provider = makeRealtimeProvider((params) => {
        request = params;
        return createBridge(() => {}, {
          connect,
          submitToolResult,
          outputAudioMode: "continuous",
          handlesInputAudioBargeIn: true,
        });
      });
      const capabilities = {
        transports: ["gateway-relay" as const],
        inputAudioFormats: [],
        outputAudioFormats: [],
        handlesAgentConsult: true,
        supportsBargeIn: false,
        handlesInputAudioBargeIn: true,
      };
      const harness = createCarrierLifecycleHarness(provider.createBridge, {
        ...(outcome === "disabled" ? { toolPolicy: "none" as const } : {}),
        resolveCallRegistration: () => ({
          agentId: "main",
          instructions: "Help the caller.",
          provider,
          providerConfig: {},
          capabilities,
        }),
      });
      let admittedSignal: AbortSignal | undefined;
      let finish = () => {};
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const effects: string[] = [];
      harness.handler.registerToolHandler(
        "openclaw_agent_consult",
        async (args, callId, context) => {
          expect(args).toEqual({ question: "Read my itinerary" });
          expect(callId).toBe(harness.call.callId);
          admittedSignal = context.abortSignal;
          await pending;
          context.abortSignal?.throwIfAborted();
          effects.push("itinerary-read");
          return { text: "The train leaves at noon." };
        },
      );
      const { ws, server } = await connectCarrierStream(harness.handler);
      const controller = new AbortController();
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-live", callSid: "CA-startup" },
          }),
        );
        await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
        if (!request?.runAgentConsult) {
          throw new Error("Native delegation was not wired to the carrier session");
        }
        expect(request.tools).toEqual([]);
        const result = request.runAgentConsult({
          prompt: "Read my itinerary",
          signal: controller.signal,
        });
        const settled = result.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        if (outcome !== "disabled") {
          await vi.waitFor(() => expect(admittedSignal).toBeDefined());
        }
        if (outcome === "abort") {
          controller.abort(new Error("Caller cancelled"));
        } else if (outcome === "close") {
          await harness.handler.close();
        }
        finish();
        if (outcome === "complete") {
          expect(await settled).toEqual({ value: { text: "The train leaves at noon." } });
          expect(effects).toEqual(["itinerary-read"]);
        } else {
          expect(await settled).toEqual({ error: expect.any(Error) });
          expect(admittedSignal?.aborted).toBe(outcome === "disabled" ? undefined : true);
          expect(effects).toEqual([]);
        }
        expect(submitToolResult).not.toHaveBeenCalled();
        await harness.handler.close();
        await expect(request.runAgentConsult({ prompt: "Late work" })).rejects.toThrow(
          /closed|active/,
        );
        expect(effects).toHaveLength(outcome === "complete" ? 1 : 0);
      } finally {
        finish();
        await harness.handler.close();
        ws.terminate();
        await server.close();
      }
    },
  );
});
