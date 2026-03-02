/**
 * Unit tests for UserbotClient.
 *
 * All GramJS classes are mocked -- no real Telegram connections are made.
 * Tests verify that each method delegates to the correct GramJS call
 * and that errors are wrapped via wrapGramJSError.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the telegram module before importing client
vi.mock("telegram", () => {
  const MockTelegramClient = vi.fn().mockImplementation(function (
    this: Record<string, unknown>,
    session: unknown,
  ) {
    // Store session so getSessionString() can access it
    this.session = session;
  });
  MockTelegramClient.prototype.connect = vi.fn();
  MockTelegramClient.prototype.start = vi.fn();
  MockTelegramClient.prototype.disconnect = vi.fn();
  MockTelegramClient.prototype.getMe = vi.fn();
  MockTelegramClient.prototype.sendMessage = vi.fn();
  MockTelegramClient.prototype.sendFile = vi.fn();
  MockTelegramClient.prototype.editMessage = vi.fn();
  MockTelegramClient.prototype.deleteMessages = vi.fn();
  MockTelegramClient.prototype.forwardMessages = vi.fn();
  MockTelegramClient.prototype.pinMessage = vi.fn();
  MockTelegramClient.prototype.getMessages = vi.fn();
  MockTelegramClient.prototype.invoke = vi.fn();
  MockTelegramClient.prototype.getInputEntity = vi.fn();
  MockTelegramClient.prototype.connected = false;
  return { TelegramClient: MockTelegramClient };
});

vi.mock("telegram/sessions/index.js", () => {
  const MockStringSession = vi.fn();
  MockStringSession.prototype.save = vi.fn().mockReturnValue("saved-session-string");
  return { StringSession: MockStringSession };
});

vi.mock("telegram/tl/index.js", () => {
  // Use class syntax so `new` works in client.ts
  class SendReaction {
    constructor(public params: unknown) {}
  }
  class SetTyping {
    constructor(public params: unknown) {}
  }
  class ReactionEmoji {
    constructor(public params: unknown) {}
  }
  class SendMessageTypingAction {}
  class SendMessageCancelAction {}
  return {
    Api: {
      messages: { SendReaction, SetTyping },
      ReactionEmoji,
      SendMessageTypingAction,
      SendMessageCancelAction,
    },
  };
});

import { UserbotClient } from "./client.js";
import { UserbotDisconnectedError, UserbotError, UserbotFloodError } from "./errors.js";

/** Helper: create a UserbotClient and get the mock GramJS client. */
function createClient() {
  const client = new UserbotClient({ apiId: 12345, apiHash: "abc123" });
  const gram = client.getClient();
  return { client, gram };
}

/** Helper: connect a client (sets internal connected flag). */
async function connectClient(client: UserbotClient): Promise<void> {
  await client.connect();
}

/** Fake GramJS message object. */
function fakeMessage(id: number, date: number) {
  return { id, date, text: "hello", className: "Message" };
}

// Shared cast helper to avoid repetitive type assertions on mocked methods
function mockResolved<T>(fn: (...args: never[]) => Promise<T>, val: unknown) {
  vi.mocked(fn as (...args: never[]) => Promise<unknown>).mockResolvedValueOnce(val);
}

