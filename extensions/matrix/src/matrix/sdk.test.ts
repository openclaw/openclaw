import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeMatrixEvent extends EventEmitter {
  private readonly roomId: string;
  private readonly eventId: string;
  private readonly sender: string;
  private readonly type: string;
  private readonly ts: number;
  private readonly content: Record<string, unknown>;
  private readonly stateKey?: string;
  private readonly unsigned?: {
    age?: number;
    redacted_because?: unknown;
  };
  private readonly decryptionFailure: boolean;

  constructor(params: {
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
  }) {
    super();
    this.roomId = params.roomId;
    this.eventId = params.eventId;
    this.sender = params.sender;
    this.type = params.type;
    this.ts = params.ts;
    this.content = params.content;
    this.stateKey = params.stateKey;
    this.unsigned = params.unsigned;
    this.decryptionFailure = params.decryptionFailure === true;
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
    return this.type;
  }

  getTs(): number {
    return this.ts;
  }

  getContent(): Record<string, unknown> {
    return this.content;
  }

  getUnsigned(): { age?: number; redacted_because?: unknown } {
    return this.unsigned ?? {};
  }

  getStateKey(): string | undefined {
    return this.stateKey;
  }

  isDecryptionFailure(): boolean {
    return this.decryptionFailure;
  }
}

type MatrixJsClientStub = EventEmitter & {
  startClient: ReturnType<typeof vi.fn>;
  stopClient: ReturnType<typeof vi.fn>;
  initRustCrypto: ReturnType<typeof vi.fn>;
  getUserId: ReturnType<typeof vi.fn>;
  getJoinedRooms: ReturnType<typeof vi.fn>;
  getJoinedRoomMembers: ReturnType<typeof vi.fn>;
  getStateEvent: ReturnType<typeof vi.fn>;
  getAccountData: ReturnType<typeof vi.fn>;
  setAccountData: ReturnType<typeof vi.fn>;
  getRoomIdForAlias: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  sendEvent: ReturnType<typeof vi.fn>;
  sendStateEvent: ReturnType<typeof vi.fn>;
  redactEvent: ReturnType<typeof vi.fn>;
  getProfileInfo: ReturnType<typeof vi.fn>;
  joinRoom: ReturnType<typeof vi.fn>;
  mxcUrlToHttp: ReturnType<typeof vi.fn>;
  uploadContent: ReturnType<typeof vi.fn>;
  fetchRoomEvent: ReturnType<typeof vi.fn>;
  sendTyping: ReturnType<typeof vi.fn>;
  getRoom: ReturnType<typeof vi.fn>;
  getCrypto: ReturnType<typeof vi.fn>;
};

function createMatrixJsClientStub(): MatrixJsClientStub {
  const client = new EventEmitter() as MatrixJsClientStub;
  client.startClient = vi.fn(async () => {});
  client.stopClient = vi.fn();
  client.initRustCrypto = vi.fn(async () => {});
  client.getUserId = vi.fn(() => "@bot:example.org");
  client.getJoinedRooms = vi.fn(async () => ({ joined_rooms: [] }));
  client.getJoinedRoomMembers = vi.fn(async () => ({ joined: {} }));
  client.getStateEvent = vi.fn(async () => ({}));
  client.getAccountData = vi.fn(() => undefined);
  client.setAccountData = vi.fn(async () => {});
  client.getRoomIdForAlias = vi.fn(async () => ({ room_id: "!resolved:example.org" }));
  client.sendMessage = vi.fn(async () => ({ event_id: "$sent" }));
  client.sendEvent = vi.fn(async () => ({ event_id: "$sent-event" }));
  client.sendStateEvent = vi.fn(async () => ({ event_id: "$state" }));
  client.redactEvent = vi.fn(async () => ({ event_id: "$redact" }));
  client.getProfileInfo = vi.fn(async () => ({}));
  client.joinRoom = vi.fn(async () => ({}));
  client.mxcUrlToHttp = vi.fn(() => null);
  client.uploadContent = vi.fn(async () => ({ content_uri: "mxc://example/file" }));
  client.fetchRoomEvent = vi.fn(async () => ({}));
  client.sendTyping = vi.fn(async () => {});
  client.getRoom = vi.fn(() => ({ hasEncryptionStateEvent: () => false }));
  client.getCrypto = vi.fn(() => undefined);
  return client;
}

let matrixJsClient = createMatrixJsClientStub();

vi.mock("matrix-js-sdk", () => ({
  ClientEvent: { Event: "event" },
  MatrixEventEvent: { Decrypted: "decrypted" },
  createClient: vi.fn(() => matrixJsClient),
}));

