import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhatsAppIngressPermanentError } from "./inbound/durable-payload.js";
import {
  listWhatsAppChatPollIds,
  readWhatsAppPollRecord,
  recordWhatsAppPoll,
  WHATSAPP_POLL_CHAT_INDEX_STORES,
  WHATSAPP_POLL_RECORD_STORES,
  WHATSAPP_POLL_TTL_MS,
  type WhatsAppPollRecordInput,
} from "./poll-vote-store.js";
import {
  installWhatsAppPollStateRuntimeForTest,
  type WhatsAppPollStateRuntimeForTest,
} from "./poll-vote.test-helper.js";
import * as runtimeModule from "./runtime.js";

const HOME = "120363000000000001@g.us";
const OTHER = "120363000000000002@g.us";

function pollInput(overrides: Partial<WhatsAppPollRecordInput> = {}): WhatsAppPollRecordInput {
  return {
    accountId: "default",
    pollMessageId: "POLL1",
    origin: "sent",
    chatJids: [HOME],
    creatorJids: ["15550001111@s.whatsapp.net"],
    question: "Pizza or sushi?",
    secret: new Uint8Array(32).fill(7),
    options: ["Pizza", "Sushi"],
    selectableCount: 1,
    recordedAt: Date.now(),
    ...overrides,
  };
}

let env: WhatsAppPollStateRuntimeForTest;

beforeEach(async () => {
  env = await installWhatsAppPollStateRuntimeForTest();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await env.cleanup();
});

