import { xml } from "@xmpp/client";
import { describe, it, expect, beforeEach } from "vitest";
import { jidMatchesPattern } from "./channel.js";
import { XmppClient } from "./client.js";

// Helper type to access private methods for testing
type XmppClientPrivate = {
  extractMessageContent: (stanza: unknown) => {
    body: string;
    links: Array<{ url?: string; description?: string }>;
  };
  extractMessageReactions: (stanza: unknown) => { id: string; reactions: string[] } | undefined;
  extractThreadInfo: (stanza: unknown) => { thread?: string; parentThread?: string };
  buildXmppMessage: (...args: unknown[]) => unknown;
  validateUploadUrl: (url: string) => void;
  validateContentType: (contentType: string | undefined, blockedTypes?: string[]) => void;
};

describe("XmppClient - Message Parsing", () => {
  let client: XmppClient;

  beforeEach(() => {
    client = new XmppClient({
      jid: "test@example.com",
      password: "password",
      server: "example.com",
    });
  });

  describe("extractMessageContent", () => {
    it("should extract message body", () => {
      const stanza = xml("message", { from: "user@example.com", type: "chat" }, [
        xml("body", {}, "Hello, world!"),
      ]);

      // Access private method via type assertion for testing
      const result = (client as unknown as XmppClientPrivate).extractMessageContent(stanza);

      expect(result.body).toBe("Hello, world!");
      expect(result.links).toEqual([]);
    });

    it("should extract OOB link (XEP-0066)", () => {
      const stanza = xml("message", { from: "user@example.com", type: "chat" }, [
        xml("body", {}, "Check this out"),
        xml("x", { xmlns: "jabber:x:oob" }, [
          xml("url", {}, "https://example.com/image.jpg"),
          xml("desc", {}, "A cool image"),
        ]),
      ]);

      const result = (client as unknown as XmppClientPrivate).extractMessageContent(stanza);

      expect(result.body).toBe("Check this out");
      expect(result.links).toEqual([
        {
          url: "https://example.com/image.jpg",
          description: "A cool image",
        },
      ]);
    });

    it("should handle empty body", () => {
      const stanza = xml("message", { from: "user@example.com", type: "chat" });

      const result = (client as unknown as XmppClientPrivate).extractMessageContent(stanza);

      expect(result.body).toBe("");
      expect(result.links).toEqual([]);
    });

    it("should extract OOB link without description", () => {
      const stanza = xml("message", { from: "user@example.com", type: "chat" }, [
        xml("x", { xmlns: "jabber:x:oob" }, [xml("url", {}, "https://example.com/file.pdf")]),
      ]);

      const result = (client as unknown as XmppClientPrivate).extractMessageContent(stanza);

      expect(result.links).toEqual([
        {
          url: "https://example.com/file.pdf",
          description: undefined,
        },
      ]);
    });
  });

  describe("extractMessageReactions", () => {
    it("should extract reactions (XEP-0444)", () => {
      const stanza = xml("message", { from: "user@example.com", type: "chat" }, [
        xml("reactions", { xmlns: "urn:xmpp:reactions:0", id: "msg-123" }, [
          xml("reaction", {}, "👍"),
          xml("reaction", {}, "❤️"),
        ]),
      ]);

      const result = (client as unknown as XmppClientPrivate).extractMessageReactions(stanza);

      expect(result).toEqual({
        id: "msg-123",
        reactions: ["👍", "❤️"],
      });
    });

    it("should return undefined when no reactions element", () => {
      const stanza = xml("message", { from: "user@example.com", type: "chat" }, [
        xml("body", {}, "Hello"),
      ]);

      const result = (client as unknown as XmppClientPrivate).extractMessageReactions(stanza);

      expect(result).toBeUndefined();
    });

    it("should return undefined when reactions element has no id", () => {
      const stanza = xml("message", { from: "user@example.com", type: "chat" }, [
        xml("reactions", { xmlns: "urn:xmpp:reactions:0" }, [xml("reaction", {}, "👍")]),
      ]);

      const result = (client as unknown as XmppClientPrivate).extractMessageReactions(stanza);

      expect(result).toBeUndefined();
    });

    it("should return undefined when no reaction children", () => {
      const stanza = xml("message", { from: "user@example.com", type: "chat" }, [
        xml("reactions", { xmlns: "urn:xmpp:reactions:0", id: "msg-123" }),
      ]);

      const result = (client as unknown as XmppClientPrivate).extractMessageReactions(stanza);

      expect(result).toBeUndefined();
    });
  });

  describe("extractThreadInfo", () => {
    it("should extract thread information", () => {
      const stanza = xml("message", { from: "user@example.com", type: "chat" }, [
        xml("thread", { parent: "thread-parent" }, "thread-123"),
      ]);

      const result = (client as unknown as XmppClientPrivate).extractThreadInfo(stanza);

      expect(result.thread).toBe("thread-123");
      expect(result.parentThread).toBe("thread-parent");
    });

    it("should extract thread without parent", () => {
      const stanza = xml("message", { from: "user@example.com", type: "chat" }, [
        xml("thread", {}, "thread-456"),
      ]);

      const result = (client as unknown as XmppClientPrivate).extractThreadInfo(stanza);

      expect(result.thread).toBe("thread-456");
      expect(result.parentThread).toBeUndefined();
    });

    it("should return empty object when no thread", () => {
      const stanza = xml("message", { from: "user@example.com", type: "chat" }, [
        xml("body", {}, "Hello"),
      ]);

      const result = (client as unknown as XmppClientPrivate).extractThreadInfo(stanza);

      expect(result.thread).toBeUndefined();
      expect(result.parentThread).toBeUndefined();
    });
  });

  describe("buildXmppMessage", () => {
    it("should build a basic chat message", () => {
      const message = (client as unknown as XmppClientPrivate).buildXmppMessage(
        "user@example.com",
        "bot@example.com",
        "msg-123",
        "chat",
        "Hello",
        [],
        undefined,
        undefined,
        undefined,
      );

      expect(message.id).toBe("msg-123");
      expect(message.from).toBe("user@example.com");
      expect(message.to).toBe("bot@example.com");
      expect(message.body).toBe("Hello");
      expect(message.type).toBe("chat");
      expect(message.timestamp).toBeInstanceOf(Date);
      expect(message.links).toBeUndefined();
      expect(message.reactions).toBeUndefined();
    });

    it("should build a groupchat message with room info", () => {
      const message = (client as unknown as XmppClientPrivate).buildXmppMessage(
        "room@conference.example.com/Nick",
        "bot@example.com",
        "msg-456",
        "groupchat",
        "Hello room",
        [],
        undefined,
        undefined,
        undefined,
      );

      expect(message.type).toBe("groupchat");
      expect(message.roomJid).toBe("room@conference.example.com");
      expect(message.nick).toBe("Nick");
    });

    it("should include links when provided", () => {
      const links = [{ url: "https://example.com/file.pdf", description: "Document" }];
      const message = (client as unknown as XmppClientPrivate).buildXmppMessage(
        "user@example.com",
        "bot@example.com",
        "msg-789",
        "chat",
        "Check this",
        links,
        undefined,
        undefined,
        undefined,
      );

      expect(message.links).toEqual(links);
    });

    it("should include reactions when provided", () => {
      const reactions = { id: "msg-100", reactions: ["👍", "❤️"] };
      const message = (client as unknown as XmppClientPrivate).buildXmppMessage(
        "user@example.com",
        "bot@example.com",
        "msg-200",
        "chat",
        "",
        [],
        reactions,
        undefined,
        undefined,
      );

      expect(message.reactions).toEqual(reactions);
    });

    it("should include thread info when provided", () => {
      const message = (client as unknown as XmppClientPrivate).buildXmppMessage(
        "user@example.com",
        "bot@example.com",
        "msg-300",
        "chat",
        "Reply",
        [],
        undefined,
        "thread-123",
        "thread-parent",
      );

      expect(message.thread).toBe("thread-123");
      expect(message.parentThread).toBe("thread-parent");
    });
  });

  describe("jidMatchesPattern", () => {
    it("should match wildcard pattern", () => {
      expect(jidMatchesPattern("alice@example.com", "*")).toBe(true);
      expect(jidMatchesPattern("bob@other.com", "*")).toBe(true);
    });

    it("should match exact JID", () => {
      expect(jidMatchesPattern("alice@example.com", "alice@example.com")).toBe(true);
      expect(jidMatchesPattern("Alice@Example.COM", "alice@example.com")).toBe(true);
    });

    it("should not match different JIDs", () => {
      expect(jidMatchesPattern("alice@example.com", "bob@example.com")).toBe(false);
      expect(jidMatchesPattern("alice@example.com", "alice@other.com")).toBe(false);
    });

    it("should match domain wildcard", () => {
      expect(jidMatchesPattern("alice@example.com", "*@example.com")).toBe(true);
      expect(jidMatchesPattern("bob@example.com", "*@example.com")).toBe(true);
      expect(jidMatchesPattern("Alice@Example.COM", "*@example.com")).toBe(true);
    });

    it("should not match different domains", () => {
      expect(jidMatchesPattern("alice@other.com", "*@example.com")).toBe(false);
      expect(jidMatchesPattern("bob@subdomain.example.com", "*@example.com")).toBe(false);
    });

    it("should not use substring matching (security)", () => {
      // "alice" should NOT match "malice@example.com"
      expect(jidMatchesPattern("malice@example.com", "alice")).toBe(false);
      // "example.com" should NOT match "notexample.com"
      expect(jidMatchesPattern("user@notexample.com", "example.com")).toBe(false);
      // "example.com" should NOT match "example.com.evil.net"
      expect(jidMatchesPattern("user@example.com.evil.net", "*@example.com")).toBe(false);
    });
  });

  describe("validateUploadUrl (SSRF protection)", () => {
    it("should allow valid HTTPS URLs", () => {
      const client = new XmppClient({
        jid: "test@example.com",
        password: "password",
        server: "example.com",
      });
      // Access private method for testing
      const validate = (client as unknown as XmppClientPrivate).validateUploadUrl.bind(client);

      expect(() => validate("https://upload.example.com/file.jpg")).not.toThrow();
      expect(() => validate("https://cdn.example.com/uploads/test.png")).not.toThrow();
    });

    it("should allow valid HTTP URLs", () => {
      const client = new XmppClient({
        jid: "test@example.com",
        password: "password",
        server: "example.com",
      });
      const validate = (client as unknown as XmppClientPrivate).validateUploadUrl.bind(client);

      expect(() => validate("http://upload.example.com/file.jpg")).not.toThrow();
    });

    it("should block localhost URLs (SSRF)", () => {
      const client = new XmppClient({
        jid: "test@example.com",
        password: "password",
        server: "example.com",
      });
      const validate = (client as unknown as XmppClientPrivate).validateUploadUrl.bind(client);

      expect(() => validate("http://localhost:6379/")).toThrow(/Private\/internal URL not allowed/);
      expect(() => validate("http://127.0.0.1/admin")).toThrow(/Private\/internal URL not allowed/);
      expect(() => validate("http://[::1]/api")).toThrow(/Private\/internal URL not allowed/);
    });

    it("should block private IPv4 ranges (SSRF)", () => {
      const client = new XmppClient({
        jid: "test@example.com",
        password: "password",
        server: "example.com",
      });
      const validate = (client as unknown as XmppClientPrivate).validateUploadUrl.bind(client);

      expect(() => validate("http://10.0.0.1/secret")).toThrow(/Private IPv4 address not allowed/);
      expect(() => validate("http://192.168.1.1/admin")).toThrow(
        /Private IPv4 address not allowed/,
      );
      expect(() => validate("http://172.16.0.1/internal")).toThrow(
        /Private IPv4 address not allowed/,
      );
      expect(() => validate("http://172.31.255.255/data")).toThrow(
        /Private IPv4 address not allowed/,
      );
    });

    it("should block AWS metadata endpoint (SSRF)", () => {
      const client = new XmppClient({
        jid: "test@example.com",
        password: "password",
        server: "example.com",
      });
      const validate = (client as unknown as XmppClientPrivate).validateUploadUrl.bind(client);

      expect(() => validate("http://169.254.169.254/latest/meta-data/")).toThrow(
        /Private\/link-local address not allowed/,
      );
    });

    it("should block private IPv6 ranges (SSRF)", () => {
      const client = new XmppClient({
        jid: "test@example.com",
        password: "password",
        server: "example.com",
      });
      const validate = (client as unknown as XmppClientPrivate).validateUploadUrl.bind(client);

      expect(() => validate("http://[fc00::1]/private")).toThrow(
        /Private\/link-local address not allowed/,
      );
      expect(() => validate("http://[fe80::1]/link-local")).toThrow(
        /Private\/link-local address not allowed/,
      );
    });

    it("should block invalid protocols (SSRF)", () => {
      const client = new XmppClient({
        jid: "test@example.com",
        password: "password",
        server: "example.com",
      });
      const validate = (client as unknown as XmppClientPrivate).validateUploadUrl.bind(client);

      expect(() => validate("file:///etc/passwd")).toThrow(/Invalid protocol/);
      expect(() => validate("ftp://example.com/file")).toThrow(/Invalid protocol/);
      expect(() => validate("gopher://example.com")).toThrow(/Invalid protocol/);
    });

    it("should reject malformed URLs", () => {
      const client = new XmppClient({
        jid: "test@example.com",
        password: "password",
        server: "example.com",
      });
      const validate = (client as unknown as XmppClientPrivate).validateUploadUrl.bind(client);

      expect(() => validate("not-a-url")).toThrow(/Invalid URL format/);
      expect(() => validate("javascript:alert(1)")).toThrow();
    });
  });

  describe("validateContentType (blocked media types)", () => {
    it("should allow safe content types", () => {
      const client = new XmppClient({
        jid: "test@example.com",
        password: "password",
        server: "example.com",
      });
      const validate = (client as unknown as XmppClientPrivate).validateContentType.bind(client);

      expect(() => validate("image/jpeg")).not.toThrow();
      expect(() => validate("image/png")).not.toThrow();
      expect(() => validate("application/pdf")).not.toThrow();
      expect(() => validate("text/plain")).not.toThrow();
      expect(() => validate("video/mp4")).not.toThrow();
    });

    it("should allow undefined content type", () => {
      const client = new XmppClient({
        jid: "test@example.com",
        password: "password",
        server: "example.com",
      });
      const validate = (client as unknown as XmppClientPrivate).validateContentType.bind(client);

      expect(() => validate(undefined)).not.toThrow();
    });

    it("should block dangerous executable types (default list)", () => {
      const client = new XmppClient({
        jid: "test@example.com",
        password: "password",
        server: "example.com",
      });
      const validate = (client as unknown as XmppClientPrivate).validateContentType.bind(client);

      expect(() => validate("application/x-msdownload")).toThrow(/Blocked media type/);
      expect(() => validate("application/x-executable")).toThrow(/Blocked media type/);
      expect(() => validate("application/x-sh")).toThrow(/Blocked media type/);
      expect(() => validate("application/x-bat")).toThrow(/Blocked media type/);
      expect(() => validate("text/x-shellscript")).toThrow(/Blocked media type/);
    });

    it("should be case-insensitive", () => {
      const client = new XmppClient({
        jid: "test@example.com",
        password: "password",
        server: "example.com",
      });
      const validate = (client as unknown as XmppClientPrivate).validateContentType.bind(client);

      expect(() => validate("APPLICATION/X-MSDOWNLOAD")).toThrow(/Blocked media type/);
      expect(() => validate("Application/X-Executable")).toThrow(/Blocked media type/);
    });

    it("should respect custom blocked types", () => {
      const client = new XmppClient({
        jid: "test@example.com",
        password: "password",
        server: "example.com",
      });
      const validate = (client as unknown as XmppClientPrivate).validateContentType.bind(client);

      const customBlocked = ["application/zip", "application/x-rar"];

      expect(() => validate("application/zip", customBlocked)).toThrow(/Blocked media type/);
      expect(() => validate("application/x-rar", customBlocked)).toThrow(/Blocked media type/);
      // Default blocked types should NOT be blocked when custom list is provided
      expect(() => validate("application/x-msdownload", customBlocked)).not.toThrow();
    });

    it("should support wildcard patterns", () => {
      const client = new XmppClient({
        jid: "test@example.com",
        password: "password",
        server: "example.com",
      });
      const validate = (client as unknown as XmppClientPrivate).validateContentType.bind(client);

      const customBlocked = ["application/x-*", "text/*script"];

      expect(() => validate("application/x-anything", customBlocked)).toThrow(/matches pattern/);
      expect(() => validate("application/x-test", customBlocked)).toThrow(/matches pattern/);
      expect(() => validate("text/javascript", customBlocked)).toThrow(/matches pattern/);
      expect(() => validate("text/typescript", customBlocked)).toThrow(/matches pattern/);
      expect(() => validate("application/json", customBlocked)).not.toThrow();
    });
  });
});