import { MatrixClient } from "./sdk.js";

describe("MatrixClient request hardening", () => {
  beforeEach(() => {
    matrixJsClient = createMatrixJsClientStub();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("blocks cross-protocol redirects", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response("", {
        status: 302,
        headers: {
          location: "http://evil.example.org/next",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const client = new MatrixClient("https://matrix.example.org", "token");

    await expect(client.doRequest("GET", "https://matrix.example.org/start")).rejects.toThrow(
      "Blocked cross-protocol redirect",
    );
  });

  it("strips authorization when redirect crosses origin", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        headers: new Headers(init?.headers),
      });
      if (calls.length === 1) {
        return new Response("", {
          status: 302,
          headers: { location: "https://cdn.example.org/next" },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const client = new MatrixClient("https://matrix.example.org", "token");
    await client.doRequest("GET", "https://matrix.example.org/start");

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://matrix.example.org/start");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer token");
    expect(calls[1]?.url).toBe("https://cdn.example.org/next");
    expect(calls[1]?.headers.get("authorization")).toBeNull();
  });

  it("aborts requests after timeout", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_: URL | string, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const client = new MatrixClient("https://matrix.example.org", "token", undefined, undefined, {
      localTimeoutMs: 25,
    });

    const pending = client.doRequest("GET", "/_matrix/client/v3/account/whoami");
    const assertion = expect(pending).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(30);

    await assertion;
  });
});

describe("MatrixClient event bridge", () => {
  beforeEach(() => {
    matrixJsClient = createMatrixJsClientStub();
  });

  it("emits room.message only after encrypted events decrypt", async () => {
    const client = new MatrixClient("https://matrix.example.org", "token");
    const messageEvents: Array<{ roomId: string; type: string }> = [];

    client.on("room.message", (roomId, event) => {
      messageEvents.push({ roomId, type: event.type });
    });

    await client.start();

    const encrypted = new FakeMatrixEvent({
      roomId: "!room:example.org",
      eventId: "$event",
      sender: "@alice:example.org",
      type: "m.room.encrypted",
      ts: Date.now(),
      content: {},
    });
    const decrypted = new FakeMatrixEvent({
      roomId: "!room:example.org",
      eventId: "$event",
      sender: "@alice:example.org",
      type: "m.room.message",
      ts: Date.now(),
      content: {
        msgtype: "m.text",
        body: "hello",
      },
    });

    matrixJsClient.emit("event", encrypted);
    expect(messageEvents).toHaveLength(0);

    encrypted.emit("decrypted", decrypted);
    // Simulate a second normal event emission from the SDK after decryption.
    matrixJsClient.emit("event", decrypted);
    expect(messageEvents).toEqual([
      {
        roomId: "!room:example.org",
        type: "m.room.message",
      },
    ]);
  });

  it("emits room.failed_decryption when decrypting fails", async () => {
    const client = new MatrixClient("https://matrix.example.org", "token");
    const failed: string[] = [];
    const delivered: string[] = [];

    client.on("room.failed_decryption", (_roomId, _event, error) => {
      failed.push(error.message);
    });
    client.on("room.message", (_roomId, event) => {
      delivered.push(event.type);
    });

    await client.start();

    const encrypted = new FakeMatrixEvent({
      roomId: "!room:example.org",
      eventId: "$event",
      sender: "@alice:example.org",
      type: "m.room.encrypted",
      ts: Date.now(),
      content: {},
    });
    const decrypted = new FakeMatrixEvent({
      roomId: "!room:example.org",
      eventId: "$event",
      sender: "@alice:example.org",
      type: "m.room.message",
      ts: Date.now(),
      content: {
        msgtype: "m.text",
        body: "hello",
      },
    });

    matrixJsClient.emit("event", encrypted);
    encrypted.emit("decrypted", decrypted, new Error("decrypt failed"));

    expect(failed).toEqual(["decrypt failed"]);
    expect(delivered).toHaveLength(0);
  });

  it("emits room.invite when a membership invite targets the current user", async () => {
    const client = new MatrixClient("https://matrix.example.org", "token");
    const invites: string[] = [];

    client.on("room.invite", (roomId) => {
      invites.push(roomId);
    });

    await client.start();

    const inviteMembership = new FakeMatrixEvent({
      roomId: "!room:example.org",
      eventId: "$invite",
      sender: "@alice:example.org",
      type: "m.room.member",
      ts: Date.now(),
      stateKey: "@bot:example.org",
      content: {
        membership: "invite",
      },
    });

    matrixJsClient.emit("event", inviteMembership);

    expect(invites).toEqual(["!room:example.org"]);
  });
});
