import type { ElevenLabsDialogueSocket } from "./dialogue.js";

export class MessageBuffer {
  private readonly queue: unknown[] = [];
  private failed?: Error;
  private waiter?: {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  };

  constructor(socket: ElevenLabsDialogueSocket) {
    socket.onMessage((data) => {
      try {
        this.push(decodeDialogueMessage(data));
      } catch (error) {
        this.fail(
          error instanceof Error
            ? error
            : new Error("ElevenLabs dialogue received a non-JSON message"),
        );
      }
    });
    socket.onError((error) => {
      this.fail(
        error instanceof Error ? error : new Error("ElevenLabs dialogue connection failed"),
      );
    });
    socket.onClose(() => {
      this.fail(this.failed ?? new Error("ElevenLabs dialogue connection closed"));
    });
  }

  fail(error: Error): void {
    if (this.failed) {
      return;
    }
    this.failed = error;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.reject(error);
  }

  next(): Promise<unknown> {
    const queued = this.queue.shift();
    if (queued !== undefined) {
      return Promise.resolve(queued);
    }
    if (this.failed) {
      return Promise.reject(this.failed);
    }
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  private push(value: unknown): void {
    if (this.failed) {
      return;
    }
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.resolve(value);
      return;
    }
    this.queue.push(value);
  }
}

function decodeDialogueMessage(data: unknown): unknown {
  const text = dialogueMessageText(data);
  if (text === undefined) {
    throw new Error("ElevenLabs dialogue received a non-JSON message");
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    throw new Error("ElevenLabs dialogue received a non-JSON message");
  }
}

function dialogueMessageText(data: unknown): string | undefined {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  if (Array.isArray(data) && data.every((entry) => Buffer.isBuffer(entry))) {
    return Buffer.concat(data).toString("utf8");
  }
  return undefined;
}

function isDialogueRecord(message: unknown): message is Record<string, unknown> {
  return message !== null && typeof message === "object" && !Array.isArray(message);
}

export function asDialogueRecord(message: unknown): Record<string, unknown> {
  if (!isDialogueRecord(message)) {
    throw new Error("ElevenLabs dialogue received a malformed message");
  }
  return message;
}

export function throwIfDialogueServerError(message: Record<string, unknown>): void {
  if (typeof message.error !== "string" || message.error.length === 0) {
    return;
  }
  const detail = typeof message.message === "string" ? message.message : message.error;
  throw new Error(`ElevenLabs dialogue error (${message.error}): ${detail}`);
}

export function readDialogueAudioChunk(message: Record<string, unknown>): Buffer | undefined {
  if (typeof message.audio !== "string" || message.audio.length === 0) {
    return undefined;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(message.audio)) {
    throw new Error("ElevenLabs dialogue received malformed audio");
  }
  return Buffer.from(message.audio, "base64");
}
