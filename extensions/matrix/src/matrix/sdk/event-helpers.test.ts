import { MatrixEvent } from "matrix-js-sdk/lib/matrix.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildHttpError,
  getMatrixEventProjection,
  matrixEventToRaw,
  parseMxc,
} from "./event-helpers.js";

function messageEvent(
  overrides: ConstructorParameters<typeof MatrixEvent>[0] = {},
  wire?: Record<string, unknown>,
) {
  const event = new MatrixEvent({
    event_id: "$root",
    sender: "@alice:example.org",
    type: "m.room.message",
    origin_server_ts: 1000,
    content: { body: "original", msgtype: "m.text" },
    ...overrides,
  });
  if (wire) {
    event.makeEncrypted(
      "m.room.encrypted",
      { algorithm: "m.megolm.v1.aes-sha2", ...wire },
      "curve-key",
      "ed-key",
    );
  }
  return event;
}

const unsigned = { "m.relations": { "m.replace": { event_id: "$edit" } } };

describe("event-helpers", () => {
  it("parses mxc URIs", () => {
    expect(parseMxc("mxc://server.example/media-id")).toEqual({
      server: "server.example",
      mediaId: "media-id",
    });
    expect(parseMxc("not-mxc")).toBeNull();
  });

  it("keeps truncated HTTP error bodies UTF-16 safe", () => {
    const parsedPrefix = `{"detail":"${"a".repeat(488)}`;
    const invalidPrefix = `not-json ${"b".repeat(490)}`;

    expect(buildHttpError(500, `${parsedPrefix}😀"}`).message).toBe(parsedPrefix);
    expect(buildHttpError(502, `${invalidPrefix}🎉tail`).message).toBe(invalidPrefix);
  });

  it("preserves reply-only wire relations for encrypted events with clear content", () => {
    const reply = { "m.in_reply_to": { event_id: "$parent" } };
    const event = messageEvent({}, { "m.relates_to": reply });

    expect(matrixEventToRaw(event).content["m.relates_to"]).toEqual(reply);
    expect(matrixEventToRaw(event)).not.toHaveProperty("decryptionFailure");
  });

  it("retains the SDK decryption-failure fact without replacing its display content", () => {
    const content = {
      msgtype: "m.bad.encrypted",
      body: "Synthetic missing session key",
      "m.relates_to": { rel_type: "m.replace", event_id: "$original" },
    };
    const event = messageEvent({ content });
    vi.spyOn(event, "isDecryptionFailure").mockReturnValue(true);
    const raw = matrixEventToRaw(event);
    expect(getMatrixEventProjection(raw)?.decryptionFailure).toBe(true);
    expect(raw.content).toEqual(content);
    const literal = new MatrixEvent({ type: "m.room.message", content: event.getContent() });
    expect(getMatrixEventProjection(matrixEventToRaw(literal))?.decryptionFailure).toBe(false);
    expect(getMatrixEventProjection({ ...raw, decryptionFailure: true })).toBeUndefined();
  });

  it("preserves packed wire state keys when clear state is unavailable", () => {
    const event = messageEvent(
      {
        type: "m.room.member",
        state_key: "@alice:example.org",
        content: { membership: "join" },
      },
      {},
    );
    vi.spyOn(event, "getStateKey").mockReturnValue(undefined);

    expect(matrixEventToRaw(event).state_key).toBe("m.room.member:@alice:example.org");
  });

  it("can serialize original content for inbound trigger filtering", () => {
    const event = messageEvent({ unsigned });
    const edit = { body: "edited", msgtype: "m.text" };
    event.makeReplaced(messageEvent({ content: { "m.new_content": edit } }));
    expect(matrixEventToRaw(event, { contentMode: "original" })).toEqual({
      event_id: "$root",
      sender: "@alice:example.org",
      type: "m.room.message",
      origin_server_ts: 1000,
      content: { body: "original", msgtype: "m.text" },
      unsigned,
    });
  });
});
