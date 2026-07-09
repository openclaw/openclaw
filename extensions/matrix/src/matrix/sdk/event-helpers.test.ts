// Matrix tests cover event helpers plugin behavior.
import type { MatrixEvent } from "matrix-js-sdk/lib/matrix.js";
import { describe, expect, it } from "vitest";
import { buildHttpError, matrixEventToRaw, parseMxc } from "./event-helpers.js";

const makeEditedMessageEvent = (): MatrixEvent =>
  ({
    getId: () => "$root",
    getSender: () => "@alice:example.org",
    getType: () => "m.room.message",
    getTs: () => 1000,
    getOriginalContent: () => ({ body: "original", msgtype: "m.text" }),
    getContent: () => ({
      body: "@bot edited",
      "m.mentions": { user_ids: ["@bot:example.org"] },
      msgtype: "m.text",
    }),
    getUnsigned: () => ({
      "m.relations": {
        "m.replace": { event_id: "$edit" },
      },
    }),
  }) as unknown as MatrixEvent;

describe("event-helpers", () => {
  it("parses mxc URIs", () => {
    expect(parseMxc("mxc://server.example/media-id")).toEqual({
      server: "server.example",
      mediaId: "media-id",
    });
    expect(parseMxc("not-mxc")).toBeNull();
  });

  it("builds HTTP errors from JSON and plain text payloads", () => {
    const fromJson = buildHttpError(403, JSON.stringify({ error: "forbidden" }));
    expect(fromJson.message).toBe("forbidden");
    expect(fromJson.statusCode).toBe(403);

    const fromText = buildHttpError(500, "internal failure");
    expect(fromText.message).toBe("internal failure");
    expect(fromText.statusCode).toBe(500);
  });

  it("buildHttpError keeps the 500-char plain-text body truncation UTF-16 safe at emoji boundaries", () => {
    // 498 ASCII chars + emoji (😀 = U+1F600, UTF-16 surrogate pair) = 500 code units.
    // A naive .slice(0, 500) would land on the high surrogate and return a dangling
    // high surrogate (charCode 0xD83D), which downstream string consumers render
    // as U+FFFD / mojibake. truncateUtf16Safe trims the orphan high surrogate
    // and returns 499 code units ending cleanly before the emoji.
    const ascii = "a".repeat(498);
    const emoji = "😀"; // 2 UTF-16 code units
    const bodyText = ascii + emoji + "tail";
    const error = buildHttpError(500, bodyText);
    expect(error.message.length).toBe(499);
    expect(error.message).toBe(ascii);
    expect(error.message.charCodeAt(error.message.length - 1)).not.toBe(0xd83d);
  });

  it("buildHttpError keeps a non-parseable JSON body truncation UTF-16 safe at emoji boundaries", () => {
    // 498 ASCII chars + emoji = 500 code units. The try/catch branch falls back
    // to truncateUtf16Safe(bodyText, 500); before this fix the same dangling
    // high surrogate would have leaked into the error message.
    const ascii = "b".repeat(498);
    const emoji = "🎉"; // 2 UTF-16 code units
    const bodyText = "not-json " + ascii + emoji + "more";
    const error = buildHttpError(502, bodyText);
    // The slice lands on the high surrogate of 🎉, which truncateUtf16Safe
    // trims — final length is 499 code units (one less than the cap).
    expect(error.message.length).toBe(499);
    // Final code unit is the 498th ASCII 'b' (0x62), not a dangling high surrogate.
    expect(error.message.charCodeAt(error.message.length - 1)).toBe(0x62);
    expect(error.message).not.toMatch(/�/);
  });

  it("serializes Matrix events and resolves state key from available sources", () => {
    const viaGetter = {
      getId: () => "$1",
      getSender: () => "@alice:example.org",
      getType: () => "m.room.member",
      getTs: () => 1000,
      getContent: () => ({ membership: "join" }),
      getUnsigned: () => ({ age: 1 }),
      getStateKey: () => "@alice:example.org",
    } as unknown as MatrixEvent;
    expect(matrixEventToRaw(viaGetter).state_key).toBe("@alice:example.org");

    const viaWire = {
      getId: () => "$2",
      getSender: () => "@bob:example.org",
      getType: () => "m.room.member",
      getTs: () => 2000,
      getContent: () => ({ membership: "join" }),
      getUnsigned: () => ({}),
      getStateKey: () => undefined,
      getWireContent: () => ({ state_key: "@bob:example.org" }),
    } as unknown as MatrixEvent;
    expect(matrixEventToRaw(viaWire).state_key).toBe("@bob:example.org");

    const viaRaw = {
      getId: () => "$3",
      getSender: () => "@carol:example.org",
      getType: () => "m.room.member",
      getTs: () => 3000,
      getContent: () => ({ membership: "join" }),
      getUnsigned: () => ({}),
      getStateKey: () => undefined,
      event: { state_key: "@carol:example.org" },
    } as unknown as MatrixEvent;
    expect(matrixEventToRaw(viaRaw).state_key).toBe("@carol:example.org");
  });

  it("serializes current content by default for read APIs", () => {
    expect(matrixEventToRaw(makeEditedMessageEvent())).toEqual({
      event_id: "$root",
      sender: "@alice:example.org",
      type: "m.room.message",
      origin_server_ts: 1000,
      content: {
        body: "@bot edited",
        "m.mentions": { user_ids: ["@bot:example.org"] },
        msgtype: "m.text",
      },
      unsigned: {
        "m.relations": {
          "m.replace": { event_id: "$edit" },
        },
      },
    });
  });

  it("preserves original thread relation when serializing edited current content", () => {
    const event = {
      getId: () => "$root",
      getSender: () => "@alice:example.org",
      getType: () => "m.room.message",
      getTs: () => 1000,
      getOriginalContent: () => ({
        body: "original",
        msgtype: "m.text",
        "m.relates_to": {
          rel_type: "m.thread",
          event_id: "$thread",
        },
      }),
      getContent: () => ({
        body: "@bot edited",
        "m.mentions": { user_ids: ["@bot:example.org"] },
        msgtype: "m.text",
      }),
      getUnsigned: () => ({}),
    } as unknown as MatrixEvent;

    expect(matrixEventToRaw(event).content["m.relates_to"]).toEqual({
      rel_type: "m.thread",
      event_id: "$thread",
    });
  });

  it("preserves wire thread relation for decrypted encrypted events", () => {
    const event = {
      getId: () => "$encrypted",
      getSender: () => "@alice:example.org",
      getType: () => "m.room.message",
      getTs: () => 1000,
      getContent: () => ({
        body: "decrypted edit",
        msgtype: "m.text",
      }),
      getUnsigned: () => ({}),
      getWireContent: () => ({
        "m.relates_to": {
          rel_type: "m.thread",
          event_id: "$thread",
        },
      }),
    } as unknown as MatrixEvent;

    expect(matrixEventToRaw(event).content["m.relates_to"]).toEqual({
      rel_type: "m.thread",
      event_id: "$thread",
    });
  });

  it("can serialize original content for inbound trigger filtering", () => {
    expect(matrixEventToRaw(makeEditedMessageEvent(), { contentMode: "original" })).toEqual({
      event_id: "$root",
      sender: "@alice:example.org",
      type: "m.room.message",
      origin_server_ts: 1000,
      content: { body: "original", msgtype: "m.text" },
      unsigned: {
        "m.relations": {
          "m.replace": { event_id: "$edit" },
        },
      },
    });
  });
});
