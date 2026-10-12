import { access, readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const createIMessageRpcClientMock = vi.hoisted(() => vi.fn());
const runIMessageCliJsonCommandMock = vi.hoisted(() => vi.fn());
const withIMessageRemoteFileMock = vi.hoisted(() => vi.fn());
const effectGate = vi.hoisted(() => ({ prepare: undefined as (() => Promise<void>) | undefined }));
vi.mock("openclaw/plugin-sdk/fetch-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/fetch-runtime")>();
  return {
    ...actual,
    captureEffectAuthority: () => {
      const authority = actual.captureEffectAuthority();
      const prepare = effectGate.prepare;
      return prepare
        ? {
            ...authority,
            initiate: async <T>(effect: () => T | Promise<T>) => {
              await prepare();
              return authority.initiate(effect);
            },
          }
        : authority;
    },
  };
});
vi.mock("./cli-output.js", () => ({ runIMessageCliJsonCommand: runIMessageCliJsonCommandMock }));
vi.mock("./client.js", () => ({ createIMessageRpcClient: createIMessageRpcClientMock }));
vi.mock("./remote-file.js", () => ({ withIMessageRemoteFile: withIMessageRemoteFileMock }));
const { imessageActionsRuntime: runtime } = await import("./actions.runtime.js");

const options = { cliPath: "imsg", dbPath: "/tmp/messages.db" };
const remote = { cliPath: "/gateway/imsg-ssh", remoteHost: "messages-mac" };
const file = { filename: "photo.png", buffer: Uint8Array.from([1, 2, 3]) };
function rpc(result: Record<string, unknown>) {
  const client = {
    request: vi.fn().mockResolvedValue(result),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  createIMessageRpcClientMock.mockResolvedValueOnce(client);
  return client;
}
type ResolveTarget = Parameters<typeof runtime.resolveChatGuidForTarget>[0]["target"];
function resolve(target: ResolveTarget, cliPath: string, remoteHost?: string) {
  return runtime.resolveChatGuidForTarget({
    target,
    options: { cliPath, remoteHost },
    conversationReadOrigin: "delegated",
  });
}
afterEach(() => {
  effectGate.prepare = undefined;
  vi.restoreAllMocks();
  createIMessageRpcClientMock.mockReset();
  runIMessageCliJsonCommandMock.mockReset();
  withIMessageRemoteFileMock.mockReset();
});

describe("imessage actions runtime", () => {
  it("does not start the local CLI when action authority ends during preparation", async () => {
    const preparing = Promise.withResolvers<void>();
    const prepared = Promise.withResolvers<void>();
    const refusal = new Error("action authority ended");
    effectGate.prepare = async () => {
      preparing.resolve();
      await prepared.promise;
      throw refusal;
    };
    const result = runtime
      .editMessage({
        chatGuid: "chat-guid",
        messageId: "message-guid",
        text: "replacement",
        options,
      })
      .catch((error: unknown) => error);
    await Promise.race([
      preparing.promise,
      result.then(() => {
        throw new Error("CLI action bypassed authority preparation");
      }),
    ]);
    expect(runIMessageCliJsonCommandMock).not.toHaveBeenCalled();
    prepared.resolve();
    expect(await result).toBe(refusal);
    expect(runIMessageCliJsonCommandMock).not.toHaveBeenCalled();
  });

  it("keeps remote edit text and metacharacters inside JSON-RPC params", async () => {
    const client = rpc({ ok: true });
    const text = "spaces ; $(touch /tmp/nope) `whoami` & | < >";
    const remoteOptions = {
      cliPath: "~/.openclaw/scripts/imsg-ssh",
      dbPath: "~/Library/Messages/chat.db",
      remoteHost: "bot@messages-mac",
    };
    await runtime.editMessage({
      chatGuid: "iMessage;+;chat with spaces;$()",
      messageId: "message ; $(id)",
      text,
      partIndex: 2,
      options: remoteOptions,
    });
    expect(createIMessageRpcClientMock).toHaveBeenCalledWith(remoteOptions);
    expect(client.request).toHaveBeenCalledWith(
      "message.edit",
      {
        chat_guid: "iMessage;+;chat with spaces;$()",
        message_id: "message ; $(id)",
        text,
        backwards_compatibility_message: text,
        part_index: 2,
      },
      { timeoutMs: undefined },
    );
    expect(runIMessageCliJsonCommandMock).not.toHaveBeenCalled();
    expect(client.stop).toHaveBeenCalledOnce();
  });

  it.each([
    {
      method: "tapback",
      send: (transport: typeof options | typeof remote) =>
        runtime.sendReaction({
          chatGuid: "chat-guid",
          messageId: "message-guid",
          reaction: "like",
          options: transport,
        }),
      fields: {
        chat_guid: "chat-guid",
        message_id: "message-guid",
        reaction: "like",
        part_index: 0,
      },
      args: [
        "tapback",
        "--chat",
        "chat-guid",
        "--message",
        "message-guid",
        "--kind",
        "like",
        "--part",
        "0",
      ],
    },
    {
      method: "tapback removal",
      rpcMethod: "tapback",
      send: (transport: typeof options | typeof remote) =>
        runtime.sendReaction({
          chatGuid: "chat-guid",
          messageId: "message-guid",
          reaction: "love",
          remove: true,
          partIndex: 2,
          options: transport,
        }),
      fields: {
        chat_guid: "chat-guid",
        message_id: "message-guid",
        reaction: "love",
        part_index: 2,
        remove: true,
      },
      args: [
        "tapback",
        "--chat",
        "chat-guid",
        "--message",
        "message-guid",
        "--kind",
        "love",
        "--part",
        "2",
        "--remove",
      ],
    },
    {
      method: "message.unsend",
      send: (transport: typeof options | typeof remote) =>
        runtime.unsendMessage({
          chatGuid: "chat-guid",
          messageId: "message-guid",
          partIndex: 3,
          options: transport,
        }),
      fields: { chat_guid: "chat-guid", message_id: "message-guid", part_index: 3 },
      args: ["unsend", "--chat", "chat-guid", "--message", "message-guid", "--part", "3"],
    },
    {
      method: "group.removeParticipant",
      send: (transport: typeof options | typeof remote) =>
        runtime.removeParticipant({
          chatGuid: "chat-guid",
          address: "+15550000123",
          options: transport,
        }),
      fields: { chat_guid: "chat-guid", address: "+15550000123" },
      args: ["chat-remove-member", "--chat", "chat-guid", "--address", "+15550000123"],
    },
  ])(
    "preserves local and remote $method wire contracts",
    async ({ method, rpcMethod, send, fields, args }) => {
      runIMessageCliJsonCommandMock.mockResolvedValue({ ok: true });
      await send(options);
      expect(runIMessageCliJsonCommandMock).toHaveBeenCalledWith({
        ...options,
        timeoutMs: undefined,
        args,
      });
      const client = rpc({ ok: true });
      await send(remote);
      expect(client.request).toHaveBeenCalledWith(rpcMethod ?? method, fields, {
        timeoutMs: undefined,
      });
      expect(client.stop).toHaveBeenCalledOnce();
      expect(runIMessageCliJsonCommandMock).toHaveBeenCalledOnce();
    },
  );

  it("uses poll.vote RPC only for stable option ids on remote accounts", async () => {
    const client = rpc({ guid: "vote-guid", option_text: "Blue" });
    await expect(
      runtime.sendPollVote({
        chatGuid: "chat-guid",
        pollGuid: "poll-guid",
        optionId: "option-blue",
        options: remote,
      }),
    ).resolves.toEqual({ messageId: "vote-guid", optionText: "Blue" });
    expect(client.request).toHaveBeenCalledWith(
      "poll.vote",
      {
        chat_guid: "chat-guid",
        poll_guid: "poll-guid",
        option_id: "option-blue",
      },
      { timeoutMs: undefined },
    );
    for (const selector of [{ optionIndex: 2 }, { optionText: "Blue" }]) {
      await expect(
        runtime.sendPollVote({
          chatGuid: "chat-guid",
          pollGuid: "poll-guid",
          ...selector,
          options: remote,
        }),
      ).rejects.toMatchObject({
        name: "IMessageRemoteUnsupportedError",
        code: "IMESSAGE_REMOTE_UNSUPPORTED",
      });
    }
    expect(runIMessageCliJsonCommandMock).not.toHaveBeenCalled();
  });

  it("rejects nonzero attachment reply parts on remote accounts", async () => {
    await expect(
      runtime.sendRichMessage({
        chatGuid: "chat-guid",
        text: "reply",
        replyToMessageId: "message-guid",
        partIndex: 1,
        attachment: { kind: "buffer", ...file },
        options: remote,
      }),
    ).rejects.toMatchObject({
      name: "IMessageRemoteUnsupportedError",
      code: "IMESSAGE_REMOTE_UNSUPPORTED",
    });
    expect(createIMessageRpcClientMock).not.toHaveBeenCalled();
    expect(runIMessageCliJsonCommandMock).not.toHaveBeenCalled();
  });

  type Options = Parameters<typeof runtime.sendAttachment>[0]["options"];
  it.each([
    {
      method: "send.attachment",
      send: (actionOptions: Options) =>
        runtime.sendAttachment({ chatGuid: "chat-guid", ...file, options: actionOptions }),
      fields: {},
    },
    {
      method: "send",
      send: (actionOptions: Options) =>
        runtime.sendRichMessage({
          chatGuid: "chat-guid",
          text: "**caption**",
          replyToMessageId: "message-guid",
          attachment: { kind: "buffer", ...file },
          options: actionOptions,
        }),
      fields: {
        text: "caption",
        transport: "bridge",
        reply_to: "message-guid",
        formatting: [{ start: 0, length: 7, styles: ["bold"] }],
      },
    },
    {
      method: "group.setIcon",
      send: (actionOptions: Options) =>
        runtime.setGroupIcon({ chatGuid: "chat-guid", ...file, options: actionOptions }),
      fields: {},
    },
  ])(
    "stages $method files and passes only the remote pathname to RPC",
    async ({ method, send, fields }) => {
      const client = rpc({ guid: "attachment-guid" });
      withIMessageRemoteFileMock.mockImplementation(
        async ({ use }: { use: (remotePath: string) => Promise<unknown> }) =>
          await use("/tmp/openclaw-imessage-safe/photo.png"),
      );
      await send(remote);
      expect(client.request).toHaveBeenCalledWith(
        method,
        {
          chat_guid: "chat-guid",
          file: "/tmp/openclaw-imessage-safe/photo.png",
          ...fields,
        },
        { timeoutMs: undefined },
      );
      expect(runIMessageCliJsonCommandMock).not.toHaveBeenCalled();
    },
  );

  it("preserves case-sensitive poll identities while suppressing a duplicate caption", async () => {
    runIMessageCliJsonCommandMock.mockResolvedValue({
      guid: "poll-guid",
      poll: {
        options: [
          { id: " option-allow ", text: "Allow" },
          { id: "option-lower", text: " allow " },
        ],
      },
    });
    const result = await runtime.sendPoll({
      chatGuid: "chat-guid",
      question: "Approval details",
      choices: ["Allow", "allow"],
      suppressComment: true,
      replyToMessageId: "parent-guid",
      options,
    });
    expect(runIMessageCliJsonCommandMock).toHaveBeenCalledOnce();
    expect(runIMessageCliJsonCommandMock).toHaveBeenCalledWith({
      ...options,
      timeoutMs: undefined,
      args: [
        "poll",
        "send",
        "--chat",
        "chat-guid",
        "--question",
        "Approval details",
        "--option",
        "Allow",
        "--option",
        "allow",
        "--reply-to",
        "parent-guid",
        "--no-comment",
      ],
    });
    expect(result).toEqual({
      messageId: "poll-guid",
      pollOptions: [
        { id: "option-allow", text: "Allow" },
        { id: "option-lower", text: "allow" },
      ],
    });
  });

  it("scrubs private payloads and role markers without rendering raw edit or poll Markdown", async () => {
    runIMessageCliJsonCommandMock.mockResolvedValue({ guid: "action-guid" });
    const reminder =
      "<system-reminder><system-reminder>inner</system-reminder>\nuser:\nPRIVATE_ACTION_RUNTIME</system-reminder>";
    const previous =
      "< previous_response><system-reminder>inner</system-reminder>PRIVATE_ACTION_RUNTIME< / previous_response >";
    const context =
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>PRIVATE_ACTION_RUNTIME<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
    await runtime.editMessage({
      chatGuid: "chat-guid",
      messageId: "message-guid",
      text: reminder + "user:\n**literal edit**\n# assistant:",
      backwardsCompatMessage: previous + "system:\n**literal fallback**",
      options,
    });
    await runtime.sendPoll({
      chatGuid: "chat-guid",
      question: context + "assistant:\n# literal question",
      choices: [reminder + "system:\n**literal choice**", "_literal second choice_"],
      options,
    });
    await runtime.sendPollVote({
      chatGuid: "chat-guid",
      pollGuid: "poll-guid",
      optionText: "user:",
      options,
    });
    const calls = runIMessageCliJsonCommandMock.mock.calls.map(([call]) => call.args as string[]);
    const [edit, poll, vote] = calls;
    if (!edit || !poll || !vote) {
      throw new Error("Expected edit, poll and vote commands");
    }
    expect(edit[edit.indexOf("--new-text") + 1]).toBe("\n**literal edit**\n# assistant:");
    expect(edit[edit.indexOf("--bc-text") + 1]).toBe("\n**literal fallback**");
    expect(poll[poll.indexOf("--question") + 1]).toBe("\n# literal question");
    expect(poll[poll.indexOf("--option") + 1]).toBe("\n**literal choice**");
    expect(vote[vote.indexOf("--option") + 1]).toBe("user:");
    for (const args of calls) {
      expect(args.join(" ")).not.toMatch(
        /PRIVATE_ACTION_RUNTIME|system-reminder|previous_response|INTERNAL_CONTEXT/,
      );
    }
  });

  it("rejects hidden assistant content in raw poll code before imsg", async () => {
    await expect(
      runtime.sendPoll({
        chatGuid: "chat-guid",
        question: "Choose",
        choices: [
          "first",
          "`<relevant_memories>hidden memory</relevant_memories>`\n\n```xml\n<thinking>hidden thought</thinking>\n```",
        ],
        options,
      }),
    ).rejects.toThrow("iMessage outbound hidden assistant content is not allowed");
    expect(runIMessageCliJsonCommandMock).not.toHaveBeenCalled();
  });

  it("preserves local rich attachment filenames, bytes and effect arguments until cleanup", async () => {
    let stagedPath = "";
    runIMessageCliJsonCommandMock.mockImplementationOnce(async ({ args }: { args: string[] }) => {
      stagedPath = args[args.indexOf("--file") + 1] ?? "";
      expect(args[0]).toBe("send-rich");
      expect(args[args.indexOf("--effect") + 1]).toBe("com.apple.MobileSMS.expressivesend.impact");
      expect(args[args.indexOf("--reply-to") + 1]).toBe("parent-guid");
      await expect(readFile(stagedPath)).resolves.toEqual(Buffer.from(file.buffer));
      return { guid: "p:0/sent-message" };
    });
    await runtime.sendRichMessage({
      chatGuid: "chat-guid",
      text: "photo",
      replyToMessageId: "parent-guid",
      effectId: "com.apple.MobileSMS.expressivesend.impact",
      attachment: { kind: "buffer", ...file, filename: "Family photo.png" },
      options,
    });
    expect(basename(stagedPath)).toBe("Family photo.png");
    await expect(access(dirname(stagedPath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("contains and bounds long untrusted upload names while retaining their extension", async () => {
    let stagedPath = "";
    runIMessageCliJsonCommandMock.mockImplementationOnce(async ({ args }: { args: string[] }) => {
      stagedPath = args[args.indexOf("--file") + 1] ?? "";
      expect(args[0]).toBe("send-attachment");
      expect(args).toContain("--audio");
      await expect(readFile(stagedPath)).resolves.toEqual(Buffer.from(file.buffer));
      return { guid: "p:0/sent-message" };
    });
    await runtime.sendAttachment({
      chatGuid: "chat-guid",
      ...file,
      filename: "../../..\\..\\" + "📎".repeat(120) + ".pdf",
      asVoice: true,
      options,
    });
    expect(basename(stagedPath)).toMatch(/^📎+\.pdf$/u);
    expect(Buffer.byteLength(basename(stagedPath), "utf8")).toBeLessThanOrEqual(240);
    await expect(access(dirname(stagedPath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("drops a cached chat list when the clock stops being a valid date", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const first = rpc({ chats: [{ id: 1, guid: "iMessage;+;first" }] });
    const second = rpc({ chats: [{ id: 2, guid: "iMessage;+;second" }] });
    await expect(resolve({ kind: "chat_id", chatId: 1 }, "imsg-invalid-clock")).resolves.toBe(
      "iMessage;+;first",
    );
    now.mockReturnValue(Number.NaN);
    await expect(resolve({ kind: "chat_id", chatId: 2 }, "imsg-invalid-clock")).resolves.toBe(
      "iMessage;+;second",
    );
    expect(createIMessageRpcClientMock).toHaveBeenCalledTimes(2);
    for (const client of [first, second]) {
      expect(client.request).toHaveBeenCalledWith(
        "chats.list",
        { limit: 1000 },
        { timeoutMs: undefined },
      );
    }
  });

  it("does not cache a chat list whose expiry would exceed the valid date range", async () => {
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_000);
    rpc({ chats: [{ id: 1, guid: "iMessage;+;first" }] });
    rpc({ chats: [{ id: 2, guid: "iMessage;+;second" }] });
    await expect(resolve({ kind: "chat_id", chatId: 1 }, "imsg-overflow-clock")).resolves.toBe(
      "iMessage;+;first",
    );
    await expect(resolve({ kind: "chat_id", chatId: 2 }, "imsg-overflow-clock")).resolves.toBe(
      "iMessage;+;second",
    );
    expect(createIMessageRpcClientMock).toHaveBeenCalledTimes(2);
  });

  it("isolates cached chat lists by resolved remote host", async () => {
    rpc({ chats: [{ id: 1, guid: "iMessage;+;host-a" }] });
    rpc({ chats: [{ id: 2, guid: "iMessage;+;host-b" }] });
    await expect(
      resolve({ kind: "chat_id", chatId: 1 }, "imsg-host-cache", "host-a"),
    ).resolves.toBe("iMessage;+;host-a");
    await expect(
      resolve({ kind: "chat_id", chatId: 2 }, "imsg-host-cache", "host-b"),
    ).resolves.toBe("iMessage;+;host-b");
    await expect(
      resolve({ kind: "chat_id", chatId: 1 }, "imsg-host-cache", "host-a"),
    ).resolves.toBe("iMessage;+;host-a");
    expect(createIMessageRpcClientMock).toHaveBeenCalledTimes(2);
  });

  const chatList = [
    { id: 7, identifier: "chat0000", guid: "iMessage;+;chat0000" },
    { id: 8, identifier: "Other@Example.com", guid: "any;-;Other@Example.com" },
    { id: 3, identifier: "+12069106512", guid: "any;-;+12069106512" },
  ];
  it.each([
    {
      name: "synthesized phone identifier",
      target: { kind: "chat_identifier", chatIdentifier: "IMESSAGE;-;+12069106512" },
      chats: chatList,
      expected: "any;-;+12069106512",
    },
    {
      name: "non-decimal chat id",
      target: { kind: "chat_id", chatId: 7 },
      chats: [{ id: "0x7", identifier: "wrong", guid: "iMessage;+;wrong" }],
      expected: null,
    },
  ] satisfies {
    name: string;
    target: ResolveTarget;
    chats: Record<string, unknown>[];
    expected: string | null;
  }[])("resolves $name against chats.list", async ({ name, target, chats, expected }) => {
    const client = rpc({ chats });
    await expect(resolve(target, "imsg-resolution-" + name)).resolves.toBe(expected);
    expect(client.request).toHaveBeenCalledWith(
      "chats.list",
      { limit: 1000 },
      { timeoutMs: undefined },
    );
    expect(client.stop).toHaveBeenCalledOnce();
  });
});
