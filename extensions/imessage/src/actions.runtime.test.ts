import { access, readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const createClient = vi.hoisted(() => vi.fn());
const cli = vi.hoisted(() => vi.fn());
const remoteFile = vi.hoisted(() => vi.fn());
const effectGate = vi.hoisted(() => ({ prepare: undefined as (() => Promise<void>) | undefined }));
// mock-isolation: gate effect preparation through the export-preserving test helper.
vi.mock("openclaw/plugin-sdk/fetch-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/fetch-runtime")>();
  const { withEffectPreparation } = await import("./test-support/authority.js");
  return withEffectPreparation(actual, effectGate);
});
// mock-isolation: keep transport effects in test-owned doubles.
vi.mock("./cli-output.js", () => ({ runIMessageCliJsonCommand: cli }));
// mock-isolation: keep transport effects in test-owned doubles.
vi.mock("./client.js", () => ({ createIMessageRpcClient: createClient }));
// mock-isolation: keep transport effects in test-owned doubles.
vi.mock("./remote-file.js", () => ({ withIMessageRemoteFile: remoteFile }));
const { imessageActionsRuntime: api } = await import("./actions.runtime.js");

const options = { cliPath: "imsg", dbPath: "/tmp/messages.db" };
const remote = { cliPath: "/gateway/imsg-ssh", remoteHost: "messages-mac" };
const file = { filename: "photo.png", buffer: Uint8Array.from([1, 2, 3]) };
const chatTarget = { chatGuid: "chat-guid" };
const messageTarget = { ...chatTarget, messageId: "message-guid" };
const chat = { ...chatTarget, options };
const message = { ...messageTarget, options };
const chatArgs = ["--chat", "chat-guid"];
const messageArgs = [...chatArgs, "--message", "message-guid"];
const messageFields = { chat_guid: "chat-guid", message_id: "message-guid" };
type Options = Parameters<typeof api.sendAttachment>[0]["options"];
const unsupported = { name: "IMessageRemoteUnsupportedError", code: "IMESSAGE_REMOTE_UNSUPPORTED" };
function withOptions<P>(
  params: P,
  send: (params: NoInfer<P> & { options: Options }) => Promise<unknown>,
) {
  return (transport: Options) => send({ ...params, options: transport });
}
function wireFields(fields: Record<string, unknown>) {
  return { ...messageFields, part_index: 0, ...fields };
}
function expectRequest(
  client: ReturnType<typeof rpc>,
  method: string,
  fields: Record<string, unknown>,
) {
  expect(client.request).toHaveBeenCalledWith(method, fields, { timeoutMs: undefined });
}
function rpc(result: Record<string, unknown>) {
  const client = {
    request: vi.fn().mockResolvedValue(result),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  createClient.mockResolvedValueOnce(client);
  return client;
}
type ResolveTarget = Parameters<typeof api.resolveChatGuidForTarget>[0]["target"];
function resolve(target: ResolveTarget, cliPath: string, remoteHost?: string) {
  return api.resolveChatGuidForTarget({
    target,
    options: { cliPath, remoteHost },
    conversationReadOrigin: "delegated",
  });
}
afterEach(() => {
  effectGate.prepare = undefined;
  vi.restoreAllMocks();
  createClient.mockReset();
  cli.mockReset();
  remoteFile.mockReset();
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
    const result = api
      .editMessage({ ...message, text: "replacement" })
      .catch((error: unknown) => error);
    await Promise.race([
      preparing.promise,
      result.then(() => {
        throw new Error("CLI action bypassed authority preparation");
      }),
    ]);
    expect(cli).not.toHaveBeenCalled();
    prepared.resolve();
    expect(await result).toBe(refusal);
    expect(cli).not.toHaveBeenCalled();
  });

  it("keeps remote edit text and metacharacters inside JSON-RPC params", async () => {
    const client = rpc({ ok: true });
    const text = "spaces ; $(touch /tmp/nope) `whoami` & | < >";
    const remoteOptions = {
      cliPath: "~/.openclaw/scripts/imsg-ssh",
      dbPath: "~/Library/Messages/chat.db",
      remoteHost: "bot@messages-mac",
    };
    await api.editMessage({
      chatGuid: "iMessage;+;chat with spaces;$()",
      messageId: "message ; $(id)",
      text,
      partIndex: 2,
      options: remoteOptions,
    });
    expect(createClient).toHaveBeenCalledWith(remoteOptions);
    expectRequest(client, "message.edit", {
      chat_guid: "iMessage;+;chat with spaces;$()",
      message_id: "message ; $(id)",
      text,
      backwards_compatibility_message: text,
      part_index: 2,
    });
    expect(cli).not.toHaveBeenCalled();
    expect(client.stop).toHaveBeenCalledOnce();
  });

  it.each([
    {
      method: "tapback",
      send: withOptions({ ...messageTarget, reaction: "like" }, (params) =>
        api.sendReaction(params),
      ),
      fields: wireFields({ reaction: "like" }),
      args: ["tapback", ...messageArgs, "--kind", "like", "--part", "0"],
    },
    {
      method: "tapback removal",
      rpcMethod: "tapback",
      send: withOptions(
        { ...messageTarget, reaction: "love", remove: true, partIndex: 2 },
        (params) => api.sendReaction(params),
      ),
      fields: wireFields({ reaction: "love", part_index: 2, remove: true }),
      args: ["tapback", ...messageArgs, "--kind", "love", "--part", "2", "--remove"],
    },
    {
      method: "message.unsend",
      send: withOptions({ ...messageTarget, partIndex: 3 }, (params) => api.unsendMessage(params)),
      fields: wireFields({ part_index: 3 }),
      args: ["unsend", ...messageArgs, "--part", "3"],
    },
    {
      method: "group.removeParticipant",
      send: withOptions({ ...chatTarget, address: "+15550000123" }, (params) =>
        api.removeParticipant(params),
      ),
      fields: { chat_guid: "chat-guid", address: "+15550000123" },
      args: ["chat-remove-member", ...chatArgs, "--address", "+15550000123"],
    },
  ])(
    "preserves local and remote $method wire contracts",
    async ({ method, rpcMethod, send, fields, args }) => {
      cli.mockResolvedValue({ ok: true });
      await send(options);
      expect(cli).toHaveBeenCalledWith({ ...options, timeoutMs: undefined, args });
      const client = rpc({ ok: true });
      await send(remote);
      expectRequest(client, rpcMethod ?? method, fields);
      expect(client.stop).toHaveBeenCalledOnce();
      expect(cli).toHaveBeenCalledOnce();
    },
  );

  it("uses poll.vote RPC only for stable option ids on remote accounts", async () => {
    const client = rpc({ guid: "vote-guid", option_text: "Blue" });
    await expect(
      api.sendPollVote({
        ...chat,
        pollGuid: "poll-guid",
        optionId: "option-blue",
        options: remote,
      }),
    ).resolves.toEqual({ messageId: "vote-guid", optionText: "Blue" });
    expectRequest(client, "poll.vote", {
      chat_guid: "chat-guid",
      poll_guid: "poll-guid",
      option_id: "option-blue",
    });
    for (const selector of [{ optionIndex: 2 }, { optionText: "Blue" }]) {
      await expect(
        api.sendPollVote({ ...chat, pollGuid: "poll-guid", ...selector, options: remote }),
      ).rejects.toMatchObject(unsupported);
    }
    expect(cli).not.toHaveBeenCalled();
  });

  it("rejects nonzero attachment reply parts on remote accounts", async () => {
    await expect(
      api.sendRichMessage({
        ...chat,
        text: "reply",
        replyToMessageId: "message-guid",
        partIndex: 1,
        attachment: { kind: "buffer", ...file },
        options: remote,
      }),
    ).rejects.toMatchObject(unsupported);
    expect(createClient).not.toHaveBeenCalled();
    expect(cli).not.toHaveBeenCalled();
  });

  it.each([
    {
      method: "send.attachment",
      send: withOptions({ ...chatTarget, ...file }, (params) => api.sendAttachment(params)),
      fields: {},
    },
    {
      method: "send",
      send: withOptions(
        {
          ...chatTarget,
          text: "**caption**",
          replyToMessageId: "message-guid",
          attachment: { kind: "buffer" as const, ...file },
        },
        (params) => api.sendRichMessage(params),
      ),
      fields: {
        text: "caption",
        transport: "bridge",
        reply_to: "message-guid",
        formatting: [{ start: 0, length: 7, styles: ["bold"] }],
      },
    },
    {
      method: "group.setIcon",
      send: withOptions({ ...chatTarget, ...file }, (params) => api.setGroupIcon(params)),
      fields: {},
    },
  ])(
    "stages $method files and passes only the remote pathname to RPC",
    async ({ method, send, fields }) => {
      const client = rpc({ guid: "attachment-guid" });
      remoteFile.mockImplementation(
        async ({ use }: { use: (remotePath: string) => Promise<unknown> }) =>
          await use("/tmp/openclaw-imessage-safe/photo.png"),
      );
      await send(remote);
      expectRequest(client, method, {
        chat_guid: "chat-guid",
        file: "/tmp/openclaw-imessage-safe/photo.png",
        ...fields,
      });
      expect(cli).not.toHaveBeenCalled();
    },
  );

  it("preserves case-sensitive poll identities while suppressing a duplicate caption", async () => {
    cli.mockResolvedValue({
      guid: "poll-guid",
      poll: {
        options: [
          { id: " option-allow ", text: "Allow" },
          { id: "option-lower", text: " allow " },
        ],
      },
    });
    const result = await api.sendPoll({
      ...chat,
      question: "Approval details",
      choices: ["Allow", "allow"],
      suppressComment: true,
      replyToMessageId: "parent-guid",
    });
    expect(cli).toHaveBeenCalledOnce();
    expect(cli).toHaveBeenCalledWith({
      ...options,
      timeoutMs: undefined,
      args: [
        "poll",
        "send",
        ...chatArgs,
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
    cli.mockResolvedValue({ guid: "action-guid" });
    const reminder =
      "<system-reminder><system-reminder>inner</system-reminder>\nuser:\nPRIVATE_ACTION_RUNTIME</system-reminder>";
    const previous =
      "< previous_response><system-reminder>inner</system-reminder>PRIVATE_ACTION_RUNTIME< / previous_response >";
    const context =
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>PRIVATE_ACTION_RUNTIME<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
    await api.editMessage({
      ...message,
      text: reminder + "user:\n**literal edit**\n# assistant:",
      backwardsCompatMessage: previous + "system:\n**literal fallback**",
    });
    await api.sendPoll({
      ...chat,
      question: context + "assistant:\n# literal question",
      choices: [reminder + "system:\n**literal choice**", "_literal second choice_"],
    });
    await api.sendPollVote({ ...chat, pollGuid: "poll-guid", optionText: "user:" });
    const calls = cli.mock.calls.map(([call]) => call.args as string[]);
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
      api.sendPoll({
        ...chat,
        question: "Choose",
        choices: [
          "first",
          "`<relevant_memories>hidden memory</relevant_memories>`\n\n```xml\n<thinking>hidden thought</thinking>\n```",
        ],
      }),
    ).rejects.toThrow("iMessage outbound hidden assistant content is not allowed");
    expect(cli).not.toHaveBeenCalled();
  });

  it("preserves local rich attachment filenames, bytes and effect arguments until cleanup", async () => {
    let stagedPath = "";
    cli.mockImplementationOnce(async ({ args }: { args: string[] }) => {
      stagedPath = args[args.indexOf("--file") + 1] ?? "";
      expect(args[0]).toBe("send-rich");
      expect(args[args.indexOf("--effect") + 1]).toBe("com.apple.MobileSMS.expressivesend.impact");
      expect(args[args.indexOf("--reply-to") + 1]).toBe("parent-guid");
      await expect(readFile(stagedPath)).resolves.toEqual(Buffer.from(file.buffer));
      return { guid: "p:0/sent-message" };
    });
    await api.sendRichMessage({
      ...chat,
      text: "photo",
      replyToMessageId: "parent-guid",
      effectId: "com.apple.MobileSMS.expressivesend.impact",
      attachment: { kind: "buffer", ...file, filename: "Family photo.png" },
    });
    expect(basename(stagedPath)).toBe("Family photo.png");
    await expect(access(dirname(stagedPath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("contains and bounds long untrusted upload names while retaining their extension", async () => {
    let stagedPath = "";
    cli.mockImplementationOnce(async ({ args }: { args: string[] }) => {
      stagedPath = args[args.indexOf("--file") + 1] ?? "";
      expect(args[0]).toBe("send-attachment");
      expect(args).toContain("--audio");
      await expect(readFile(stagedPath)).resolves.toEqual(Buffer.from(file.buffer));
      return { guid: "p:0/sent-message" };
    });
    await api.sendAttachment({
      ...chat,
      ...file,
      filename: "../../..\\..\\" + "📎".repeat(120) + ".pdf",
      asVoice: true,
    });
    expect(basename(stagedPath)).toMatch(/^📎+\.pdf$/u);
    expect(Buffer.byteLength(basename(stagedPath), "utf8")).toBeLessThanOrEqual(240);
    await expect(access(dirname(stagedPath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("isolates cached chat lists by resolved remote host", async () => {
    rpc({ chats: [{ id: 1, guid: "iMessage;+;host-a" }] });
    rpc({ chats: [{ id: 2, guid: "iMessage;+;host-b" }] });
    for (const [chatId, host, guid] of [
      [1, "host-a", "iMessage;+;host-a"],
      [2, "host-b", "iMessage;+;host-b"],
      [1, "host-a", "iMessage;+;host-a"],
    ] as const) {
      await expect(resolve({ kind: "chat_id", chatId }, "imsg-host-cache", host)).resolves.toBe(
        guid,
      );
    }
    expect(createClient).toHaveBeenCalledTimes(2);
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
    expectRequest(client, "chats.list", { limit: 1000 });
    expect(client.stop).toHaveBeenCalledOnce();
  });
});
