import { describe, expect, it } from "vitest";
import type { MessageData } from "./types.js";
import {
  extractDmAddressFromSessionKey,
  extractGroupIdFromSessionKey,
  extractTopicFromSessionKey,
  genTopicHash,
  isControlMessage,
  isDisplayableMessage,
  nknToInbound,
  parseNknPayload,
  receiptToNkn,
  stripNknSubClientPrefix,
  textToNkn,
} from "./wire.js";

describe("genTopicHash", () => {
  it("generates topic hash with dchat prefix", () => {
    const hash = genTopicHash("general");
    expect(hash).toMatch(/^dchat[0-9a-f]{40}$/);
  });

  it("strips leading # characters", () => {
    expect(genTopicHash("#general")).toBe(genTopicHash("general"));
    expect(genTopicHash("##general")).toBe(genTopicHash("general"));
  });

  it("produces consistent hashes", () => {
    expect(genTopicHash("d-chat")).toBe(genTopicHash("d-chat"));
  });

  it("produces different hashes for different topics", () => {
    expect(genTopicHash("alpha")).not.toBe(genTopicHash("beta"));
  });
});

describe("parseNknPayload", () => {
  it("parses valid JSON message", () => {
    const msg: MessageData = {
      id: "test-123",
      contentType: "text",
      content: "hello",
      timestamp: Date.now(),
    };
    const result = parseNknPayload(JSON.stringify(msg));
    expect(result).toEqual(msg);
  });

  it("returns null for invalid JSON", () => {
    expect(parseNknPayload("not json")).toBeNull();
  });

  it("returns null for missing required fields", () => {
    expect(parseNknPayload(JSON.stringify({ id: "test" }))).toBeNull();
    expect(parseNknPayload(JSON.stringify({ contentType: "text" }))).toBeNull();
  });

  it("returns null for non-object values", () => {
    expect(parseNknPayload(JSON.stringify(42))).toBeNull();
    expect(parseNknPayload(JSON.stringify(null))).toBeNull();
  });
});

describe("isControlMessage / isDisplayableMessage", () => {
  it("identifies control messages", () => {
    expect(isControlMessage("receipt")).toBe(true);
    expect(isControlMessage("read")).toBe(true);
    expect(isControlMessage("contact")).toBe(true);
    expect(isControlMessage("topic:subscribe")).toBe(true);
    expect(isControlMessage("discovery:broadcast")).toBe(true);
  });

  it("identifies displayable messages", () => {
    expect(isDisplayableMessage("text")).toBe(true);
    expect(isDisplayableMessage("textExtension")).toBe(true);
    expect(isDisplayableMessage("ipfs")).toBe(true);
    expect(isDisplayableMessage("audio")).toBe(true);
  });

  it("control messages are not displayable", () => {
    expect(isDisplayableMessage("receipt")).toBe(false);
    expect(isControlMessage("text")).toBe(false);
  });
});

