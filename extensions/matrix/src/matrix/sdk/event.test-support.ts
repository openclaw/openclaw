import { EventEmitter } from "node:events";
import { DecryptionFailureCode } from "matrix-js-sdk/lib/crypto-api/index.js";
import { vi } from "vitest";

type FakeMatrixEventParams = {
  roomId: string;
  eventId: string;
  sender: string;
  type: string;
  ts: number;
  content: Record<string, unknown>;
  stateKey?: string;
  unsigned?: {
    age?: number;
    redacted_because?: unknown;
  };
  decryptionFailure?: boolean;
  decryptionFailureReason?: DecryptionFailureCode;
};

export type MatrixEventDecryptor = (event: FakeMatrixEvent) => Promise<void>;

export class FakeMatrixEvent extends EventEmitter {
  private readonly data: FakeMatrixEventParams;
  private readonly encrypted: boolean;
  private clearEvent?: { type: string; content: Record<string, unknown> };
  private decryptionFailureReasonValue: DecryptionFailureCode | null;
  private decryptionFailure: boolean;
  private decryptionPromise: Promise<void> | null = null;
  private decryptAttemptHandler?: (options?: { isRetry?: boolean }) => Promise<void> | void;
  readonly attemptDecryption = vi.fn(
    async (_crypto: unknown, options?: { isRetry?: boolean }): Promise<void> => {
      await this.decryptAttemptHandler?.(options);
    },
  );

  constructor(params: FakeMatrixEventParams) {
    super();
    this.data = { ...params };
    this.encrypted = params.type === "m.room.encrypted";
    this.decryptionFailureReasonValue = params.decryptionFailure
      ? (params.decryptionFailureReason ?? DecryptionFailureCode.UNKNOWN_ERROR)
      : null;
    this.decryptionFailure = params.decryptionFailure === true;
  }

  get decryptionFailureReason(): DecryptionFailureCode | null {
    return this.decryptionFailureReasonValue;
  }

  getRoomId(): string {
    return this.data.roomId;
  }

  getId(): string {
    return this.data.eventId;
  }

  getSender(): string {
    return this.data.sender;
  }

  getType(): string {
    return this.clearEvent?.type ?? this.data.type;
  }

  getTs(): number {
    return this.data.ts;
  }

  getContent(): Record<string, unknown> {
    return this.clearEvent?.content ?? this.data.content;
  }

  getOriginalContent(): Record<string, unknown> {
    return this.getContent();
  }

  getWireContent(): Record<string, unknown> {
    return this.data.content;
  }

  getUnsigned(): { age?: number; redacted_because?: unknown } {
    return this.data.unsigned ?? {};
  }

  getStateKey(): string | undefined {
    return this.data.stateKey;
  }

  getWireStateKey(): string | undefined {
    return this.data.stateKey;
  }

  isDecryptionFailure(): boolean {
    return this.decryptionFailure;
  }

  shouldAttemptDecryption(): boolean {
    return this.encrypted && this.clearEvent === undefined;
  }

  getDecryptionPromise(): Promise<void> | null {
    return this.decryptionPromise;
  }

  setDecryptionPromise(promise: Promise<void> | null): void {
    this.decryptionPromise = promise;
  }

  onAttemptDecryption(handler: (options?: { isRetry?: boolean }) => Promise<void> | void): void {
    this.decryptAttemptHandler = handler;
  }

  markDecryptionFailed(reason: string): void {
    this.clearEvent = {
      type: "m.room.message",
      content: {
        msgtype: "m.bad.encrypted",
        body: `** Unable to decrypt: ${reason} **`,
      },
    };
    this.decryptionFailure = true;
    this.decryptionFailureReasonValue ??= DecryptionFailureCode.MEGOLM_UNKNOWN_INBOUND_SESSION_ID;
    this.emit("decrypted", this, new Error(reason));
  }

  markDecrypted(params: { type: string; content: Record<string, unknown> }): void {
    Object.assign(this.data, params);
    this.clearEvent = { ...params };
    this.decryptionFailure = false;
    this.decryptionFailureReasonValue = null;
  }
}

export function makeMatrixEvent(overrides: Partial<FakeMatrixEventParams> = {}): FakeMatrixEvent {
  return new FakeMatrixEvent({
    roomId: "!room:example.org",
    eventId: "$event",
    sender: "@alice:example.org",
    type: "m.room.encrypted",
    ts: Date.now(),
    content: {},
    ...overrides,
  });
}

export function makeDecryptedMessageEvent(
  overrides: Partial<FakeMatrixEventParams> = {},
): FakeMatrixEvent {
  return makeMatrixEvent({
    type: "m.room.message",
    content: { msgtype: "m.text", body: "hello" },
    ...overrides,
  });
}
