import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createAgentHarnessHostCapabilitiesForTest,
  createPluginRecord,
  createPluginRegistry,
  createPluginRuntimeMock,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { imessagePlugin } from "./channel.js";
import { IMessageRpcRequestError, type IMessageRpcClient } from "./client.js";

const native = vi.hoisted(() => ({
  createClient: vi.fn(),
  request: vi.fn<(...args: Parameters<IMessageRpcClient["request"]>) => Promise<unknown>>(),
  stop: vi.fn<() => Promise<void>>(),
  probe: vi.fn(),
}));
vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  createIMessageRpcClient: native.createClient,
}));
vi.mock("./probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./probe.js")>()),
  probeIMessagePrivateApi: native.probe,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
const workspaceDir = tempDirs.make("imessage-read-");
const cfg: OpenClawConfig = {
  agents: { entries: { main: {} }, defaults: { workspace: workspaceDir } },
  tools: { allow: ["message"], web: { search: { enabled: false }, fetch: { enabled: false } } },
  channels: {
    imessage: {
      cliPath: "/synthetic/imsg-rpc",
      dbPath: "/synthetic/messages.db",
      dmPolicy: "disabled",
      groupPolicy: "disabled",
      accounts: {
        default: {},
        off: { enabled: false },
        remote: {
          cliPath: "/synthetic/imsg-ssh",
          dbPath: "~/synthetic/messages.db",
          remoteHost: "bot@messages-mac",
        },
      },
    },
  },
};
const row = (id = 7, text = "  decoded text\n") => ({
  id,
  chat_id: 42,
  created_at: "2026-01-02T03:04:05Z",
  sender: "+15555550123",
  is_from_me: false,
  text,
  attachments: [{ path: "DO_NOT_EXPOSE" }],
  guid: "DO_NOT_EXPOSE",
});
let metadata: unknown;
let history: unknown;
let run = 0;
const hosts: Array<Awaited<ReturnType<typeof createAgentHarnessHostCapabilitiesForTest>>> = [];

async function fixture(
  options: { owner?: boolean; nativeContext?: boolean; chatType?: "direct" | "group" } = {},
) {
  const owner = options.owner !== false;
  const runId = "imessage-read-" + ++run;
  const sessionKey = "agent:main:" + runId;
  const context = options.nativeContext
    ? {
        messageChannel: "imessage",
        agentAccountId: "default",
        currentChannelId: "chat_id:42",
        chatType: options.chatType ?? "direct",
      }
    : { messageChannel: "webchat" };
  const host = await createAgentHarnessHostCapabilitiesForTest({
    pluginId: "imessage-read-fixture",
    attempt: {
      runId,
      sessionId: runId,
      sessionKey,
      agentId: "main",
      workspaceDir,
      config: cfg,
      senderIsOwner: owner,
      ...context,
    },
    operatorSource: {
      profileId: owner ? "fixture-owner" : "fixture-member",
      scopes: owner ? ["operator.admin"] : ["operator.read", "operator.write"],
      assertCurrent: () => {},
    },
  });
  hosts.push(host);
  const tools = await host.capabilities.createToolSurfaceAsync!({
    config: cfg,
    workspaceDir,
    sessionKey,
    agentId: "main",
    senderIsOwner: owner,
    ...context,
    toolConstructionPlan: {
      includeBaseCodingTools: false,
      includeShellTools: false,
      includeChannelTools: true,
      includeOpenClawTools: true,
      includePluginTools: false,
    },
  });
  const message = tools.find((tool) => tool.name === "message");
  if (!message) {
    throw new Error("Expected the host-created message tool");
  }
  return {
    host,
    read: (params: Record<string, unknown> = {}) =>
      message.execute("read-" + ++run, {
        action: "read",
        channel: "imessage",
        target: "chat_id:42",
        ...params,
      }),
  };
}

beforeEach(() => {
  metadata = { id: 42, is_group: false };
  history = { messages: [row()] };
  native.request.mockReset().mockImplementation(async (method, _params, options) => {
    options?.assertCurrent?.();
    if (method === "chats.get") {
      return metadata;
    }
    if (method === "messages.history") {
      return history;
    }
    throw new Error("Unexpected native operation: " + method);
  });
  native.stop.mockReset().mockResolvedValue(undefined);
  native.createClient.mockReset().mockResolvedValue({ request: native.request, stop: native.stop });
  native.probe
    .mockReset()
    .mockRejectedValue(new Error("Reads must not probe or launch the private bridge"));
  const registry = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: createPluginRuntimeMock(),
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: "imessage",
    origin: "bundled",
    trustedOfficialInstall: true,
  });
  registry.registry.plugins.push(record);
  registry
    .createApi(record, { config: cfg, registrationMode: "full" })
    .registerChannel({ plugin: imessagePlugin });
  setActivePluginRegistry(registry.registry);
});
afterEach(() => {
  for (const host of hosts.splice(0)) {
    host.close();
  }
  resetPluginRuntimeStateForTest();
});

