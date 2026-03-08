import type { ChannelAccountSnapshot, OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  extractNapCatInboundMessage,
  isNapCatGroupMessageAllowed,
  isNapCatEventMentioningSelf,
  normalizeNapCatAllowFrom,
  processNapCatEvent,
  resolveNapCatCommandAuthorized,
  resolveNapCatGroupConfig,
} from "./inbound.js";
import { setNapCatRuntime } from "./runtime.js";
import type { ResolvedNapCatAccount } from "./types.js";

describe("extractNapCatInboundMessage", () => {
  it("extracts text and image urls from segments", () => {
    const result = extractNapCatInboundMessage({
      post_type: "message",
      message_type: "group",
      message_id: 100,
      user_id: 123,
      group_id: 456,
      self_id: 789,
      time: 1_700_000_000,
      sender: { nickname: "Alice" },
      message: [
        { type: "text", data: { text: "hello " } },
        { type: "image", data: { url: "https://example.com/a.png" } },
        { type: "text", data: { text: "world" } },
      ],
    });

    expect(result).toBeTruthy();
    expect(result?.isGroup).toBe(true);
    expect(result?.senderId).toBe("123");
    expect(result?.targetId).toBe("456");
    expect(result?.rawBody).toBe("hello world");
    expect(result?.mediaUrls).toEqual(["https://example.com/a.png"]);
  });

  it("returns null for non-message events", () => {
    const result = extractNapCatInboundMessage({
      post_type: "meta_event",
      message_type: "group",
    });
    expect(result).toBeNull();
  });

  it("extracts CQ image urls when inbound message is a CQ string", () => {
    const result = extractNapCatInboundMessage({
      post_type: "message",
      message_type: "private",
      message_id: 101,
      user_id: 123,
      self_id: 789,
      time: 1_700_000_001,
      message:
        "[CQ:image,file=placeholder.image,url=https://example.com/a.png][CQ:image,file=https://example.com/b.png]",
    });

    expect(result).toBeTruthy();
    expect(result?.rawBody).toBe(
      "[CQ:image,file=placeholder.image,url=https://example.com/a.png][CQ:image,file=https://example.com/b.png]",
    );
    expect(result?.mediaUrls).toEqual(["https://example.com/a.png", "https://example.com/b.png"]);
  });

  it("extracts CQ image urls from raw_message fallback", () => {
    const result = extractNapCatInboundMessage({
      post_type: "message",
      message_type: "private",
      message_id: 102,
      user_id: 123,
      self_id: 789,
      time: 1_700_000_002,
      raw_message: "[CQ:image,url=https://example.com/from-raw.png]",
    });

    expect(result).toBeTruthy();
    expect(result?.rawBody).toBe("[CQ:image,url=https://example.com/from-raw.png]");
    expect(result?.mediaUrls).toEqual(["https://example.com/from-raw.png"]);
  });

  it("normalizes commandBody by stripping CQ at-mentions from string payloads", () => {
    const result = extractNapCatInboundMessage({
      post_type: "message",
      message_type: "private",
      message_id: 103,
      user_id: 123,
      self_id: 789,
      time: 1_700_000_003,
      message: "[CQ:at,qq=789]/status",
    });

    expect(result).toBeTruthy();
    expect(result?.rawBody).toBe("[CQ:at,qq=789]/status");
    expect(result?.commandBody).toBe("/status");
  });
});

describe("isNapCatEventMentioningSelf", () => {
  it("detects @self mention", () => {
    const result = isNapCatEventMentioningSelf({
      self_id: 10001,
      message: [{ type: "at", data: { qq: "10001" } }],
    });
    expect(result).toBe(true);
  });

  it("returns false without mention", () => {
    const result = isNapCatEventMentioningSelf({
      self_id: 10001,
      message: [{ type: "text", data: { text: "hi" } }],
    });
    expect(result).toBe(false);
  });

  it("detects CQ mention when message is string", () => {
    const result = isNapCatEventMentioningSelf({
      self_id: 10001,
      message: "[CQ:at,qq=10001] hello",
    });
    expect(result).toBe(true);
  });

  it("detects CQ mention with extra params", () => {
    const result = isNapCatEventMentioningSelf({
      self_id: 10001,
      message: "[CQ:at,qq=10001,name=bot] hello",
    });
    expect(result).toBe(true);
  });

  it("detects CQ @all mention with extra params", () => {
    const result = isNapCatEventMentioningSelf({
      self_id: 10001,
      message: "[CQ:at,name=all,qq=all] hello",
    });
    expect(result).toBe(true);
  });
});

