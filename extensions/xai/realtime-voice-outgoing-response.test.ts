import type { RealtimeVoiceBridge } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildXaiRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const { FakeWebSocket } = await vi.hoisted(() => import("./realtime-voice-socket.test-support.js"));
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
  const sent = () => socket.sent.map((payload) => JSON.parse(payload) as { type: string });
  socket.open();
  socket.emitServer({ type: "session.updated" });
  await connecting;
  bridge.sendUserMessage?.("First response.");
  expect(
    sent()
      .filter((event) => event.type.startsWith("response."))
      .map((event) => event.type),
  ).toEqual(["response.create", "response.cancel"]);
  socket.emitServer({ type: "response.created", response: { id: "cancelled" } });
  socket.emitServer({
    type: "response.output_audio.delta",
    item_id: "discarded",
    delta: Buffer.alloc(320).toString("base64"),
  });
  expect(onAudio).not.toHaveBeenCalled();
  bridge.sendUserMessage?.("Follow-up response.");
  expect(sent().filter((event) => event.type === "response.create")).toHaveLength(1);
  socket.emitServer({
    type: "response.done",
    response: { id: "cancelled", status: "cancelled", output: [] },
  });
  expect(sent().filter((event) => event.type === "response.create")).toHaveLength(2);
  socket.emitServer({ type: "response.created", response: { id: "recovery" } });
  socket.emitServer({
    type: "response.output_audio.delta",
    item_id: "heard",
    delta: Buffer.alloc(320).toString("base64"),
  });
  expect(onAudio).toHaveBeenCalledTimes(1);
  await bridge.close();
});