describe("UserbotClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  describe("connect / disconnect", () => {
    it("calls gramClient.connect()", async () => {
      const { client, gram } = createClient();
      await client.connect();
      expect(gram.connect).toHaveBeenCalledOnce();
    });

    it("sets isConnected after connect()", async () => {
      const { client } = createClient();
      expect(client.isConnected()).toBe(false);
      await client.connect();
      expect(client.isConnected()).toBe(true);
    });

    it("calls gramClient.disconnect()", async () => {
      const { client, gram } = createClient();
      await connectClient(client);
      await client.disconnect();
      expect(gram.disconnect).toHaveBeenCalledOnce();
      expect(client.isConnected()).toBe(false);
    });

    it("wraps connect errors", async () => {
      const { client, gram } = createClient();
      vi.mocked(gram.connect).mockRejectedValueOnce(new Error("connection refused"));
      await expect(client.connect()).rejects.toThrow(UserbotError);
    });
  });

  describe("connectInteractive", () => {
    it("calls gramClient.start with correct params", async () => {
      const { client, gram } = createClient();
      await client.connectInteractive({
        apiId: 12345,
        apiHash: "abc123",
        phone: "+1234567890",
        codeCallback: vi.fn().mockResolvedValue("12345"),
        passwordCallback: vi.fn().mockResolvedValue("pass"),
      });
      expect(gram.start).toHaveBeenCalledOnce();
      expect(client.isConnected()).toBe(true);
    });

    it("wraps start errors", async () => {
      const { client, gram } = createClient();
      vi.mocked(gram.start).mockRejectedValueOnce(new Error("PHONE_CODE_INVALID"));
      await expect(
        client.connectInteractive({
          apiId: 12345,
          apiHash: "abc123",
          phone: "+1234567890",
          codeCallback: vi.fn(),
        }),
      ).rejects.toThrow(UserbotError);
    });
  });

  // -------------------------------------------------------------------------
  // Session & user info
  // -------------------------------------------------------------------------

  describe("getSessionString", () => {
    it("returns the saved session string", () => {
      const { client } = createClient();
      expect(client.getSessionString()).toBe("saved-session-string");
    });
  });

  describe("getMe", () => {
    it("delegates to gramClient.getMe()", async () => {
      const { client, gram } = createClient();
      await connectClient(client);
      const fakeUser = { id: 267619672, firstName: "Test", username: "testuser" };
      mockResolved(gram.getMe, fakeUser);
      const me = await client.getMe();
      expect(me).toBe(fakeUser);
      expect(gram.getMe).toHaveBeenCalledOnce();
    });

    it("throws UserbotDisconnectedError when not connected", async () => {
      const { client } = createClient();
      await expect(client.getMe()).rejects.toThrow(UserbotDisconnectedError);
    });
  });

  describe("getClient", () => {
    it("returns the underlying TelegramClient", () => {
      const { client, gram } = createClient();
      expect(client.getClient()).toBe(gram);
    });
  });

  // -------------------------------------------------------------------------
  // Message operations
  // -------------------------------------------------------------------------

  describe("sendMessage", () => {
    it("delegates to gramClient.sendMessage with correct args", async () => {
      const { client, gram } = createClient();
      await connectClient(client);

      const mockPeer = { className: "InputPeerUser" };
      mockResolved(gram.getInputEntity, mockPeer);
      mockResolved(gram.sendMessage, fakeMessage(42, 1700000000));

      const result = await client.sendMessage(12345, "hello", { replyTo: 10 });
      expect(result).toEqual({ messageId: 42, date: 1700000000 });
      expect(gram.sendMessage).toHaveBeenCalledWith(mockPeer, {
        message: "hello",
        replyTo: 10,
        parseMode: undefined,
      });
    });

    it("throws when not connected", async () => {
      const { client } = createClient();
      await expect(client.sendMessage(12345, "hello")).rejects.toThrow(UserbotDisconnectedError);
    });

    it("wraps GramJS FloodWaitError", async () => {
      const { client, gram } = createClient();
      await connectClient(client);

      mockResolved(gram.getInputEntity, {});
      class FloodWaitError extends Error {
        seconds = 30;
        constructor() {
          super("FLOOD_WAIT_30");
        }
      }
      vi.mocked(gram.sendMessage).mockRejectedValueOnce(new FloodWaitError());

      await expect(client.sendMessage(12345, "hello")).rejects.toThrow(UserbotFloodError);
    });
  });

  describe("sendFile", () => {
    it("delegates to gramClient.sendFile", async () => {
      const { client, gram } = createClient();
      await connectClient(client);

      const mockPeer = { className: "InputPeerUser" };
      mockResolved(gram.getInputEntity, mockPeer);
      mockResolved(gram.sendFile, fakeMessage(43, 1700000001));

      const fileBuffer = Buffer.from("test");
      const result = await client.sendFile(12345, fileBuffer, {
        caption: "photo",
        forceDocument: true,
      });
      expect(result).toEqual({ messageId: 43, date: 1700000001 });
      expect(gram.sendFile).toHaveBeenCalledWith(mockPeer, {
        file: fileBuffer,
        caption: "photo",
        forceDocument: true,
        voiceNote: undefined,
        replyTo: undefined,
        parseMode: undefined,
      });
    });
  });

  describe("editMessage", () => {
    it("delegates to gramClient.editMessage", async () => {
      const { client, gram } = createClient();
      await connectClient(client);

      const mockPeer = { className: "InputPeerUser" };
      mockResolved(gram.getInputEntity, mockPeer);
      mockResolved(gram.editMessage, fakeMessage(42, 1700000000));

      await client.editMessage(12345, 42, "updated text");
      expect(gram.editMessage).toHaveBeenCalledWith(mockPeer, {
        message: 42,
        text: "updated text",
      });
    });
  });

  describe("deleteMessages", () => {
    it("revokes by default", async () => {
      const { client, gram } = createClient();
      await connectClient(client);

      const mockPeer = { className: "InputPeerUser" };
      mockResolved(gram.getInputEntity, mockPeer);
      mockResolved(gram.deleteMessages, undefined);

      await client.deleteMessages(12345, [42, 43]);
      expect(gram.deleteMessages).toHaveBeenCalledWith(mockPeer, [42, 43], {
        revoke: true,
      });
    });

    it("respects revoke=false", async () => {
      const { client, gram } = createClient();
      await connectClient(client);

      mockResolved(gram.getInputEntity, {});
      mockResolved(gram.deleteMessages, undefined);

      await client.deleteMessages(12345, [42], false);
      expect(gram.deleteMessages).toHaveBeenCalledWith({}, [42], {
        revoke: false,
      });
    });
  });

  describe("forwardMessages", () => {
    it("delegates to gramClient.forwardMessages", async () => {
      const { client, gram } = createClient();
      await connectClient(client);

      const fromPeer = { className: "InputPeerUser", userId: 111 };
      const toPeer = { className: "InputPeerUser", userId: 222 };
      mockResolved(gram.getInputEntity, fromPeer);
      mockResolved(gram.getInputEntity, toPeer);
      mockResolved(gram.forwardMessages, undefined);

      await client.forwardMessages(111, 222, [42, 43]);
      expect(gram.forwardMessages).toHaveBeenCalledWith(toPeer, {
        messages: [42, 43],
        fromPeer,
      });
    });
  });

  describe("reactToMessage", () => {
    it("invokes SendReaction", async () => {
      const { client, gram } = createClient();
      await connectClient(client);

      mockResolved(gram.getInputEntity, {});
      mockResolved(gram.invoke, undefined);

      await client.reactToMessage(12345, 42, "thumbsup");
      expect(gram.invoke).toHaveBeenCalledOnce();
    });
  });

  describe("pinMessage", () => {
    it("delegates to gramClient.pinMessage", async () => {
      const { client, gram } = createClient();
      await connectClient(client);

      const mockPeer = { className: "InputPeerUser" };
      mockResolved(gram.getInputEntity, mockPeer);
      mockResolved(gram.pinMessage, undefined);

      await client.pinMessage(12345, 42);
      expect(gram.pinMessage).toHaveBeenCalledWith(mockPeer, 42);
    });
  });

  describe("getHistory", () => {
    it("uses default limit of 20", async () => {
      const { client, gram } = createClient();
      await connectClient(client);

      const msgs = [fakeMessage(1, 1700000000), fakeMessage(2, 1700000001)];
      mockResolved(gram.getInputEntity, {});
      mockResolved(gram.getMessages, msgs);

      const result = await client.getHistory(12345);
      expect(result).toHaveLength(2);
      expect(gram.getMessages).toHaveBeenCalledWith({}, { limit: 20 });
    });

    it("respects custom limit", async () => {
      const { client, gram } = createClient();
      await connectClient(client);

      mockResolved(gram.getInputEntity, {});
      mockResolved(gram.getMessages, []);

      await client.getHistory(12345, 5);
      expect(gram.getMessages).toHaveBeenCalledWith({}, { limit: 5 });
    });
  });

  describe("setTyping", () => {
    it("invokes SetTyping with default action", async () => {
      const { client, gram } = createClient();
      await connectClient(client);

      mockResolved(gram.getInputEntity, {});
      mockResolved(gram.invoke, undefined);

      await client.setTyping(12345);
      expect(gram.invoke).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Error wrapping across operations
  // -------------------------------------------------------------------------

  describe("error wrapping", () => {
    it("wraps errors from sendFile", async () => {
      const { client, gram } = createClient();
      await connectClient(client);

      mockResolved(gram.getInputEntity, {});
      vi.mocked(gram.sendFile).mockRejectedValueOnce(new Error("upload failed"));

      await expect(client.sendFile(12345, Buffer.from("x"))).rejects.toThrow(UserbotError);
    });

    it("wraps errors from editMessage", async () => {
      const { client, gram } = createClient();
      await connectClient(client);

      mockResolved(gram.getInputEntity, {});
      vi.mocked(gram.editMessage).mockRejectedValueOnce(new Error("MESSAGE_NOT_MODIFIED"));

      await expect(client.editMessage(12345, 42, "same")).rejects.toThrow(UserbotError);
    });

    it("wraps errors from deleteMessages", async () => {
      const { client, gram } = createClient();
      await connectClient(client);

      mockResolved(gram.getInputEntity, {});
      vi.mocked(gram.deleteMessages).mockRejectedValueOnce(new Error("MESSAGE_DELETE_FORBIDDEN"));

      await expect(client.deleteMessages(12345, [42])).rejects.toThrow(UserbotError);
    });
  });
});