describe("normalizeNapCatAllowFrom", () => {
  it("normalizes and deduplicates entries", () => {
    expect(normalizeNapCatAllowFrom(["qq:user:1", "1", " group:2 "])).toEqual(["1", "2"]);
  });
});

describe("resolveNapCatGroupConfig", () => {
  it("applies wildcard defaults when exact group omits fields", () => {
    const result = resolveNapCatGroupConfig({
      groupId: "123",
      groups: {
        "*": {
          requireMention: false,
          allowFrom: ["111"],
        },
        "123": {
          allow: true,
        },
      },
    });

    expect(result).toEqual({
      matched: true,
      allow: true,
      requireMention: false,
      allowFrom: ["111"],
      enabled: undefined,
    });
  });
});

describe("isNapCatGroupMessageAllowed", () => {
  it("allows unmatched groups when groupPolicy is allowlist", () => {
    const allowed = isNapCatGroupMessageAllowed({
      groupId: "999",
      groupPolicy: "allowlist",
      groups: {
        "123": { allow: true },
      },
    });
    expect(allowed).toBe(true);
  });

  it("allows unmatched groups when groupPolicy is open", () => {
    const allowed = isNapCatGroupMessageAllowed({
      groupId: "999",
      groupPolicy: "open",
      groups: {
        "123": { allow: true },
      },
    });
    expect(allowed).toBe(true);
  });

  it("blocks unmatched groups when groupPolicy is disabled", () => {
    const allowed = isNapCatGroupMessageAllowed({
      groupId: "999",
      groupPolicy: "disabled",
      groups: {
        "123": { allow: true },
      },
    });
    expect(allowed).toBe(false);
  });

  it("blocks when wildcard group config disables all groups", () => {
    const allowed = isNapCatGroupMessageAllowed({
      groupId: "999",
      groupPolicy: "open",
      groups: {
        "*": { allow: false },
      },
    });
    expect(allowed).toBe(false);
  });

  it("blocks when exact group config disables the group", () => {
    const allowed = isNapCatGroupMessageAllowed({
      groupId: "999",
      groupPolicy: "open",
      groups: {
        "999": { allow: false },
      },
    });
    expect(allowed).toBe(false);
  });
});

describe("resolveNapCatCommandAuthorized", () => {
  it("returns undefined when command auth should not be computed", () => {
    const resolveFromAuthorizers = vi.fn(() => false);
    const result = resolveNapCatCommandAuthorized({
      cfg: {} as OpenClawConfig,
      rawBody: "hello",
      senderId: "123",
      isGroup: false,
      configuredAllowFrom: [],
      configuredGroupAllowFrom: [],
      effectiveAllowFrom: ["123"],
      effectiveGroupAllowFrom: [],
      shouldComputeCommandAuthorized: () => false,
      resolveCommandAuthorizedFromAuthorizers: resolveFromAuthorizers,
    });
    expect(result).toBeUndefined();
    expect(resolveFromAuthorizers).not.toHaveBeenCalled();
  });

  it("resolves authorization from effective allowlists when command auth is required", () => {
    const resolveFromAuthorizers = vi.fn(() => false);
    const result = resolveNapCatCommandAuthorized({
      cfg: {} as OpenClawConfig,
      rawBody: "/status",
      senderId: "999",
      isGroup: false,
      configuredAllowFrom: [],
      configuredGroupAllowFrom: [],
      effectiveAllowFrom: ["123"],
      effectiveGroupAllowFrom: ["456"],
      shouldComputeCommandAuthorized: () => true,
      resolveCommandAuthorizedFromAuthorizers: resolveFromAuthorizers,
    });

    expect(result).toBe(false);
    expect(resolveFromAuthorizers).toHaveBeenCalledWith({
      useAccessGroups: true,
      authorizers: [
        { configured: true, allowed: false },
        { configured: true, allowed: false },
      ],
    });
  });

  it("uses configured allowlists for group command auth", () => {
    const resolveFromAuthorizers = vi.fn(() => false);
    const result = resolveNapCatCommandAuthorized({
      cfg: {} as OpenClawConfig,
      rawBody: "/status",
      senderId: "999",
      isGroup: true,
      configuredAllowFrom: [],
      configuredGroupAllowFrom: [],
      effectiveAllowFrom: ["999"],
      effectiveGroupAllowFrom: [],
      shouldComputeCommandAuthorized: () => true,
      resolveCommandAuthorizedFromAuthorizers: resolveFromAuthorizers,
    });

    expect(result).toBe(false);
    expect(resolveFromAuthorizers).toHaveBeenCalledWith({
      useAccessGroups: true,
      authorizers: [
        { configured: false, allowed: false },
        { configured: false, allowed: false },
      ],
    });
  });
});