describe("shared message tool -> bounded native iMessage read", () => {
  it("uses one RPC connection, preserves text, and exposes no native metadata or mutations", async () => {
    const f = await fixture();
    history = {
      messages: [
        row(),
        { ...row(3, "newer"), created_at: "2026-01-02T03:04:06Z", is_from_me: true },
      ],
    };
    const result = await f.read();
    expect(result).toMatchObject({
      details: {
        chatId: 42,
        limit: 10,
        returned: 2,
        coverage: "recent-window",
        historyComplete: false,
        messages: [
          { id: "3", direction: "outgoing", text: "newer" },
          {
            id: "7",
            timestamp: "2026-01-02T03:04:05.000Z",
            sender: "+15555550123",
            direction: "incoming",
            text: "  decoded text\n",
          },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain("DO_NOT_EXPOSE");
    expect(native.request.mock.calls.map(([method, params]) => [method, params])).toEqual([
      ["chats.get", { chat_id: 42 }],
      ["messages.history", { chat_id: 42, limit: 10, attachments: false }],
    ]);
    expect(native.createClient).toHaveBeenCalledOnce();
    expect(native.stop).toHaveBeenCalledOnce();
    expect(native.probe).not.toHaveBeenCalled();
    expect(cfg.channels?.imessage?.dmPolicy).toBe("disabled");
  });

  it("keeps the selected remote account's transport and database together", async () => {
    const f = await fixture();
    await f.read({ accountId: "remote", limit: 50 });
    expect(native.createClient).toHaveBeenCalledExactlyOnceWith({
      cliPath: "/synthetic/imsg-ssh",
      dbPath: "~/synthetic/messages.db",
      remoteHost: "bot@messages-mac",
    });
    expect(native.request.mock.calls[1]?.[1]).toEqual({
      chat_id: 42,
      limit: 50,
      attachments: false,
    });
  });

  it("preserves canonical current-DM selection and denies another native target/account", async () => {
    const f = await fixture({ nativeContext: true });
    await f.read({ target: undefined });
    await f.read({ to: "chat_id:43" });
    expect(
      native.request.mock.calls
        .filter(([method]) => method === "messages.history")
        .map(([, params]) => params?.chat_id),
    ).toEqual([42, 42]);
    native.createClient.mockClear();
    // The public harness above admits an operator. Exercise the native adapter
    // contract separately with the delegated context supplied by channel ingress.
    const context: ChannelMessageActionContext = {
      channel: "imessage",
      action: "read",
      cfg,
      senderIsOwner: true,
      accountId: "default",
      requesterAccountId: "default",
      conversationReadOrigin: "delegated",
      params: { target: "chat_id:42" },
      toolContext: {
        currentChannelProvider: "imessage",
        currentChannelId: "chat_id:42",
        currentChatType: "direct",
      },
    };
    for (const override of [
      { params: { target: "chat_id:43" } },
      { accountId: "remote" },
      { toolContext: { ...context.toolContext, currentChatType: "group" as const } },
    ]) {
      await expect(
        imessagePlugin.actions!.handleAction!({ ...context, ...override }),
      ).rejects.toThrow("trusted current direct chat and account");
    }
    expect(native.createClient).not.toHaveBeenCalled();
  });

  it("rejects spoofed authority and invalid scope/limits before native work", async () => {
    const member = await fixture({ owner: false });
    await expect(
      member.read({ senderIsOwner: true, gatewayClientScopes: ["operator.admin"] }),
    ).rejects.toThrow();
    const f = await fixture();
    for (const params of [
      { target: undefined },
      { target: "+15555550123" },
      { target: "chat_id:9007199254740992" },
      { accountId: "missing" },
      { accountId: "off" },
      { chatId: 43 },
      { before: "7" },
      { attachments: true },
      { limit: 0 },
      { limit: 1.5 },
      { limit: 51 },
    ]) {
      await expect(f.read(params)).rejects.toThrow();
    }
    expect(native.createClient).not.toHaveBeenCalled();
  });

  it("requires exact authoritative DM metadata before requesting any history", async () => {
    const f = await fixture();
    for (metadata of [null, {}, { id: 43, is_group: false }, { id: 42, is_group: true }]) {
      native.request.mockClear();
      await expect(f.read()).rejects.toThrow("one-to-one chat metadata");
      expect(native.request.mock.calls.map(([method]) => method)).toEqual(["chats.get"]);
    }
    expect(native.stop).toHaveBeenCalledTimes(4);
  });

  it("fails clearly on older providers and preserves native errors without fallback", async () => {
    const f = await fixture();
    native.request.mockRejectedValueOnce(new IMessageRpcRequestError("Unknown method", -32601));
    await expect(f.read()).rejects.toThrow("imsg build with chats.get");
    for (const error of [
      new IMessageRpcRequestError("unknown chat", -32602),
      new Error("permission denied"),
    ]) {
      native.request.mockRejectedValueOnce(error);
      await expect(f.read()).rejects.toThrow(error.message);
    }
    expect(native.request.mock.calls.map(([method]) => method)).toEqual([
      "chats.get",
      "chats.get",
      "chats.get",
    ]);
    expect(native.stop).toHaveBeenCalledTimes(3);
    expect(native.probe).not.toHaveBeenCalled();
  });

  it.each(["metadata", "history", "stop", "registration"] as const)(
    "discards data when authority retires during %s",
    async (point) => {
      const f = await fixture({ nativeContext: true });
      let retired = false;
      const retire = () => {
        if (point === "registration") {
          setActivePluginRegistry(createTestRegistry());
        } else {
          f.host.close();
        }
        retired = true;
      };
      if (point === "stop") {
        native.stop.mockImplementationOnce(async () => retire());
      } else {
        native.request.mockImplementation(async (method, _params, options) => {
          options?.assertCurrent?.();
          if ((point === "history") === (method === "messages.history")) {
            retire();
          }
          return method === "chats.get" ? metadata : history;
        });
      }
      await expect(f.read()).rejects.toThrow();
      expect(retired).toBe(true);
      expect(native.stop).toHaveBeenCalledOnce();
      if (point === "metadata" || point === "registration") {
        expect(native.request).toHaveBeenCalledOnce();
      }
    },
  );

  it("bounds the complete model-visible result for Unicode and heavily escaped native rows", async () => {
    const f = await fixture();
    for (const text of ["a", "🚀", "\u0000", '"\\\n']) {
      history = {
        messages: Array.from({ length: 50 }, (_, id) => ({
          ...row(id + 1, text.repeat(9000)),
          sender: "猫".repeat(3000),
        })),
      };
      const result = await f.read({ limit: 50 });
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(32 * 1024);
      expect(result).toMatchObject({ details: { historyComplete: false, truncated: true } });
      expect(result).toHaveProperty("details.messages.0.id", "50");
      expect(result).toHaveProperty("details.messages.0.textTruncated", true);
      expect(result).toHaveProperty("details.messages.0.senderTruncated", true);
      const messages = asOptionalRecord(result.details)?.messages;
      if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error("Newest text must survive truncation");
      }
      for (const value of messages) {
        const message = asOptionalRecord(value);
        if (typeof message?.text !== "string" || typeof message.sender !== "string") {
          throw new Error("Expected text projection");
        }
        expect(message.text.isWellFormed()).toBe(true);
        expect(message.text.length).toBeGreaterThan(0);
        expect(Buffer.byteLength(message.text)).toBeLessThanOrEqual(4 * 1024);
        expect(Buffer.byteLength(message.sender)).toBeLessThanOrEqual(256);
      }
    }
  });

  it("reports malformed rows and empty windows without leaking foreign/group data", async () => {
    const f = await fixture();
    history = {
      messages: [
        row(1, "a\ud800b"),
        { ...row(2), created_at: "invalid" },
        { ...row(3), sender: {} },
        { ...row(4), id: Number.MAX_SAFE_INTEGER + 1 },
        { ...row(5), is_from_me: "false" },
        { ...row(6), text: {} },
        null,
      ],
    };
    expect(await f.read()).toMatchObject({
      details: {
        returned: 1,
        omittedInvalid: 6,
        truncated: true,
        messages: [{ text: "a�b", textTruncated: true }],
      },
    });
    for (history of [
      [],
      { messages: [row(1), row(2)] },
      { messages: [{ ...row(), chat_id: 43 }] },
      { messages: [{ ...row(), is_group: true }] },
    ]) {
      await expect(f.read({ limit: 1 })).rejects.toThrow();
    }
    history = { messages: [] };
    expect(await f.read()).toMatchObject({ details: { returned: 0, historyComplete: false } });
  });
});
