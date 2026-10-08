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

export class FakeMatrixEvent extends EventEmitter {
  private readonly roomId: string;
  private readonly eventId: string;
  private readonly sender: string;
  private readonly encrypted: boolean;
  private type: string;
  private readonly ts: number;
  private content: Record<string, unknown>;
  private clearEvent?: { type: string; content: Record<string, unknown> };
  private readonly stateKey?: string;
  private readonly unsigned?: {
    age?: number;
    redacted_because?: unknown;
  };
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
    this.roomId = params.roomId;
    this.eventId = params.eventId;
    this.sender = params.sender;
    this.encrypted = params.type === "m.room.encrypted";
    this.type = params.type;
    this.ts = params.ts;
    this.content = params.content;
    this.stateKey = params.stateKey;
    this.unsigned = params.unsigned;
    this.decryptionFailureReasonValue = params.decryptionFailure
      ? (params.decryptionFailureReason ?? DecryptionFailureCode.UNKNOWN_ERROR)
      : null;
    this.decryptionFailure = params.decryptionFailure === true;
  }

  get decryptionFailureReason(): DecryptionFailureCode | null {
    return this.decryptionFailureReasonValue;
  }

  getRoomId(): string {
    return this.roomId;
  }

  getId(): string {
    return this.eventId;
  }

  getSender(): string {
    return this.sender;
  }

  getType(): string {
    return this.clearEvent?.type ?? this.type;
  }

  getTs(): number {
    return this.ts;
  }

  getContent(): Record<string, unknown> {
    return this.clearEvent?.content ?? this.content;
  }

  getOriginalContent(): Record<string, unknown> {
    return this.getContent();
  }

  getWireContent(): Record<string, unknown> {
    return this.content;
  }

  getUnsigned(): { age?: number; redacted_because?: unknown } {
    return this.unsigned ?? {};
  }

  getStateKey(): string | undefined {
    return this.stateKey;
  }

  getWireStateKey(): string | undefined {
    return this.stateKey;
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
    this.type = params.type;
    this.content = params.content;
    this.clearEvent = { type: params.type, content: params.content };
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
