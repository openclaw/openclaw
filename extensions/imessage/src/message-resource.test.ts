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

describe("iMessage provider resource binding", () => {
  it.each(["action", "reply"] as const)(
    "authorizes an uncached %s through real SQLite without caller-thread native queries",
    async (entrypoint) => {
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
      const invoke = (chatGuid: string) =>
        entrypoint === "action"
          ? imessageMessageActions.handleAction!({
              channel: "imessage",
              action: "react",
              cfg: config,
              params: { chatGuid, messageId: "message-guid", emoji: "❤️" },
              conversationReadOrigin: "delegated",
            })
          : sendMessageIMessage(`chat_guid:${chatGuid}`, "synthetic reply", {
              config,
              client,
              replyToId: "message-guid",
              conversationReadOrigin: "delegated",
            });
      await invoke("iMessage;-;+15550001111");
      expect(entrypoint === "action" ? nativeSend : request).toHaveBeenCalledOnce();
      await expect(invoke("iMessage;+;other")).rejects.toThrow(
        "does not belong to the selected conversation",
      );
      expect(entrypoint === "action" ? nativeSend : request).toHaveBeenCalledOnce();
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
    void sending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
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
    expect(
      chatContextFromIMessageTarget({ kind: "handle", to: "Jane Appleseed", service: "auto" }),
    ).toEqual({});
    expect(
      chatContextFromIMessageTarget({ kind: "handle", to: "206 555 0100", service: "auto" }),
    ).toEqual({});
    expect(
      chatContextFromIMessageTarget({ kind: "handle", to: "+1 (206) 555-0100", service: "auto" }),
    ).toEqual({});
    expect(
      chatContextFromIMessageTarget(
        { kind: "handle", to: "+1 (206) 555-0100", service: "auto" },
        "sms",
      ),
    ).toEqual({ chatIdentifier: "SMS;-;+12065550100" });
    expect(
      chatContextFromIMessageTarget(
        { kind: "handle", to: "+1 (206) 555-0100", service: "imessage" },
        "sms",
      ),
    ).toEqual({ chatIdentifier: "iMessage;-;+12065550100" });
    expect(
      chatContextFromIMessageTarget({ kind: "handle", to: "User@Example.com", service: "sms" }),
    ).toEqual({ chatIdentifier: "SMS;-;user@example.com" });
  });

  it("requires a current positive account and chat cache match", async () => {
    await rememberIMessageReplyCache({
      accountId: "work",
      messageId: "bound-guid",
      chatGuid: "any;-;+15550001111",
      chatIdentifier: "+15550001111",
      chatId: 1,
      timestamp: Date.now(),
    });
    expect(
      await resolveIMessageCachedResourceBinding("bound-guid", {
        accountId: "work",
        chatIdentifier: "iMessage;-;+15550001111",
      }),
    ).toBe("match");

    await rememberIMessageReplyCache({
      accountId: "work",
      messageId: "mixed-case-email-guid",
      chatGuid: "any;-;User@Example.com",
      timestamp: Date.now(),
    });
    expect(
      await resolveIMessageCachedResourceBinding("mixed-case-email-guid", {
        accountId: "work",
        chatIdentifier: "iMessage;-;user@example.com",
      }),
    ).toBe("match");
    expect(
      await resolveIMessageCachedResourceBinding("bound-guid", {
        accountId: "personal",
        chatIdentifier: "iMessage;-;+15550001111",
      }),
    ).toBe("mismatch");

    await rememberIMessageReplyCache({
      accountId: "work",
      messageId: "guid-only",
      chatGuid: "any;-;+15550001111",
      timestamp: Date.now(),
    });
    expect(
      await resolveIMessageCachedResourceBinding("guid-only", {
        accountId: "work",
        chatId: 1,
      }),
    ).toBe("unknown");
    expect(
      await resolveIMessageCachedResourceBinding("bound-guid", {
        accountId: "work",
        chatId: 99,
      }),
    ).toBe("mismatch");
    expect(
      await resolveIMessageCachedResourceBinding("bound-guid", {
        accountId: "work",
        chatGuid: "iMessage;+;other",
        chatIdentifier: "iMessage;-;+15550001111",
      }),
    ).toBe("mismatch");

    await rememberIMessageReplyCache({
      accountId: "default",
      messageId: "stale-guid",
      chatId: 42,
      timestamp: Date.now() - 7 * 60 * 60 * 1000,
    });
    expect(
      await resolveIMessageCachedResourceBinding("stale-guid", {
        accountId: "default",
        chatId: 42,
      }),
    ).toBe("unknown");
  });

  it("matches part-prefixed message ids only in their database chat", async () => {
    expect(
      await checkIMessageResourceBinding({
        chatContext: { chatId: 1 },
        cliPath,
        dbPath,
        messageId: "p:0/message-guid",
      }),
    ).toBe("match");
    expect(
      await checkIMessageResourceBinding({
        chatContext: { chatGuid: "imessage;-;+15550001111" },
        cliPath,
        dbPath,
        messageId: "message-guid",
      }),
    ).toBe("match");
    expect(
      await checkIMessageResourceBinding({
        chatContext: { chatGuid: "sms;-;+15550002222" },
        cliPath,
        dbPath,
        messageId: "sms-message-guid",
      }),
    ).toBe("match");
    expect(
      await checkIMessageResourceBinding({
        chatContext: { chatIdentifier: "iMessage;-;üser@example.com" },
        cliPath,
        dbPath,
        messageId: "email-message-guid",
      }),
    ).toBe("match");
    expect(
      await checkIMessageResourceBinding({
        chatContext: { chatGuid: "iMessage;-;üser@example.com" },
        cliPath,
        dbPath,
        messageId: "email-message-guid",
      }),
    ).toBe("match");
    expect(
      await checkIMessageResourceBinding({
        chatContext: { chatIdentifier: "iMessage;-;other@example.com" },
        cliPath,
        dbPath,
        messageId: "email-message-guid",
      }),
    ).toBe("mismatch");
    expect(
      await checkIMessageResourceBinding({
        chatContext: { chatId: 2 },
        cliPath,
        dbPath,
        messageId: "message-guid",
      }),
    ).toBe("mismatch");
    expect(
      await checkIMessageResourceBinding({
        chatContext: { chatGuid: "iMessage;+;+15550001111" },
        cliPath,
        dbPath,
        messageId: "message-guid",
      }),
    ).toBe("mismatch");
    expect(
      await checkIMessageResourceBinding({
        chatContext: { chatGuid: "iMessage;+;Some@example.com" },
        cliPath,
        dbPath,
        messageId: "other-message-guid",
      }),
    ).toBe("match");
    expect(
      await checkIMessageResourceBinding({
        chatContext: { chatGuid: "iMessage;+;some@example.com" },
        cliPath,
        dbPath,
        messageId: "other-message-guid",
      }),
    ).toBe("mismatch");
    expect(
      await checkIMessageResourceBinding({
        chatContext: { chatIdentifier: "SMS;-;+15550001111" },
        cliPath,
        dbPath,
        messageId: "message-guid",
      }),
    ).toBe("mismatch");
    expect(
      await checkIMessageResourceBinding({
        chatContext: {
          chatId: 1,
          chatGuid: "any;-;+15550001111",
          chatIdentifier: "iMessage;-;+15550001111",
        },
        cliPath,
        dbPath,
        messageId: "message-guid",
      }),
    ).toBe("match");
    expect(
      await checkIMessageResourceBinding({
        chatContext: {
          chatGuid: "iMessage;+;other",
          chatIdentifier: "iMessage;-;+15550001111",
        },
        cliPath,
        dbPath,
        messageId: "message-guid",
      }),
    ).toBe("mismatch");
    expect(
      await checkIMessageResourceBinding({
        chatContext: { chatId: 1, chatGuid: "iMessage;+;other" },
        cliPath,
        dbPath,
        messageId: "message-guid",
      }),
    ).toBe("mismatch");
    expect(
      await checkIMessageResourceBinding({
        chatContext: { chatIdentifier: "unknown;-;+15550001111" },
        cliPath,
        dbPath,
        messageId: "message-guid",
      }),
    ).toBe("mismatch");
  });

  it("accepts an uncached delegated reference only after a local database match", async () => {
    await expect(
      authorizeIMessageResourceReference({
        accountId: "default",
        chatContext: { chatIdentifier: "iMessage;-;+15550001111" },
        cliPath,
        dbPath,
        hasExclusiveLocalDatabase: true,
        messageId: "message-guid",
        conversationReadOrigin: "delegated",
      }),
    ).resolves.toBeUndefined();
    await expect(
      authorizeIMessageResourceReference({
        accountId: "default",
        chatContext: { chatGuid: "iMessage;+;other" },
        cliPath,
        dbPath,
        hasExclusiveLocalDatabase: true,
        messageId: "message-guid",
        conversationReadOrigin: "delegated",
      }),
    ).rejects.toThrow("does not belong to the selected conversation");
    await expect(
      authorizeIMessageResourceReference({
        accountId: "default",
        chatContext: { chatGuid: "iMessage;+;other" },
        cliPath,
        dbPath,
        hasExclusiveLocalDatabase: true,
        messageId: "message-guid",
        conversationReadOrigin: "direct-operator",
      }),
    ).rejects.toThrow("does not belong to the selected conversation");
  });

  it("uses the local database when cached chat keys are not comparable", async () => {
    await rememberIMessageReplyCache({
      accountId: "default",
      messageId: "message-guid",
      chatGuid: "any;-;+15550001111",
      timestamp: Date.now(),
    });

    await expect(
      authorizeIMessageResourceReference({
        accountId: "default",
        chatContext: { chatId: 1 },
        cliPath,
        dbPath,
        hasExclusiveLocalDatabase: true,
        messageId: "message-guid",
        conversationReadOrigin: "delegated",
      }),
    ).resolves.toBeUndefined();
  });

  it("uses positive cache attestation for remote delegated calls", async () => {
    await rememberIMessageReplyCache({
      accountId: "work",
      messageId: "remote-guid",
      chatGuid: "any;-;+15550001111",
      timestamp: Date.now(),
    });

    await expect(
      authorizeIMessageResourceReference({
        accountId: "work",
        chatContext: { chatIdentifier: "iMessage;-;+15550001111" },
        cliPath: "/tmp/remote-imsg-wrapper",
        hasExclusiveLocalDatabase: false,
        remoteHost: "qa@example.invalid",
        messageId: "remote-guid",
        conversationReadOrigin: "delegated",
      }),
    ).resolves.toBeUndefined();
    await expect(
      authorizeIMessageResourceReference({
        accountId: "work",
        chatContext: { chatIdentifier: "iMessage;-;+15550001111" },
        cliPath: "/tmp/remote-imsg-wrapper",
        hasExclusiveLocalDatabase: false,
        remoteHost: "qa@example.invalid",
        messageId: "p:0/remote-guid",
        conversationReadOrigin: "delegated",
      }),
    ).resolves.toBeUndefined();
    await expect(
      authorizeIMessageResourceReference({
        accountId: "personal",
        chatContext: { chatIdentifier: "iMessage;-;+15550001111" },
        cliPath: "/tmp/remote-imsg-wrapper",
        hasExclusiveLocalDatabase: false,
        remoteHost: "qa@example.invalid",
        messageId: "remote-guid",
        conversationReadOrigin: "delegated",
      }),
    ).rejects.toThrow("different account or conversation");
  });

  it.each([undefined, "delegated", "unknown-origin"])(
    "fails unknown remote references closed for origin %s",
    async (conversationReadOrigin) => {
      await expect(
        authorizeIMessageResourceReference({
          accountId: "default",
          chatContext: { chatId: 1 },
          cliPath: "/tmp/remote-imsg-wrapper",
          hasExclusiveLocalDatabase: false,
          remoteHost: "qa@example.invalid",
          messageId: "unknown-guid",
          conversationReadOrigin,
        }),
      ).rejects.toThrow("require a current same-account conversation binding");
    },
  );

  it("preserves direct operators when remote binding evidence is unavailable", async () => {
    const params = {
      accountId: "default",
      chatContext: { chatId: 1 },
      cliPath: "/tmp/remote-imsg-wrapper",
      hasExclusiveLocalDatabase: false,
      remoteHost: "qa@example.invalid",
      messageId: "unknown-guid",
    };

    await expect(
      authorizeIMessageResourceReference({
        ...params,
        conversationReadOrigin: "direct-operator",
      }),
    ).resolves.toBeUndefined();
  });

  it("does not use an account-ambiguous local database for delegated authorization", async () => {
    await expect(
      authorizeIMessageResourceReference({
        accountId: "work",
        chatContext: { chatIdentifier: "iMessage;-;+15550001111" },
        cliPath,
        dbPath,
        hasExclusiveLocalDatabase: false,
        messageId: "message-guid",
        conversationReadOrigin: "delegated",
      }),
    ).rejects.toThrow("require a current same-account conversation binding");

    await expect(
      authorizeIMessageResourceReference({
        accountId: "work",
        chatContext: { chatIdentifier: "iMessage;-;+15550001111" },
        cliPath,
        dbPath,
        hasExclusiveLocalDatabase: false,
        messageId: "message-guid",
        conversationReadOrigin: "direct-operator",
      }),
    ).resolves.toBeUndefined();
  });

  it.each(["missing", "malformed"] as const)(
    "preserves delegated refusal when the Messages database is %s",
    async (databaseState) => {
      fs.rmSync(dbPath);
      if (databaseState === "malformed") {
        fs.writeFileSync(dbPath, "synthetic invalid database");
      }
      const params = {
        accountId: "default",
        chatContext: { chatId: 1 },
        cliPath,
        dbPath,
        hasExclusiveLocalDatabase: true,
        messageId: "message-guid",
      };
      await expect(authorizeIMessageResourceReference(params)).rejects.toThrow(
        "require a current same-account conversation binding",
      );
      await expect(
        authorizeIMessageResourceReference({
          ...params,
          conversationReadOrigin: "direct-operator",
        }),
      ).resolves.toBeUndefined();
      if (databaseState === "missing") {
        expect(fs.existsSync(dbPath)).toBe(false);
      }
    },
  );

  it("treats provider-resolved handle aliases as unavailable binding evidence", async () => {
    expect(
      await checkIMessageResourceBinding({
        chatContext: {},
        cliPath,
        dbPath,
        messageId: "message-guid",
      }),
    ).toBe("unavailable");
    await expect(
      authorizeIMessageResourceReference({
        accountId: "default",
        chatContext: {},
        cliPath,
        dbPath,
        hasExclusiveLocalDatabase: true,
        messageId: "message-guid",
        conversationReadOrigin: "direct-operator",
      }),
    ).resolves.toBeUndefined();
    await expect(
      authorizeIMessageResourceReference({
        accountId: "default",
        chatContext: {},
        cliPath,
        dbPath,
        hasExclusiveLocalDatabase: true,
        messageId: "message-guid",
        conversationReadOrigin: "delegated",
      }),
    ).rejects.toThrow("require a current same-account conversation binding");
  });

  it("does not treat a configured database as local for an SSH imsg wrapper", async () => {
    const wrapperDir = path.join(tempDir, "wrapper");
    const wrapperPath = path.join(wrapperDir, "imsg");
    fs.mkdirSync(wrapperDir);
    fs.writeFileSync(wrapperPath, '#!/bin/sh\nexec ssh qa.example.invalid imsg "$@"\n');

    expect(
      await checkIMessageResourceBinding({
        chatContext: { chatId: 1 },
        cliPath: wrapperPath,
        dbPath,
        messageId: "message-guid",
      }),
    ).toBe("unavailable");
  });

  it("does not trust a PATH wrapper whose remote command is hidden behind variables", async () => {
    const wrapperDir = path.join(tempDir, "path-wrapper");
    const wrapperPath = path.join(wrapperDir, "imsg");
    fs.mkdirSync(wrapperDir);
    fs.writeFileSync(
      wrapperPath,
      '#!/bin/sh\nhost=qa.example.invalid\nexec ssh "$host" imsg "$@"\n',
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", wrapperDir);

    expect(
      await checkIMessageResourceBinding({
        chatContext: { chatId: 1 },
        cliPath: "imsg",
        dbPath,
        messageId: "message-guid",
      }),
    ).toBe("unavailable");
  });
});
