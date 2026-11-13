import { once } from "node:events";
import type { RealtimeVoiceBridge } from "openclaw/plugin-sdk/realtime-voice";
import { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeCall as makeCallRecord } from "./realtime-call-control.test-helpers.js";
import {
  closeCallHarnessTransports,
  makeCallHarness,
  parseWebSocketMessage,
  resetContinuity,
  waitFor,
  waitForCalls,
} from "./realtime-handler.test-helpers.js";

afterEach(async () => {
  vi.useRealTimers();
  await closeCallHarnessTransports();
});

describe("RealtimeCallHandler long initial readings", () => {
  it("paces a long reading by completed responses and carrier playback acknowledgments", async () => {
    const text = "A synthetic sentence about markets and patient investing. ".repeat(360);
    const triggerGreeting = vi.fn<NonNullable<RealtimeVoiceBridge["triggerGreeting"]>>();
    const sendAudio = vi.fn<RealtimeVoiceBridge["sendAudio"]>();
    const fixture = makeCallHarness(
      { triggerGreeting, sendAudio, outputAudioMode: "response" },
      {
        call: makeCallRecord("CA-reading", { metadata: { initialMessage: text } }),
      },
    );
    const { ws, callbacks } = await fixture.start();
    const marks: string[] = [];
    const clears: unknown[] = [];
    ws.on("message", (data) => {
      const message = parseWebSocketMessage(data);
      if (message.event === "clear") {
        clears.push(message);
      }
      if (message.event === "mark") {
        marks.push((message.mark as { name: string }).name);
      }
    });
    const sendCallerAudio = async () => {
      ws.send(
        JSON.stringify({
          event: "media",
          media: { payload: Buffer.alloc(160, 0x00).toString("base64") },
        }),
      );
      const pong = once(ws, "pong");
      ws.ping();
      await pong;
    };
    callbacks.onReady?.();
    const spoken: string[] = [];
    while (spoken.join("").length < text.length) {
      const count = spoken.length + 1;
      await waitForCalls(triggerGreeting, count);
      const prompt = triggerGreeting.mock.calls.at(-1)?.[0] ?? "";
      expect(prompt.length).toBeLessThan(2_000);
      const passage = JSON.parse(prompt.slice(prompt.lastIndexOf("Answer: ") + 8)) as string;
      expect(passage.length).toBeLessThanOrEqual(481);
      spoken.push(passage);
      await sendCallerAudio();
      expect(sendAudio).not.toHaveBeenCalled();
      callbacks.onEvent?.({ direction: "server", type: "input_audio_buffer.speech_started" });
      callbacks.onClearAudio("barge-in");
      callbacks.onAudio(Buffer.alloc(160, 0x80));
      callbacks.onClearAudio("barge-in");
      callbacks.onResponseDone?.({ status: "completed" });
      await waitFor(() => expect(marks).toHaveLength(count));
      callbacks.onEvent?.({ direction: "server", type: "input_audio_buffer.speech_started" });
      callbacks.onClearAudio("barge-in");
      await sendCallerAudio();
      expect(sendAudio).not.toHaveBeenCalled();
      // Generation completion and media writes are not proof of carrier playback.
      expect(triggerGreeting).toHaveBeenCalledTimes(count);
      ws.send(JSON.stringify({ event: "mark", mark: { name: marks[count - 1] } }));
    }
    // A transport round-trip proves the final acknowledgment was handled.
    let acknowledged = false;
    callbacks.onMark?.("reading-fence", () => {
      acknowledged = true;
    });
    await waitFor(() => expect(marks.at(-1)).toBe("reading-fence"));
    ws.send(JSON.stringify({ event: "mark", mark: { name: "reading-fence" } }));
    await waitFor(() => expect(acknowledged).toBe(true));
    expect(clears).toHaveLength(0);
    await sendCallerAudio();
    expect(sendAudio).toHaveBeenCalledTimes(1);
    // Protection ends with the final carrier acknowledgment, not the session.
    callbacks.onAudio(Buffer.alloc(8_000, 0x80));
    callbacks.onClearAudio("barge-in");
    await waitFor(() => expect(clears).toHaveLength(1));
    expect(spoken.join("")).toBe(text);
    expect(triggerGreeting).toHaveBeenCalledTimes(spoken.length);
    expect(fixture.endCall).not.toHaveBeenCalled();
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it.each(["reset", "failed", "closed"] as const)(
    "does not resume a long reading after %s and a late playback acknowledgment",
    async (reason) => {
      const triggerGreeting = vi.fn<NonNullable<RealtimeVoiceBridge["triggerGreeting"]>>();
      const fixture = makeCallHarness(
        { triggerGreeting, outputAudioMode: "response" },
        {
          call: makeCallRecord("CA-reading-cancel", {
            metadata: { initialMessage: "A long synthetic passage. ".repeat(60) },
          }),
        },
      );
      const { ws, callbacks } = await fixture.start();
      const marks: string[] = [];
      ws.on("message", (data) => {
        const message = parseWebSocketMessage(data);
        if (message.event === "mark") {
          marks.push((message.mark as { name: string }).name);
        }
      });
      callbacks.onReady?.();
      callbacks.onAudio(Buffer.alloc(160, 0x80));
      if (reason === "failed") {
        callbacks.onResponseDone?.({ status: "failed", message: "generation failed" });
        // A later unrelated completed response must not resurrect the reading.
        callbacks.onResponseDone?.({ status: "completed" });
      } else {
        callbacks.onResponseDone?.({ status: "completed" });
        await waitFor(() => expect(marks).toHaveLength(1));
        if (reason === "reset") {
          resetContinuity(callbacks);
        }
        if (reason === "closed") {
          await fixture.handler.close();
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ event: "mark", mark: { name: marks[0] } }));
        }
      }
      if (reason !== "closed" && ws.readyState === WebSocket.OPEN) {
        let acknowledged = false;
        callbacks.onMark?.("cancel-fence", () => {
          acknowledged = true;
        });
        await waitFor(() => expect(marks.at(-1)).toBe("cancel-fence"));
        ws.send(JSON.stringify({ event: "mark", mark: { name: "cancel-fence" } }));
        await waitFor(() => expect(acknowledged).toBe(true));
      }
      expect(triggerGreeting).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["short", "continuous"] as const)("preserves the %s opening path", async (kind) => {
    const text =
      kind === "short" ? "Hello there." : "An unsegmented continuous opening. ".repeat(60);
    const triggerGreeting = vi.fn<NonNullable<RealtimeVoiceBridge["triggerGreeting"]>>();
    const fixture = makeCallHarness(
      { triggerGreeting, outputAudioMode: kind === "continuous" ? "continuous" : "response" },
      { call: makeCallRecord("CA-reading-unchanged", { metadata: { initialMessage: text } }) },
    );
    const { callbacks } = await fixture.start();
    callbacks.onReady?.();
    expect(triggerGreeting).toHaveBeenCalledTimes(1);
    expect(triggerGreeting.mock.calls[0]?.[0]).toContain(text.trim());
    callbacks.onResponseDone?.({ status: "completed" });
    expect(triggerGreeting).toHaveBeenCalledTimes(1);
  });
});
