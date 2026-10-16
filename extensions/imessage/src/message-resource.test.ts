import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatContextFromIMessageTarget } from "./chat-context.js";
import { IMessageRpcClient } from "./client.js";
import { loadFreshIMessageReplyCacheForTest } from "./test-support/runtime.js";

type MessageResourceModule = typeof import("./message-resource.js");
type ReplyCacheModule = typeof import("./monitor-reply-cache.js");
let checkIMessageResourceBinding: (typeof import("./message-resource-db.js"))["checkIMessageResourceBinding"];
let authorizeIMessageResourceReference: MessageResourceModule["authorizeIMessageResourceReference"];
let rememberIMessageReplyCache: ReplyCacheModule["rememberIMessageReplyCache"];
let resolveIMessageCachedResourceBinding: ReplyCacheModule["resolveIMessageCachedResourceBinding"];

let tempDir = "";
let dbPath = "";
let cliPath = "";

beforeEach(async () => {
  ({ rememberIMessageReplyCache, resolveIMessageCachedResourceBinding } =
    await loadFreshIMessageReplyCacheForTest());
  ({ authorizeIMessageResourceReference } = await import("./message-resource.js"));
  ({ checkIMessageResourceBinding } = await import("./message-resource-db.js"));
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-imessage-resource-"));
  dbPath = path.join(tempDir, "chat.db");
  const binDir = path.join(tempDir, "bin");
  const libexecDir = path.join(tempDir, "libexec");
  const binaryPath = path.join(libexecDir, "imsg");
  cliPath = path.join(binDir, "imsg");
  fs.mkdirSync(binDir);
  fs.mkdirSync(libexecDir);
  fs.writeFileSync(binaryPath, Buffer.from("cafebabe", "hex"));
  fs.writeFileSync(cliPath, `#!/bin/bash\nexec "${binaryPath}" "$@"\n`);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, guid TEXT);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    INSERT INTO chat(ROWID, chat_identifier, guid) VALUES
      (1, '+15550001111', 'iMessage;-;+15550001111'),
      (2, 'other', 'iMessage;+;Some@example.com'),
      (3, '+15550002222', 'SMS;-;+15550002222'),
      (4, 'Üser@Example.com', 'iMessage;-;Üser@Example.com');
    INSERT INTO message(ROWID, guid) VALUES
      (10, 'message-guid'),
      (11, 'sms-message-guid'),
      (12, 'email-message-guid'),
      (13, 'other-message-guid');
    INSERT INTO chat_message_join(chat_id, message_id) VALUES
      (1, 10),
      (3, 11),
      (4, 12),
      (2, 13);
  `);
  db.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

type Authorization = Parameters<MessageResourceModule["authorizeIMessageResourceReference"]>[0];
const PHONE_CHAT = "iMessage;-;+15550001111";
const EMAIL_CHAT = "iMessage;-;üser@example.com";
const OTHER_CHAT = "iMessage;+;other";

function authorize(overrides: Partial<Authorization> = {}) {
  return authorizeIMessageResourceReference({
    accountId: "default",
    chatContext: { chatId: 1 },
    cliPath,
    dbPath,
    hasExclusiveLocalDatabase: true,
    messageId: "message-guid",
    ...overrides,
  });
}

function check(
  chatContext: Authorization["chatContext"],
  messageId = "message-guid",
  cli = cliPath,
) {
  return checkIMessageResourceBinding({ chatContext, messageId, cliPath: cli, dbPath });
}

function remember(
  messageId: string,
  overrides: Partial<Parameters<ReplyCacheModule["rememberIMessageReplyCache"]>[0]> = {},
) {
  return rememberIMessageReplyCache({
    accountId: "work",
    messageId,
    chatGuid: "any;-;+15550001111",
    timestamp: Date.now(),
    ...overrides,
  });
}

describe("iMessage provider resource binding", () => {
  it.each(["action", "reply"] as const)(
    "authorizes %s through SQLite when cached selectors are incomparable, without caller-thread queries",
    async (entrypoint) => {
      await remember("message-guid", { accountId: "default", chatGuid: undefined, chatId: 1 });
      const { imessageMessageActions } = await import("./actions.js");
      const { sendMessageIMessage } = await import("./send.js");
      const { setCachedIMessagePrivateApiStatus } = await import("./private-api-status.js");
      const cli = await import("./cli-output.js");
      setCachedIMessagePrivateApiStatus(cliPath, {
        available: true,
        v2Ready: true,
        selectors: {},
        rpcMethods: [],
      });
      const nativeSend = vi.spyOn(cli, "runIMessageCliJsonCommand").mockResolvedValue({});
      const client = new IMessageRpcClient({ dbPath });
      const request = vi.spyOn(client, "request").mockResolvedValue({ guid: "sent-guid" });
      const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
      const all = vi.spyOn(StatementSync.prototype, "all");
      const close = vi.spyOn(DatabaseSync.prototype, "close");
      const calibration = new DatabaseSync(dbPath, { readOnly: true });
      calibration.prepare("SELECT guid FROM message").all();
      calibration.close();
      expect(prepare).toHaveBeenCalledOnce();
      expect(all).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      vi.clearAllMocks();

      const config = { channels: { imessage: { cliPath, dbPath } } };
      const invoke = (
        chatGuid: string,
        conversationReadOrigin: "delegated" | "direct-operator" = "delegated",
      ) =>
        entrypoint === "action"
          ? imessageMessageActions.handleAction!({
              channel: "imessage",
              action: "react",
              cfg: config,
              params: { chatGuid, messageId: "message-guid", emoji: "❤️" },
              conversationReadOrigin,
            })
          : sendMessageIMessage(`chat_guid:${chatGuid}`, "synthetic reply", {
              config,
              client,
              replyToId: "message-guid",
              conversationReadOrigin,
            });
      const sent = entrypoint === "action" ? nativeSend : request;
      await invoke(PHONE_CHAT);
      expect(sent).toHaveBeenCalledOnce();
      for (const origin of ["delegated", "direct-operator"] as const) {
        await expect(invoke(OTHER_CHAT, origin)).rejects.toThrow(
          "does not belong to the selected conversation",
        );
      }
      expect(sent).toHaveBeenCalledOnce();
      expect(prepare.mock.calls.filter(([sql]) => /\bFROM\s+"?message"?\b/iu.test(sql))).toEqual(
        [],
      );
      expect(all).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    },
  );

  it("joins reader cleanup before reply dispatch and rechecks the caller's live authority", async () => {
    // Hydrate the independent reply cache before retaining the Messages reader below.
    await resolveIMessageCachedResourceBinding("message-guid", { accountId: "default", chatId: 1 });
    const { sendMessageIMessage } = await import("./send.js");
    const sqlite = await import("openclaw/plugin-sdk/sqlite-runtime");
    const open = sqlite.openSqliteWorkerStore;
    const closing = createDeferred<void>();
    const release = createDeferred<void>();
    vi.spyOn(sqlite, "openSqliteWorkerStore").mockImplementation(async (options) => {
      const store = await open(options);
      if (!store) {
        throw new Error("synthetic Messages database unavailable");
      }
      return {
        execute: (command, executeOptions) => store.execute(command, executeOptions),
        close: async () => {
          closing.resolve();
          await release.promise;
          await store.close();
        },
      };
    });
    const client = new IMessageRpcClient({ dbPath });
    const request = vi.spyOn(client, "request").mockResolvedValue({ guid: "should-not-send" });
    let active = true;
    let settled = false;
    const sending = sendMessageIMessage("chat_id:1", "synthetic reply", {
      config: { channels: { imessage: { cliPath, dbPath } } },
      client,
      replyToId: "message-guid",
      conversationReadOrigin: "delegated",
      assertDirectAdapterHandoff: () => {
        if (!active) {
          throw new Error("synthetic caller revoked");
        }
      },
    });
    const markSettled = () => {
      settled = true;
    };
    void sending.then(markSettled, markSettled);
    try {
      await Promise.race([closing.promise, sending]);
      expect(settled).toBe(false);
      expect(request).not.toHaveBeenCalled();
      active = false;
    } finally {
      release.resolve();
    }
    await expect(sending).rejects.toThrow("synthetic caller revoked");
    expect(request).not.toHaveBeenCalled();
  });

  it("only treats canonical handles as authoritative chat identifiers", () => {
    const formatted = "+1 (206) 555-0100";
    for (const [to, service, effective, identifier] of [
      ["Jane Appleseed", "auto", undefined, undefined],
      ["206 555 0100", "auto", undefined, undefined],
      [formatted, "auto", undefined, undefined],
      [formatted, "auto", "sms", "SMS;-;+12065550100"],
      [formatted, "imessage", "sms", "iMessage;-;+12065550100"],
      ["User@Example.com", "sms", undefined, "SMS;-;user@example.com"],
    ] as const) {
      expect(chatContextFromIMessageTarget({ kind: "handle", to, service }, effective)).toEqual(
        identifier ? { chatIdentifier: identifier } : {},
      );
    }
  });

  it("requires a current positive account and chat cache match", async () => {
    const cached = (
      messageId: string,
      context: Authorization["chatContext"] & { accountId?: string },
    ) => resolveIMessageCachedResourceBinding(messageId, { accountId: "work", ...context });
    await remember("bound-guid", { chatIdentifier: "+15550001111", chatId: 1 });
    await remember("mixed-case-email-guid", { chatGuid: "any;-;User@Example.com" });
    await remember("guid-only");
    await remember("stale-guid", {
      accountId: "default",
      chatGuid: undefined,
      chatId: 42,
      timestamp: Date.now() - 7 * 60 * 60 * 1000,
    });
    for (const [id, context, expected] of [
      ["bound-guid", { chatIdentifier: PHONE_CHAT }, "match"],
      ["mixed-case-email-guid", { chatIdentifier: "iMessage;-;user@example.com" }, "match"],
      ["bound-guid", { accountId: "personal", chatIdentifier: PHONE_CHAT }, "mismatch"],
      ["guid-only", { chatId: 1 }, "unknown"],
      ["bound-guid", { chatId: 99 }, "mismatch"],
      ["bound-guid", { chatGuid: OTHER_CHAT, chatIdentifier: PHONE_CHAT }, "mismatch"],
      ["stale-guid", { accountId: "default", chatId: 42 }, "unknown"],
    ] as const) {
      expect(await cached(id, context)).toBe(expected);
    }
  });

  it("matches part-prefixed message ids only in their database chat", async () => {
    for (const [context, id, expected] of [
      [{ chatId: 1 }, "p:0/message-guid", "match"],
      [{ chatGuid: "imessage;-;+15550001111" }, undefined, "match"],
      [{ chatGuid: "sms;-;+15550002222" }, "sms-message-guid", "match"],
      [{ chatIdentifier: EMAIL_CHAT }, "email-message-guid", "match"],
      [{ chatGuid: EMAIL_CHAT }, "email-message-guid", "match"],
      [{ chatIdentifier: "iMessage;-;other@example.com" }, "email-message-guid", "mismatch"],
      [{ chatId: 2 }, undefined, "mismatch"],
      [{ chatGuid: "iMessage;+;+15550001111" }, undefined, "mismatch"],
      [{ chatGuid: "iMessage;+;Some@example.com" }, "other-message-guid", "match"],
      [{ chatGuid: "iMessage;+;some@example.com" }, "other-message-guid", "mismatch"],
      [{ chatIdentifier: "SMS;-;+15550001111" }, undefined, "mismatch"],
      [
        { chatId: 1, chatGuid: "any;-;+15550001111", chatIdentifier: PHONE_CHAT },
        undefined,
        "match",
      ],
      [{ chatGuid: OTHER_CHAT, chatIdentifier: PHONE_CHAT }, undefined, "mismatch"],
      [{ chatId: 1, chatGuid: OTHER_CHAT }, undefined, "mismatch"],
      [{ chatIdentifier: "unknown;-;+15550001111" }, undefined, "mismatch"],
    ] as const) {
      expect(await check(context, id)).toBe(expected);
    }
  });

  const remote = {
    cliPath: "/tmp/remote-imsg-wrapper",
    hasExclusiveLocalDatabase: false,
    remoteHost: "qa@example.invalid",
  };

  it("uses positive cache attestation for remote delegated calls", async () => {
    await remember("remote-guid");
    const params = {
      ...remote,
      accountId: "work",
      chatContext: { chatIdentifier: PHONE_CHAT },
      messageId: "remote-guid",
      conversationReadOrigin: "delegated",
    };
    await expect(authorize(params)).resolves.toBeUndefined();
    await expect(authorize({ ...params, messageId: "p:0/remote-guid" })).resolves.toBeUndefined();
    await expect(authorize({ ...params, accountId: "personal" })).rejects.toThrow(
      "different account or conversation",
    );
  });

  it.each(["account-ambiguous", "missing", "malformed", "handle alias"])(
    "refuses delegated authorization without attestation: %s",
    async (state) => {
      const params: Partial<Authorization> = {};
      if (state === "account-ambiguous") {
        Object.assign(params, {
          accountId: "work",
          chatContext: { chatIdentifier: PHONE_CHAT },
          hasExclusiveLocalDatabase: false,
        });
      } else if (state === "handle alias") {
        params.chatContext = {};
        expect(await check({})).toBe("unavailable");
      } else {
        fs.rmSync(dbPath);
        if (state === "malformed") {
          fs.writeFileSync(dbPath, "synthetic invalid database");
        }
      }
      await expect(authorize({ ...params, conversationReadOrigin: "delegated" })).rejects.toThrow(
        "require a current same-account conversation binding",
      );
      await expect(
        authorize({ ...params, conversationReadOrigin: "direct-operator" }),
      ).resolves.toBeUndefined();
      if (state === "missing") {
        expect(fs.existsSync(dbPath)).toBe(false);
      }
    },
  );

  it("does not treat a configured database as local for an SSH imsg wrapper", async () => {
    const wrapperPath = path.join(tempDir, "wrapper", "imsg");
    fs.mkdirSync(path.dirname(wrapperPath));
    fs.writeFileSync(wrapperPath, '#!/bin/sh\nexec ssh qa.example.invalid imsg "$@"\n');
    expect(await check({ chatId: 1 }, "message-guid", wrapperPath)).toBe("unavailable");
  });

  it("does not trust a PATH wrapper whose remote command is hidden behind variables", async () => {
    const wrapperDir = path.join(tempDir, "path-wrapper");
    fs.mkdirSync(wrapperDir);
    fs.writeFileSync(
      path.join(wrapperDir, "imsg"),
      '#!/bin/sh\nhost=qa.example.invalid\nexec ssh "$host" imsg "$@"\n',
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", wrapperDir);
    expect(await check({ chatId: 1 }, "message-guid", "imsg")).toBe("unavailable");
  });
});
