import { EventEmitter } from "node:events";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { identityFromPrivateKey } from "./protocol.js";
import { RelayService, type RelaySocket } from "./service.js";
import { createStateFixture } from "./state.test-helpers.js";

export const NONCE = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
export const GATEWAY_ID = "gw_ZbYGc9btiEvwHCwiLYKtoH";
export const PUBLIC_KEY = "ebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ";
export const SIGNATURE =
  "wZaNEXDNbmhncHDPb_N5xVWk2IJD78-z-jg0_zvwiSspB7jo63XSwGuj7cHFx2evxQ8kII2r6dRIFeNlcqISAQ";
export const VECTOR_PRIVATE_KEY = Buffer.from(
  "302e020100300506032b657004220420" +
    "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
  "hex",
).toString("base64url");
export const CHALLENGE = {
  type: "challenge",
  protocol: 1,
  nonce: NONCE,
  relay: "mcp.openclaw.ai",
};
export const CLIENT = { id: "synthetic-client", name: "Synthetic client" };

function parseFrame(text: string): Record<string, unknown> {
  const frame: unknown = JSON.parse(text);
  if (!isRecord(frame)) {
    throw new Error("Expected an object frame");
  }
  return frame;
}

export class FakeRelaySocket extends EventEmitter implements RelaySocket {
  readonly frames: Record<string, unknown>[] = [];
  readonly closes: { code?: number; reason?: string }[] = [];
  readonly #queue: Record<string, unknown>[] = [];
  readonly #readers: ((frame: Record<string, unknown>) => void)[] = [];
  terminated = false;

  send(data: Parameters<RelaySocket["send"]>[0]): void {
    if (typeof data !== "string") {
      throw new Error("The Gateway must send text frames");
    }
    const frame = parseFrame(data);
    this.frames.push(frame);
    const reader = this.#readers.shift();
    if (reader) {
      reader(frame);
    } else {
      this.#queue.push(frame);
    }
  }

  close(code?: number, reason?: string | Buffer): void {
    this.closes.push({ code, reason: reason?.toString() });
    this.emit("close", code ?? 1000, Buffer.from(reason ?? ""));
  }

  terminate(): void {
    this.terminated = true;
    this.emit("close", 1006, Buffer.alloc(0));
  }

  receive(frame: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(frame)), false);
  }

  nextFrame(): Promise<Record<string, unknown>> {
    const frame = this.#queue.shift();
    return frame
      ? Promise.resolve(frame)
      : new Promise((resolve) => {
          this.#readers.push(resolve);
        });
  }

  acknowledge(frame: Record<string, unknown>): void {
    this.receive({ type: "res", id: frame.id, ok: true, result: {} });
  }
}

export async function createTransportFixture(
  operations: ConstructorParameters<typeof RelayService>[0]["operations"] = async () => ({}),
) {
  const clock = createGatewaySchedulerClock(1_000);
  const scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
  const storage = createStateFixture();
  const state = storage.open();
  await state.initialize();
  const sockets: FakeRelaySocket[] = [];
  const addresses: string[] = [];
  const effects: { connectError?: Error } = {};
  const service = new RelayService({
    scheduler,
    state,
    identity: identityFromPrivateKey(VECTOR_PRIVATE_KEY),
    relayUrl: "https://mcp.openclaw.ai",
    gateway: { name: "Synthetic Gateway", version: "2026.10.9" },
    operations,
    random: () => 0.5,
    socketFactory: (address) => {
      addresses.push(address);
      if (effects.connectError) {
        throw effects.connectError;
      }
      const socket = new FakeRelaySocket();
      sockets.push(socket);
      return socket;
    },
  });
  service.start();
  await clock.advanceBy(0);
  const socket = sockets[0];
  if (!socket) {
    throw new Error("The service did not connect");
  }
  return {
    clock,
    scheduler,
    storage,
    state,
    service,
    socket,
    sockets,
    addresses,
    effects,
    ready: async (target = socket) => {
      target.receive(CHALLENGE);
      const hello = await target.nextFrame();
      target.receive({ type: "ready", gatewayId: GATEWAY_ID });
      return hello;
    },
    request: async (frame: Record<string, unknown>) => {
      socket.receive({ type: "req", ...frame });
      await clock.advanceBy(0);
      return socket.nextFrame();
    },
    stop: async () => {
      await service.stop();
      await scheduler.stop();
    },
  };
}
