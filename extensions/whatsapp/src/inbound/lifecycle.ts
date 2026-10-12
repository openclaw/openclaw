import type { BaileysEventEmitter, BaileysEventMap } from "baileys";

type BaileysListener<Event extends keyof BaileysEventMap> = (arg: BaileysEventMap[Event]) => void;

export type WhatsAppSocketListen = <Event extends keyof BaileysEventMap>(
  event: Event,
  listener: BaileysListener<Event>,
) => () => void;

type ClosableSocket = {
  end?: (error: Error | undefined) => void;
  ws?: {
    close?: () => void;
  };
};

export function attachEmitterListener<Event extends keyof BaileysEventMap>(
  emitter: BaileysEventEmitter,
  event: Event,
  listener: BaileysListener<Event>,
): () => void {
  emitter.on(event, listener);
  return () => emitter.off(event, listener);
}

type HeldMessagesUpsert = BaileysEventMap["messages.upsert"];

const heldInboundBySocket = new WeakMap<object, { held: HeldMessagesUpsert[]; stop: () => void }>();

/**
 * Baileys acks and emits messages as soon as the socket opens, while inbox intake
 * attaches only after async setup. WhatsApp never redelivers an acked message, so
 * hold upserts from socket creation until intake takes them.
 */
export function holdInboundUntilIntake(sock: { ev: BaileysEventEmitter }): void {
  if (heldInboundBySocket.has(sock)) {
    return;
  }
  const held: HeldMessagesUpsert[] = [];
  const stop = attachEmitterListener(sock.ev, "messages.upsert", (upsert) => {
    held.push(upsert);
  });
  heldInboundBySocket.set(sock, { held, stop });
}

/** Ends the hold and returns held upserts in arrival order. */
export function takeHeldInbound(sock: { ev: BaileysEventEmitter }): HeldMessagesUpsert[] {
  const hold = heldInboundBySocket.get(sock);
  if (!hold) {
    return [];
  }
  heldInboundBySocket.delete(sock);
  hold.stop();
  return hold.held;
}

export function closeInboundMonitorSocket(sock: ClosableSocket): void {
  if (typeof sock.end === "function") {
    sock.end(new Error("OpenClaw WhatsApp listener close"));
    return;
  }
  sock.ws?.close?.();
}
