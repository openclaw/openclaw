import { createRealtimeVoiceBridgeSession } from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, vi } from "vitest";
import { openAIRealtimeHost } from "./realtime-host.js";
import { OpenAIQuicksilverVoiceBridge } from "./realtime-quicksilver-bridge.js";
import { emitSideband, FakeSocket } from "./realtime-quicksilver.test-helpers.js";

describe("public GPT-Live active failure ownership", () => {
  it.each([
    ["transport", "close"],
    ["binary", "close"],
    ["audio", "close"],
    ["provider", "close"],
    ["transport", "reconnect"],
    ["provider", "event-reconnect"],
    ["transport", "throw-transcript"],
    ["provider", "throw-error"],
  ] as const)("drains %s failure snapshots with %s observers", async (failure, observer) => {
    const sockets: FakeSocket[] = [];
    const trace: string[] = [];
    const snapshots: string[] = [];
    const closes: string[] = [];
    const completions: Array<void | Promise<void>> = [];
    const observerError = new Error("observer failed");
    let reconnect: Promise<void> | undefined;
    const session = createRealtimeVoiceBridgeSession({
      provider: {
        id: "openai",
        label: "OpenAI",
        isConfigured: () => true,
        createBridge: (request) =>
          new OpenAIQuicksilverVoiceBridge(
            {
              ...request,
              model: "gpt-live-1",
              resolveAuth: async () => ({ type: "api-key", token: "fixture-key" }),
              logger: { warn: vi.fn() },
              webSocketFactory: () => {
                const socket = new FakeSocket();
                sockets.push(socket);
                return socket;
              },
            },
            openAIRealtimeHost,
          ),
      },
      providerConfig: {},
      audioSink: { sendAudio: vi.fn() },
      onTranscript: (role, text, final) => {
        if (!final) {
          return;
        }
        snapshots.push(`${role}:${text}`);
        trace.push(`final:${role}`);
        if (observer === "close") {
          completions.push(session.close());
        }
        if (observer === "throw-transcript") {
          throw observerError;
        }
      },
      onEvent: (event) => {
        if (event.type === "error") {
          trace.push("event:error");
          if (observer === "event-reconnect") {
            reconnect = session.connect();
          }
        }
      },
      onError: () => {
        trace.push("error");
        if (observer === "reconnect") {
          reconnect = session.connect();
        }
        if (observer === "throw-error") {
          throw observerError;
        }
      },
      onClose: (reason) => {
        trace.push("close");
        closes.push(reason);
      },
    });
    try {
      const connecting = session.connect();
      await vi.waitFor(() => expect(sockets[0]?.sent.length).toBe(1));
      const socket = sockets[0]!;
      emitSideband(socket, { type: "session.started", session: {} });
      await connecting;
      emitSideband(socket, {
        type: "session.input_transcript.delta",
        delta: "Question",
        start_ms: 0,
        end_ms: 100,
      });
      if (observer !== "throw-transcript") {
        emitSideband(socket, {
          type: "session.output_transcript.delta",
          delta: "Answer",
          start_ms: 100,
          end_ms: 200,
        });
      }
      const trigger = () => {
        if (failure === "transport") {
          socket.emit("error", new Error("network failed"));
        } else if (failure === "binary") {
          socket.emit("message", Buffer.from([1, 2]), true);
        } else if (failure === "audio") {
          emitSideband(socket, { type: "session.output_audio.delta", delta: "not-base64!" });
        } else {
          emitSideband(socket, { type: "error", error: { code: "invalid_api_key" } });
        }
      };
      if (observer.startsWith("throw")) {
        expect(trigger).toThrow(observerError);
      } else {
        trigger();
      }
      await Promise.resolve();
      expect(snapshots).toEqual(
        observer === "throw-transcript" ? ["user:Question"] : ["user:Question", "assistant:Answer"],
      );
      const terminal = trace.findIndex((entry) => !entry.startsWith("final:"));
      expect(terminal).toBe(snapshots.length);
      expect(socket.closed).toBe(true);
      emitSideband(socket, {
        type: "session.input_transcript.delta",
        delta: "stale",
        start_ms: 200,
        end_ms: 300,
      });
      expect(snapshots).not.toContain("user:stale");
      if (observer === "close") {
        expect(completions.every((completion) => completion instanceof Promise)).toBe(true);
        await Promise.all(completions.map((completion) => Promise.resolve(completion)));
      }
      if (reconnect) {
        expect(closes).toEqual([]);
        await vi.waitFor(() => expect(sockets[1]?.sent.length).toBe(1));
        const replacement = sockets[1]!;
        emitSideband(replacement, { type: "session.started", session: {} });
        await reconnect;
        expect(replacement.closed).toBe(false);
        expect(session.bridge.isConnected()).toBe(true);
        emitSideband(replacement, { type: "session.closed", reason: "close_requested" });
      } else {
        expect(closes).toEqual(["error"]);
      }
    } finally {
      for (const socket of sockets) {
        if (!socket.closed) {
          emitSideband(socket, { type: "session.closed", reason: "close_requested" });
        }
      }
      await Promise.allSettled([...completions, session.close()]);
    }
  });
});
