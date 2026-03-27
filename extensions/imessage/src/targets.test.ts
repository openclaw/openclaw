import { beforeEach, describe, expect, it, vi } from "vitest";
import * as processRuntime from "../../../src/plugin-sdk/process-runtime.js";
import * as setupRuntime from "../../../src/plugin-sdk/setup.js";
import * as clientModule from "./client.js";
import {
  resolveIMessageGroupRequireMention,
  resolveIMessageGroupToolPolicy,
} from "./group-policy.js";
import { probeIMessage } from "./probe.js";
import { parseIMessageAllowFromEntries } from "./setup-surface.js";
import {
  formatIMessageChatTarget,
  inferIMessageTargetChatType,
  isAllowedIMessageSender,
  looksLikeIMessageExplicitTargetId,
  normalizeIMessageHandle,
  parseIMessageTarget,
} from "./targets.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: unknown[]) => spawnMock(...args),
  };
});

describe("imessage targets", () => {
  it("parses chat_id targets", () => {
    const target = parseIMessageTarget("chat_id:123");
    expect(target).toEqual({ kind: "chat_id", chatId: 123 });
  });

  it("parses chat targets", () => {
    const target = parseIMessageTarget("chat:456");
    expect(target).toEqual({ kind: "chat_id", chatId: 456 });
  });

  it("parses sms handles with service", () => {
    const target = parseIMessageTarget("sms:+1555");
    expect(target).toEqual({ kind: "handle", to: "+1555", service: "sms" });
  });

  it("normalizes handles", () => {
    expect(normalizeIMessageHandle("Name@Example.com")).toBe("name@example.com");
    expect(normalizeIMessageHandle(" +1 (555) 222-3333 ")).toBe("+15552223333");
  });

  it("normalizes chat_id prefixes case-insensitively", () => {
    expect(normalizeIMessageHandle("CHAT_ID:123")).toBe("chat_id:123");
    expect(normalizeIMessageHandle("Chat_Id:456")).toBe("chat_id:456");
    expect(normalizeIMessageHandle("chatid:789")).toBe("chat_id:789");
    expect(normalizeIMessageHandle("CHAT:42")).toBe("chat_id:42");
  });

  it("normalizes chat_guid prefixes case-insensitively", () => {
    expect(normalizeIMessageHandle("CHAT_GUID:abc-def")).toBe("chat_guid:abc-def");
    expect(normalizeIMessageHandle("ChatGuid:XYZ")).toBe("chat_guid:XYZ");
    expect(normalizeIMessageHandle("GUID:test-guid")).toBe("chat_guid:test-guid");
  });

  it("normalizes chat_identifier prefixes case-insensitively", () => {
    expect(normalizeIMessageHandle("CHAT_IDENTIFIER:iMessage;-;chat123")).toBe(
      "chat_identifier:iMessage;-;chat123",
    );
    expect(normalizeIMessageHandle("ChatIdentifier:test")).toBe("chat_identifier:test");
    expect(normalizeIMessageHandle("CHATIDENT:foo")).toBe("chat_identifier:foo");
  });

  it("checks allowFrom against chat_id", () => {
    const ok = isAllowedIMessageSender({
      allowFrom: ["chat_id:9"],
      sender: "+1555",
      chatId: 9,
    });
    expect(ok).toBe(true);
  });

  it("checks allowFrom against handle", () => {
    const ok = isAllowedIMessageSender({
      allowFrom: ["user@example.com"],
      sender: "User@Example.com",
    });
    expect(ok).toBe(true);
  });

  it("denies when allowFrom is empty", () => {
    const ok = isAllowedIMessageSender({
      allowFrom: [],
      sender: "+1555",
    });
    expect(ok).toBe(false);
  });

  it("formats chat targets", () => {
    expect(formatIMessageChatTarget(42)).toBe("chat_id:42");
    expect(formatIMessageChatTarget(undefined)).toBe("");
  });

  it("only treats explicit chat targets as immediate ids", () => {
    expect(looksLikeIMessageExplicitTargetId("chat_id:42")).toBe(true);
    expect(looksLikeIMessageExplicitTargetId("sms:+15552223333")).toBe(true);
    expect(looksLikeIMessageExplicitTargetId("+15552223333")).toBe(false);
    expect(looksLikeIMessageExplicitTargetId("user@example.com")).toBe(false);
  });

  it("infers direct and group chat types from normalized targets", () => {
    expect(inferIMessageTargetChatType("+15552223333")).toBe("direct");
    expect(inferIMessageTargetChatType("chat_id:42")).toBe("group");
  });
});

describe("createIMessageRpcClient", () => {
  beforeEach(() => {
    spawnMock.mockClear();
    vi.stubEnv("VITEST", "true");
  });

  it("refuses to spawn imsg rpc in test environments", async () => {
    const { createIMessageRpcClient } = await import("./client.js");
    await expect(createIMessageRpcClient()).rejects.toThrow(
      /Refusing to start imsg rpc in test environment/i,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("imessage group policy", () => {
  it("uses generic channel group policy helpers", () => {
    const cfg = {
      channels: {
        imessage: {
          groups: {
            "chat:family": {
              requireMention: false,
              tools: { deny: ["exec"] },
            },
            "*": {
              requireMention: true,
              tools: { allow: ["message.send"] },
            },
          },
        },
      },
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any;

    expect(resolveIMessageGroupRequireMention({ cfg, groupId: "chat:family" })).toBe(false);
    expect(resolveIMessageGroupRequireMention({ cfg, groupId: "chat:other" })).toBe(true);
    expect(resolveIMessageGroupToolPolicy({ cfg, groupId: "chat:family" })).toEqual({
      deny: ["exec"],
    });
    expect(resolveIMessageGroupToolPolicy({ cfg, groupId: "chat:other" })).toEqual({
      allow: ["message.send"],
    });
  });
});

describe("parseIMessageAllowFromEntries", () => {
  it("parses handles and chat targets", () => {
    expect(parseIMessageAllowFromEntries("+15555550123, chat_id:123, chat_guid:abc")).toEqual({
      entries: ["+15555550123", "chat_id:123", "chat_guid:abc"],
    });
  });

  it("returns validation errors for invalid chat_id", () => {
    expect(parseIMessageAllowFromEntries("chat_id:abc")).toEqual({
      entries: [],
      error: "Invalid chat_id: chat_id:abc",
    });
  });

  it("returns validation errors for invalid chat_identifier entries", () => {
    expect(parseIMessageAllowFromEntries("chat_identifier:")).toEqual({
      entries: [],
      error: "Invalid chat_identifier entry",
    });
  });
});

describe("probeIMessage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(setupRuntime, "detectBinary").mockResolvedValue(true);
    vi.spyOn(processRuntime, "runCommandWithTimeout").mockResolvedValue({
      stdout: "",
      stderr: 'unknown command "rpc" for "imsg"',
      code: 1,
      signal: null,
      killed: false,
      termination: "exit",
    });
  });

  it("marks unknown rpc subcommand as fatal", async () => {
    const createIMessageRpcClientMock = vi
      .spyOn(clientModule, "createIMessageRpcClient")
      .mockResolvedValue({
        request: vi.fn(),
        stop: vi.fn(),
      } as unknown as Awaited<ReturnType<typeof clientModule.createIMessageRpcClient>>);
    const result = await probeIMessage(1000, { cliPath: "imsg-test-rpc" });
    expect(result.ok).toBe(false);
    expect(result.fatal).toBe(true);
    expect(result.error).toMatch(/rpc/i);
    expect(createIMessageRpcClientMock).not.toHaveBeenCalled();
  });
});