describe("processNapCatEvent", () => {
  const baseAccount: ResolvedNapCatAccount = {
    accountId: "default",
    enabled: true,
    configured: true,
    token: "token",
    tokenSource: "config",
    apiBaseUrl: "http://127.0.0.1:3000",
    apiBaseUrlSource: "config",
    config: {},
    transport: {
      http: {
        enabled: false,
        host: "127.0.0.1",
        port: 5715,
        path: "/onebot",
        bodyMaxBytes: 1024 * 1024,
      },
      ws: {
        enabled: true,
        url: "ws://127.0.0.1:3001",
        reconnectMs: 3000,
      },
    },
  };

  it("updates lastEventAt before runtime processing", async () => {
    const patches: Array<Partial<ChannelAccountSnapshot>> = [];

    await expect(
      processNapCatEvent({
        event: {
          post_type: "message",
          message_type: "private",
          message_id: "status-event",
          user_id: "123",
          self_id: "789",
          time: 1_700_000_003,
          message: "hello",
        },
        account: baseAccount,
        config: {} as OpenClawConfig,
        runtime: {} as RuntimeEnv,
        statusSink: (patch) => patches.push(patch),
      }),
    ).rejects.toThrow("NapCat runtime not initialized");

    expect(patches.some((patch) => typeof patch.lastEventAt === "number")).toBe(true);
  });

  it("updates lastEventAt for non-message events without requiring runtime", async () => {
    const patches: Array<Partial<ChannelAccountSnapshot>> = [];

    await processNapCatEvent({
      event: {
        post_type: "meta_event",
        sub_type: "heartbeat",
      },
      account: baseAccount,
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      statusSink: (patch) => patches.push(patch),
    });

    expect(patches.some((patch) => typeof patch.lastEventAt === "number")).toBe(true);
  });

  it("strips CQ mentions before command auth detection", async () => {
    const shouldComputeCommandAuthorized = vi.fn(() => false);
    setNapCatRuntime({
      channel: {
        pairing: {
          readAllowFromStore: vi.fn(async () => []),
          upsertPairingRequest: vi.fn(async () => {}),
        },
        commands: {
          shouldComputeCommandAuthorized,
          resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
        },
      },
    } as unknown as Parameters<typeof setNapCatRuntime>[0]);

    await processNapCatEvent({
      event: {
        post_type: "message",
        message_type: "private",
        message_id: "status-command",
        user_id: "123",
        self_id: "789",
        time: 1_700_000_004,
        message: "[CQ:at,qq=789]/status",
      },
      account: {
        ...baseAccount,
        config: {
          dm: {
            policy: "disabled",
          },
        },
      },
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
    });

    expect(shouldComputeCommandAuthorized).toHaveBeenCalledWith("/status", {});
  });
});
