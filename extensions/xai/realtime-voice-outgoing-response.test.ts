import type { RealtimeVoiceBridge } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildXaiRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const { FakeWebSocket } = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");
  class MockWebSocket extends EventEmitter {
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    static instances: MockWebSocket[] = [];
    readyState = 0;
    sent: string[] = [];
    constructor() {
      super();
      MockWebSocket.instances.push(this);
    }
    send(payload: string) {
      this.sent.push(payload);
    }
    close() {
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close", 1000, Buffer.from(""));
    }
  }
  return { FakeWebSocket: MockWebSocket };
});
vi.mock("./ws-runtime.js", () => ({ WebSocket: FakeWebSocket }));

beforeEach(() => {
  FakeWebSocket.instances = [];
});
afterEach(() => {
  vi.unstubAllEnvs();
});

it("sends xAI creation before its observer can cancel and releases the next turn", async () => {
  const onAudio = vi.fn();
  let cancelled = false;
  const bridge: RealtimeVoiceBridge = buildXaiRealtimeVoiceProvider().createBridge({
    providerConfig: { apiKey: "xai-test" }, // pragma: allowlist secret
    onAudio,
    onClearAudio: vi.fn(),
    onEvent: (event) => {
      if (event.direction === "client" && event.type === "response.create" && !cancelled) {
        cancelled = true;
        bridge.handleBargeIn?.({ force: true });
      }
    },
  });
  const connecting = bridge.connect();
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const socket = FakeWebSocket.instances[0]!;
  const emit = (event: unknown) => socket.emit("message", Buffer.from(JSON.stringify(event)));
  const sent = () => socket.sent.map((payload) => JSON.parse(payload) as { type: string });
  socket.readyState = FakeWebSocket.OPEN;
  socket.emit("open");
  emit({ type: "session.updated" });
  await connecting;
  bridge.sendUserMessage?.("First response.");
  expect(
    sent()
      .filter((event) => event.type.startsWith("response."))
      .map((event) => event.type),
  ).toEqual(["response.create", "response.cancel"]);
  emit({ type: "response.created", response: { id: "cancelled" } });
  emit({
    type: "response.output_audio.delta",
    item_id: "discarded",
    delta: Buffer.alloc(320).toString("base64"),
  });
  expect(onAudio).not.toHaveBeenCalled();
  bridge.sendUserMessage?.("Follow-up response.");
  expect(sent().filter((event) => event.type === "response.create")).toHaveLength(1);
  emit({ type: "response.done", response: { id: "cancelled", status: "cancelled", output: [] } });
  expect(sent().filter((event) => event.type === "response.create")).toHaveLength(2);
  emit({ type: "response.created", response: { id: "recovery" } });
  emit({
    type: "response.output_audio.delta",
    item_id: "heard",
    delta: Buffer.alloc(320).toString("base64"),
  });
  expect(onAudio).toHaveBeenCalledTimes(1);
  await bridge.close();
});