describe("WhatsApp poll record store", () => {
  it("round-trips sent and received polls in separate namespaces", async () => {
    const recordedAt = Date.now();
    expect(await recordWhatsAppPoll(pollInput({ recordedAt }), { mode: "overwrite" })).toBe(true);
    expect(
      await recordWhatsAppPoll(
        pollInput({
          pollMessageId: "POLL2",
          origin: "received",
          creatorName: "Dana",
          recordedAt,
        }),
        { mode: "ifAbsent" },
      ),
    ).toBe(true);

    expect(await readWhatsAppPollRecord("default", "POLL1")).toEqual({
      v: 1,
      origin: "sent",
      chatJids: [HOME],
      creatorJids: ["15550001111@s.whatsapp.net"],
      question: "Pizza or sushi?",
      secret: Buffer.from(new Uint8Array(32).fill(7)).toString("base64"),
      options: ["Pizza", "Sushi"],
      selectableCount: 1,
      recordedAt,
    });
    expect(await readWhatsAppPollRecord("default", "POLL2")).toMatchObject({
      origin: "received",
      creatorName: "Dana",
    });

    const sentRows = await env.openStore(WHATSAPP_POLL_RECORD_STORES.sent).entries();
    const receivedRows = await env.openStore(WHATSAPP_POLL_RECORD_STORES.received).entries();
    expect(sentRows.map((row) => row.key)).toEqual(["default:POLL1"]);
    expect(receivedRows.map((row) => row.key)).toEqual(["default:POLL2"]);
  });

  it("(a) keeps an old sent poll readable after 2001 incoming polls", async () => {
    const now = Date.now();
    await recordWhatsAppPoll(pollInput({ pollMessageId: "OURS", recordedAt: now - 1000 }), {
      mode: "overwrite",
    });
    const received = env.openStore(WHATSAPP_POLL_RECORD_STORES.received);
    for (let index = 0; index < 2001; index++) {
      await received.register(`default:IN${index}`, { flood: index });
    }
    expect(await received.count()).toBe(2000);
    expect(await readWhatsAppPollRecord("default", "OURS")).toMatchObject({ origin: "sent" });
  });

  it("(a) keeps the agent's poll in the chat index after more than 8000 incoming index rows", async () => {
    const now = Date.now();
    await recordWhatsAppPoll(pollInput({ pollMessageId: "OURS", recordedAt: now - 1000 }), {
      mode: "overwrite",
    });
    const receivedIndex = env.openStore(WHATSAPP_POLL_CHAT_INDEX_STORES.received);
    for (let index = 0; index < 8001; index++) {
      await receivedIndex.register(`default:${OTHER}:${String(now).padStart(13, "0")}:IN${index}`, {
        v: 1,
        pollMessageId: `IN${index}`,
        origin: "received",
      });
    }
    expect(await receivedIndex.count()).toBe(8000);
    expect(
      await listWhatsAppChatPollIds({ accountId: "default", chatJids: [HOME], limit: 3 }),
    ).toEqual([{ pollMessageId: "OURS", origin: "sent", recordedAt: now - 1000 }]);
  }, 120_000);

  it("isolates accounts and does not overwrite in ifAbsent mode", async () => {
    await recordWhatsAppPoll(pollInput(), { mode: "overwrite" });
    expect(await readWhatsAppPollRecord("work", "POLL1")).toBeUndefined();
    expect(
      await listWhatsAppChatPollIds({ accountId: "work", chatJids: [HOME], limit: 3 }),
    ).toEqual([]);

    await recordWhatsAppPoll(pollInput({ origin: "received", pollMessageId: "IN1" }), {
      mode: "ifAbsent",
    });
    expect(
      await recordWhatsAppPoll(
        pollInput({ origin: "received", pollMessageId: "IN1", question: "Changed?" }),
        { mode: "ifAbsent" },
      ),
    ).toBe(false);
    expect(await readWhatsAppPollRecord("default", "IN1")).toMatchObject({
      question: "Pizza or sushi?",
    });
  });

  it("writes one index row per chat JID, lists newest first with a limit, and expires with the record", async () => {
    const base = Date.now() - 10_000;
    const writeStartedAt = Date.now();
    await recordWhatsAppPoll(
      pollInput({
        pollMessageId: "A",
        chatJids: ["15550002222@s.whatsapp.net", "777@lid"],
        recordedAt: base,
      }),
      { mode: "overwrite" },
    );
    await recordWhatsAppPoll(
      pollInput({
        pollMessageId: "B",
        origin: "received",
        chatJids: ["15550002222@s.whatsapp.net"],
        recordedAt: base + 1,
      }),
      { mode: "ifAbsent" },
    );
    await recordWhatsAppPoll(
      pollInput({ pollMessageId: "C", chatJids: ["777@lid"], recordedAt: base + 2 }),
      { mode: "overwrite" },
    );

    // The store stamps expiry at write time; a cold SQLite open can delay that by seconds.
    const writeWindowMs = Date.now() - writeStartedAt;
    const indexRows = await env.openStore(WHATSAPP_POLL_CHAT_INDEX_STORES.sent).entries();
    expect(indexRows.map((row) => row.key).toSorted()).toEqual(
      [
        `default:15550002222@s.whatsapp.net:${String(base).padStart(13, "0")}:A`,
        `default:777@lid:${String(base).padStart(13, "0")}:A`,
        `default:777@lid:${String(base + 2).padStart(13, "0")}:C`,
      ].toSorted(),
    );
    const listed = await listWhatsAppChatPollIds({
      accountId: "default",
      chatJids: ["15550002222@s.whatsapp.net", "777@lid"],
      limit: 3,
    });
    expect(listed.map((entry) => entry.pollMessageId)).toEqual(["C", "B", "A"]);
    expect(
      (
        await listWhatsAppChatPollIds({
          accountId: "default",
          chatJids: ["15550002222@s.whatsapp.net", "777@lid"],
          limit: 2,
        })
      ).map((entry) => entry.pollMessageId),
    ).toEqual(["C", "B"]);

    const [record] = await env.openStore(WHATSAPP_POLL_RECORD_STORES.sent).entries();
    const expected = base + WHATSAPP_POLL_TTL_MS;
    for (const expiresAt of [
      record?.expiresAt,
      ...indexRows.filter((entry) => entry.key.endsWith(":A")).map((row) => row.expiresAt),
    ]) {
      const drift = (expiresAt ?? 0) - expected;
      expect(drift).toBeGreaterThanOrEqual(0);
      expect(drift).toBeLessThanOrEqual(writeWindowMs);
    }
  });

  it("writes the record but no index row when the index key exceeds 512 bytes", async () => {
    const longChat = `${"9".repeat(500)}@g.us`;
    expect(
      await recordWhatsAppPoll(pollInput({ chatJids: [longChat] }), { mode: "overwrite" }),
    ).toBe(true);
    expect(await readWhatsAppPollRecord("default", "POLL1")).toBeDefined();
    expect(await env.openStore(WHATSAPP_POLL_CHAT_INDEX_STORES.sent).entries()).toEqual([]);
  });

  it.each([
    "PLUGIN_STATE_READ_FAILED",
    "PLUGIN_STATE_OPEN_FAILED",
    "PLUGIN_STATE_SQLITE_UNAVAILABLE",
  ])("(b) rethrows transient %s so ingress replays", async (code) => {
    env.faults.push({
      namespace: WHATSAPP_POLL_RECORD_STORES.sent.namespace,
      method: "lookup",
      code,
    });
    const error = await readWhatsAppPollRecord("default", "POLL1").catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code });
    expect(error).not.toBeInstanceOf(WhatsAppIngressPermanentError);
    expect(env.logger.warn).not.toHaveBeenCalled();
  });

  it.each(["PLUGIN_STATE_CORRUPT", "PLUGIN_STATE_INVALID_INPUT", undefined])(
    "(b) resolves permanent failure %s to undefined with one warning",
    async (code) => {
      env.faults.push({
        namespace: WHATSAPP_POLL_RECORD_STORES.sent.namespace,
        method: "lookup",
        code,
      });
      expect(await readWhatsAppPollRecord("default", "POLL1")).toBeUndefined();
      expect(env.logger.warn).toHaveBeenCalledTimes(1);
      expect(env.logger.warn).toHaveBeenCalledWith("whatsapp poll store read failed", {
        code: code ?? "unknown",
      });
    },
  );

  it("(b) classifies a real store PLUGIN_STATE_INVALID_INPUT as permanent", async () => {
    // A 600-byte account id makes the real store reject the 512-byte key limit itself.
    expect(await readWhatsAppPollRecord("a".repeat(600), "POLL1")).toBeUndefined();
    expect(env.logger.warn).toHaveBeenCalledTimes(1);
    expect(env.logger.warn).toHaveBeenCalledWith("whatsapp poll store read failed", {
      code: "PLUGIN_STATE_INVALID_INPUT",
    });
  });

  it("(c) keeps empty and over-128-byte poll ids away from storage", async () => {
    for (const id of ["x".repeat(600), "x".repeat(129), "   ", ""]) {
      expect(await readWhatsAppPollRecord("default", id)).toBeUndefined();
      expect(
        await recordWhatsAppPoll(pollInput({ pollMessageId: id }), { mode: "overwrite" }),
      ).toBe(false);
    }
    expect(env.opened.size).toBe(0);

    const id128 = "x".repeat(128);
    expect(
      await recordWhatsAppPoll(pollInput({ pollMessageId: id128 }), { mode: "overwrite" }),
    ).toBe(true);
    expect(await readWhatsAppPollRecord("default", id128)).toBeDefined();
  });

  it("(c) keeps a peer-chosen poll id from reaching another account's keys", async () => {
    await recordWhatsAppPoll(pollInput({ accountId: "a:b", pollMessageId: "X" }), {
      mode: "overwrite",
    });
    expect(await readWhatsAppPollRecord("a", "b:X")).toBeUndefined();
    expect(
      await recordWhatsAppPoll(pollInput({ accountId: "a", pollMessageId: "b:Y" }), {
        mode: "overwrite",
      }),
    ).toBe(false);
    expect(await readWhatsAppPollRecord("a:b", "Y")).toBeUndefined();
    const rows = await env.openStore(WHATSAPP_POLL_RECORD_STORES.sent).entries();
    expect(rows.map((row) => row.key)).toEqual(["a%3Ab:X"]);
  });

  it("returns undefined or false when the runtime is missing", async () => {
    vi.spyOn(runtimeModule, "getOptionalWhatsAppRuntime").mockReturnValue(null);
    expect(await recordWhatsAppPoll(pollInput(), { mode: "overwrite" })).toBe(false);
    expect(await readWhatsAppPollRecord("default", "POLL1")).toBeUndefined();
    expect(
      await listWhatsAppChatPollIds({ accountId: "default", chatJids: [HOME], limit: 3 }),
    ).toEqual([]);
  });

  it("truncates the question at a character boundary", async () => {
    await recordWhatsAppPoll(pollInput({ question: "ש".repeat(600) }), { mode: "overwrite" });
    const record = await readWhatsAppPollRecord("default", "POLL1");
    expect(record?.question).toBe("ש".repeat(512));
  });
});
