import type { BaileysEventEmitter, BaileysEventMap, WASocket } from "baileys";

type BaileysListener<Event extends keyof BaileysEventMap> = (arg: BaileysEventMap[Event]) => void;

export type WhatsAppSocketListen = <Event extends keyof BaileysEventMap>(
  event: Event,
  listener: BaileysListener<Event>,
) => () => void;

export function attachEmitterListener<Event extends keyof BaileysEventMap>(
  emitter: BaileysEventEmitter,
  event: Event,
  listener: BaileysListener<Event>,
): () => void {
  emitter.on(event, listener);
  return () => emitter.off(event, listener);
}

export function closeInboundMonitorSocket(sock: Pick<WASocket, "end">): void {
  void sock.end(new Error("OpenClaw WhatsApp listener close"));
}
