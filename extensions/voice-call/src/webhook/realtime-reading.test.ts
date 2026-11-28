import { once } from "node:events";
import type { RealtimeVoiceBridge } from "openclaw/plugin-sdk/realtime-voice";
import { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makeCall as makeCallRecord,
  makeRealtimeProvider,
} from "./realtime-call-control.test-helpers.js";
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
    // Providers can buffer carrier input before readiness and drain it after the greeting starts.
    await sendCallerAudio();
    expect(sendAudio).toHaveBeenCalled();
    callbacks.onReady?.();
    sendAudio.mockClear();
    const spoken: string[] = [];
    while (spoken.join("").length < text.length) {
      const count = spoken.length + 1;
      await waitForCalls(triggerGreeting, count);
      const prompt = triggerGreeting.mock.calls.at(-1)?.[0] ?? "";
      expect(prompt.length).toBeLessThan(2_000);
      const passage = JSON.parse(prompt.slice(prompt.lastIndexOf("Answer: ") + 8)) as string;
      expect(passage.length).toBeLessThanOrEqual(481);
      expect(passage.trimEnd()).toMatch(/[.!?]$/u);
      spoken.push(passage);
      callbacks.onEvent?.({
        direction: "server",
        type: "response.created",
        responseId: `reading-${count}`,
      });
      callbacks.onAudio(Buffer.alloc(160, 0x80));
      callbacks.onResponseDone?.({ status: "completed", responseId: `reading-${count}` });
      await waitFor(() => expect(marks).toHaveLength(count));
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

  it("pauses on caller speech, repeats only the unacknowledged passage on resume, and stops permanently", async () => {
    const triggerGreeting = vi.fn<NonNullable<RealtimeVoiceBridge["triggerGreeting"]>>();
    const submitToolResult = vi.fn<RealtimeVoiceBridge["submitToolResult"]>();
    const sendAudio = vi.fn<RealtimeVoiceBridge["sendAudio"]>();
    const fixture = makeCallHarness(
      { triggerGreeting, submitToolResult, sendAudio, outputAudioMode: "response" },
      {
        call: makeCallRecord("CA-resume", {
          metadata: { initialMessage: "A prepared sentence. ".repeat(80) },
        }),
      },
    );
    const { ws, callbacks } = await fixture.start();
    const marks: string[] = [];
    let clears = 0;
    ws.on("message", (data) => {
      const message = parseWebSocketMessage(data);
      if (message.event === "mark") {
        marks.push((message.mark as { name: string }).name);
      }
      if (message.event === "clear") {
        clears++;
      }
    });
    const ack = (mark: string) => ws.send(JSON.stringify({ event: "mark", mark: { name: mark } }));
    const response = (id: string) => {
      callbacks.onEvent?.({ direction: "server", type: "response.created", responseId: id });
      callbacks.onAudio(Buffer.alloc(160, 0x80));
      callbacks.onResponseDone?.({ status: "completed", responseId: id });
    };
    const control = (action: string, text?: string) =>
      callbacks.onToolCall?.({
        callId: action,
        itemId: action,
        name: "openclaw_statement",
        args: { action, ...(text ? { text } : {}) },
      });
    callbacks.onReady?.();
    response("first");
    await waitFor(() => expect(marks).toHaveLength(1));
    ack(marks[0]!);
    await waitForCalls(triggerGreeting, 2);
    const interrupted = triggerGreeting.mock.calls[1]?.[0];
    response("second");
    await waitFor(() => expect(marks).toHaveLength(2));
    callbacks.onEvent?.({ direction: "server", type: "input_audio_buffer.speech_started" });
    callbacks.onClearAudio("barge-in");
    await waitFor(() => expect(clears).toBe(1));
    callbacks.onTranscript?.("user", "Wait, what is this about?", true);
    response("answer");
    ack(marks[1]!); // Twilio can return a cleared mark; it must not skip the interrupted passage.
    // A model cannot replace the host's retained statement by recursively invoking start.
    control("start", "A recursive replacement. ".repeat(40));
    await waitFor(() =>
      expect(submitToolResult).toHaveBeenLastCalledWith(
        "start",
        {
          error:
            "Only resume a paused host statement. The host supplies passages to read directly; this tool cannot start or replace them.",
        },
        undefined,
      ),
    );
    expect(triggerGreeting).toHaveBeenCalledTimes(2);
    control("resume");
    await waitFor(() => expect(marks).toHaveLength(3));
    expect(triggerGreeting).toHaveBeenCalledTimes(2); // Wait for the answer's playback.
    ack(marks[2]!);
    await waitForCalls(triggerGreeting, 3);
    expect(triggerGreeting.mock.calls[2]?.[0]).toBe(interrupted);
    response("resumed");
    await waitFor(() => expect(marks).toHaveLength(4));
    callbacks.onEvent?.({ direction: "server", type: "input_audio_buffer.speech_started" });
    callbacks.onClearAudio("barge-in");
    control("stop");
    await waitFor(() =>
      expect(submitToolResult).toHaveBeenCalledWith("stop", { stopped: true }, undefined),
    );
    ack(marks[3]!);
    control("resume");
    await waitFor(() =>
      expect(submitToolResult).toHaveBeenLastCalledWith(
        "resume",
        {
          error:
            "Only resume a paused host statement. The host supplies passages to read directly; this tool cannot start or replace them.",
        },
        undefined,
      ),
    );
    expect(triggerGreeting).toHaveBeenCalledTimes(3);
    // The host can still supply a new prepared statement later in the call.
    const later = "A host supplied statement. ".repeat(40);
    expect(fixture.handler.speak(fixture.call.callId, later, later)).toEqual({ success: true });
    await waitForCalls(triggerGreeting, 4);
    expect(triggerGreeting.mock.calls[3]?.[0]).toContain("A host supplied statement.");
    expect(fixture.endCall).not.toHaveBeenCalled();
  });

  it("retains an opening interrupted before readiness and resumes without requesting new text", async () => {
    const triggerGreeting = vi.fn<NonNullable<RealtimeVoiceBridge["triggerGreeting"]>>();
    const fixture = makeCallHarness(
      { triggerGreeting, outputAudioMode: "response" },
      {
        call: makeCallRecord("CA-early", {
          metadata: { initialMessage: "A retained opening sentence. ".repeat(30) },
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
    callbacks.onEvent?.({ direction: "server", type: "input_audio_buffer.speech_started" });
    callbacks.onReady?.();
    expect(triggerGreeting).toHaveBeenCalledTimes(1);
    expect(triggerGreeting.mock.calls[0]?.[0]).toContain("host retains the complete statement");
    callbacks.onToolCall?.({
      name: "openclaw_statement",
      callId: "resume-early",
      itemId: "resume-early",
      args: { action: "resume" },
    });
    await waitFor(() => expect(marks).toHaveLength(1));
    ws.send(JSON.stringify({ event: "mark", mark: { name: marks[0] } }));
    await waitForCalls(triggerGreeting, 2);
    expect(triggerGreeting.mock.calls[1]?.[0]).toContain("A retained opening sentence.");
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
      callbacks.onEvent?.({ direction: "server", type: "response.created" });
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
      {
        call: makeCallRecord("CA-reading-unchanged", { metadata: { initialMessage: text } }),
        ...(kind === "continuous"
          ? {
              deps: {
                realtimeProvider: makeRealtimeProvider(
                  () => {
                    throw new Error("fixture installs createBridge");
                  },
                  { id: "continuous-provider" },
                ),
              },
            }
          : {}),
      },
    );
    const { callbacks } = await fixture.start();
    if (kind === "continuous") {
      expect(callbacks.tools?.some((tool) => tool.name === "openclaw_statement")).toBe(false);
    }
    callbacks.onReady?.();
    expect(triggerGreeting).toHaveBeenCalledTimes(1);
    expect(triggerGreeting.mock.calls[0]?.[0]).toContain(text.trim());
    callbacks.onResponseDone?.({ status: "completed" });
    expect(triggerGreeting).toHaveBeenCalledTimes(1);
  });
});