describe("nknToInbound", () => {
  const selfAddr = "self-address-abc123";

  it("translates direct text message", () => {
    const msg: MessageData = {
      id: "msg-1",
      contentType: "text",
      content: "Hello from NKN",
      timestamp: Date.now(),
    };
    const result = nknToInbound("sender-addr-xyz789", msg, selfAddr);
    expect(result).not.toBeNull();
    expect(result!.body).toBe("Hello from NKN");
    expect(result!.chatType).toBe("direct");
    expect(result!.sessionKey).toBe("dchat:dm:sender-addr-xyz789");
    expect(result!.senderId).toBe("sender-addr-xyz789");
  });

  it("scopes DM session key to account identity", () => {
    const msg: MessageData = {
      id: "msg-acct",
      contentType: "text",
      content: "multi-account test",
      timestamp: Date.now(),
    };
    const result = nknToInbound("sender-addr", msg, selfAddr, { accountId: "work" });
    expect(result!.sessionKey).toBe("dchat:work:dm:sender-addr");

    // default account omits the account prefix for backwards compat
    const resultDefault = nknToInbound("sender-addr", msg, selfAddr, { accountId: "default" });
    expect(resultDefault!.sessionKey).toBe("dchat:dm:sender-addr");

    // no accountId also omits prefix
    const resultNone = nknToInbound("sender-addr", msg, selfAddr);
    expect(resultNone!.sessionKey).toBe("dchat:dm:sender-addr");
  });

  it("translates topic message", () => {
    const msg: MessageData = {
      id: "msg-2",
      contentType: "text",
      content: "Hello topic",
      topic: "general",
      timestamp: Date.now(),
    };
    const result = nknToInbound("sender-addr", msg, selfAddr);
    expect(result).not.toBeNull();
    expect(result!.chatType).toBe("group");
    expect(result!.sessionKey).toBe("dchat:topic:general");
    expect(result!.groupSubject).toBe("#general");
  });

  it("translates IPFS image message", () => {
    const msg: MessageData = {
      id: "msg-3",
      contentType: "ipfs",
      content: "QmXyz...",
      options: { fileType: 1, ipfsHash: "QmXyz..." },
      timestamp: Date.now(),
    };
    const result = nknToInbound("sender", msg, selfAddr);
    expect(result).not.toBeNull();
    expect(result!.body).toBe("[Image]");
    expect(result!.ipfsHash).toBe("QmXyz...");
  });

  it("translates IPFS file message", () => {
    const msg: MessageData = {
      id: "msg-4",
      contentType: "ipfs",
      content: "QmAbc...",
      options: { fileType: 0, fileName: "report.pdf" },
      timestamp: Date.now(),
    };
    const result = nknToInbound("sender", msg, selfAddr);
    expect(result!.body).toBe("[File: report.pdf]");
  });

  it("translates audio message", () => {
    const msg: MessageData = {
      id: "msg-5",
      contentType: "audio",
      content: "base64data...",
      timestamp: Date.now(),
    };
    const result = nknToInbound("sender", msg, selfAddr);
    expect(result!.body).toBe("[Voice Message]");
  });

  it("returns null for control messages", () => {
    const receipt: MessageData = {
      id: "msg-6",
      contentType: "receipt",
      targetID: "msg-1",
      timestamp: Date.now(),
    };
    expect(nknToInbound("sender", receipt, selfAddr)).toBeNull();

    const readReceipt: MessageData = {
      id: "msg-7",
      contentType: "read",
      readIds: ["msg-1"],
      timestamp: Date.now(),
    };
    expect(nknToInbound("sender", readReceipt, selfAddr)).toBeNull();
  });

  it("handles textExtension content type", () => {
    const msg: MessageData = {
      id: "msg-8",
      contentType: "textExtension",
      content: "burn after read message",
      options: { deleteAfterSeconds: 3600 },
      timestamp: Date.now(),
    };
    const result = nknToInbound("sender", msg, selfAddr);
    expect(result!.body).toBe("burn after read message");
  });
});

describe("textToNkn", () => {
  it("creates text MessageData", () => {
    const msg = textToNkn("Hello world");
    expect(msg.contentType).toBe("text");
    expect(msg.content).toBe("Hello world");
    expect(msg.id).toBeTruthy();
    expect(msg.timestamp).toBeGreaterThan(0);
    expect(msg.topic).toBeUndefined();
  });

  it("sets topic field for topic messages", () => {
    const msg = textToNkn("Hello topic", { topic: "general" });
    expect(msg.topic).toBe("general");
  });

  it("sets groupId for group messages", () => {
    const msg = textToNkn("Hello group", { groupId: "group-123" });
    expect(msg.groupId).toBe("group-123");
  });
});

describe("receiptToNkn", () => {
  it("creates receipt MessageData", () => {
    const msg = receiptToNkn("original-msg-id");
    expect(msg.contentType).toBe("receipt");
    expect(msg.targetID).toBe("original-msg-id");
  });
});

describe("session key extractors", () => {
  it("extracts topic from session key", () => {
    expect(extractTopicFromSessionKey("dchat:topic:general")).toBe("general");
    expect(extractTopicFromSessionKey("dchat:dm:addr")).toBeUndefined();
  });

  it("extracts group ID from session key", () => {
    expect(extractGroupIdFromSessionKey("dchat:group:abc123")).toBe("abc123");
    expect(extractGroupIdFromSessionKey("dchat:dm:addr")).toBeUndefined();
  });

  it("extracts DM address from session key", () => {
    expect(extractDmAddressFromSessionKey("dchat:dm:some-nkn-addr")).toBe("some-nkn-addr");
    expect(extractDmAddressFromSessionKey("dchat:topic:general")).toBeUndefined();
  });

  it("extracts DM address from account-scoped session key", () => {
    expect(extractDmAddressFromSessionKey("dchat:work:dm:some-nkn-addr")).toBe("some-nkn-addr");
  });
});

describe("stripNknSubClientPrefix", () => {
  it("strips __N__. prefix", () => {
    expect(stripNknSubClientPrefix("__0__.cd3530abcdef")).toBe("cd3530abcdef");
    expect(stripNknSubClientPrefix("__3__.cd3530abcdef")).toBe("cd3530abcdef");
    expect(stripNknSubClientPrefix("__12__.cd3530abcdef")).toBe("cd3530abcdef");
  });

  it("leaves plain addresses unchanged", () => {
    expect(stripNknSubClientPrefix("cd3530abcdef")).toBe("cd3530abcdef");
  });
});
