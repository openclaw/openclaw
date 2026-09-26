import type { RealtimeVoiceBridgeCreateRequest } from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, vi } from "vitest";
import {
  connectCarrierStream,
  createBridge,
  createCarrierLifecycleHarness,
} from "./realtime-handler.lifecycle.test-helpers.js";

const LOUD_FRAME = Buffer.alloc(160, 0x00);
const SILENCE_FRAME = Buffer.alloc(160, 0xff);
const TEST_TIMEOUT_MS = 15_000;

function isSilence(buffer: Buffer): boolean {
  return buffer.every((byte) => byte === 0xff);
}

describe("RealtimeCallHandler greeting protection", () => {
  it(
    "mutes caller audio to the provider while the opening greeting is protected",
    async () => {
      let callbacks: RealtimeVoiceBridgeCreateRequest | undefined;
      const providerAudio: Buffer[] = [];
      const { call, handler } = createCarrierLifecycleHarness(
        (request) => {
          callbacks = request;
          return createBridge(() => undefined, {
            sendAudio: (audio: Buffer) => {
              providerAudio.push(Buffer.from(audio));
            },
          });
        },
        { initialMessage: "Hello, is this a good time?" },
      );
      const { server, ws } = await connectCarrierStream(handler);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-greet-mute", callSid: call.providerCallId },
          }),
        );
        await vi.waitFor(() => expect(callbacks).toBeDefined());
        callbacks?.onReady?.();
        ws.send(
          JSON.stringify({
            event: "media",
            media: { payload: LOUD_FRAME.toString("base64") },
          }),
        );
        await vi.waitFor(() => expect(providerAudio.length).toBeGreaterThan(0));
        expect(providerAudio.every(isSilence)).toBe(true);
      } finally {
        ws.terminate();
        await handler.close().catch(() => undefined);
        await server.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "releases caller audio when the greeting never produces audio",
    async () => {
      let callbacks: RealtimeVoiceBridgeCreateRequest | undefined;
      const providerAudio: Buffer[] = [];
      const { call, handler } = createCarrierLifecycleHarness(
        (request) => {
          callbacks = request;
          return createBridge(() => undefined, {
            sendAudio: (audio: Buffer) => {
              providerAudio.push(Buffer.from(audio));
            },
          });
        },
        { initialMessage: "Hello, is this a good time?" },
      );
      const { server, ws } = await connectCarrierStream(handler);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-greet-stall", callSid: call.providerCallId },
          }),
        );
        await vi.waitFor(() => expect(callbacks).toBeDefined());
        callbacks?.onReady?.();
        ws.send(
          JSON.stringify({
            event: "media",
            media: { payload: LOUD_FRAME.toString("base64") },
          }),
        );
        await vi.waitFor(() => expect(providerAudio.length).toBeGreaterThan(0));
        expect(providerAudio.every(isSilence)).toBe(true);

        providerAudio.length = 0;
        // The greeting audio never arrives; after the bounded pre-audio wait the window releases
        // caller audio instead of holding it silent for the whole protection timeout.
        await vi.waitFor(
          () => {
            ws.send(
              JSON.stringify({
                event: "media",
                media: { payload: LOUD_FRAME.toString("base64") },
              }),
            );
            expect(providerAudio.some((buffer) => !isSilence(buffer))).toBe(true);
          },
          { timeout: 8_000, interval: 250 },
        );
      } finally {
        ws.terminate();
        await handler.close().catch(() => undefined);
        await server.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps protection until the carrier confirms the greeting played, then resumes caller audio",
    async () => {
      let callbacks: RealtimeVoiceBridgeCreateRequest | undefined;
      const providerAudio: Buffer[] = [];
      const { call, handler } = createCarrierLifecycleHarness(
        (request) => {
          callbacks = request;
          return createBridge(() => undefined, {
            sendAudio: (audio: Buffer) => {
              providerAudio.push(Buffer.from(audio));
            },
          });
        },
        { initialMessage: "Hello, is this a good time?" },
      );
      const { server, ws } = await connectCarrierStream(handler);
      const outboundMarks: string[] = [];
      try {
        ws.on("message", (data) => {
          try {
            const frame = JSON.parse(data.toString()) as {
              event?: string;
              mark?: { name?: string };
            };
            if (frame.event === "mark" && frame.mark?.name) {
              outboundMarks.push(frame.mark.name);
            }
          } catch {
            // ignore non-JSON carrier frames
          }
        });
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-greet-confirm", callSid: call.providerCallId },
          }),
        );
        await vi.waitFor(() => expect(callbacks).toBeDefined());
        callbacks?.onReady?.();
        // The provider produces the greeting, then reports the turn complete.
        callbacks?.onAudio?.(Buffer.alloc(160 * 8, 0xff), { itemId: "greeting-1" });
        callbacks?.onResponseDone?.({ status: "completed", responseId: "greeting" });

        // The completion mark is queued only once the pacer is drained and the line is quiet.
        await vi.waitFor(() => expect(outboundMarks.length).toBeGreaterThan(0), {
          timeout: 6_000,
          interval: 100,
        });

        // Until the carrier acknowledges the mark, caller audio is still muted.
        ws.send(
          JSON.stringify({
            event: "media",
            media: { payload: LOUD_FRAME.toString("base64") },
          }),
        );
        await vi.waitFor(() => expect(providerAudio.length).toBeGreaterThan(0));
        expect(providerAudio.every(isSilence)).toBe(true);

        // The carrier reports the mark reached playout; protection disarms.
        ws.send(JSON.stringify({ event: "mark", mark: { name: outboundMarks[0] } }));
        providerAudio.length = 0;
        await vi.waitFor(() => {
          ws.send(
            JSON.stringify({
              event: "media",
              media: { payload: SILENCE_FRAME.toString("base64") },
            }),
          );
          expect(providerAudio.length).toBeGreaterThan(0);
        });
      } finally {
        ws.terminate();
        await handler.close().catch(() => undefined);
        await server.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
