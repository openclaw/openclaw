import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { describe, expect, it } from "vitest";
import {
  readFinalContentIdentity,
  readSessionProjectionFinalMessageIdentity,
} from "./session-projection-final-identity.js";

const reply = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const digest = (value: unknown) =>
  `content:sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;

describe("terminal content fingerprints", () => {
  it.each([
    { name: "plain text", text: "complete reply" },
    { name: "non-BMP text", text: "🦊𝄞" },
    { name: "lone high surrogate", text: String.fromCharCode(0xd800) },
    { name: "lone low surrogate", text: String.fromCharCode(0xdfff) },
    { name: "literal escape", text: "\\ud800" },
  ])("hashes the complete canonical bytes for $name", ({ text }) => {
    const identity = readFinalContentIdentity(reply(text));
    expect(identity).toBe(digest(["assistant", text, null, null, null]));
    expect(identity).toMatch(/^content:sha256:[a-f0-9]{64}$/u);
  });

  it("keeps lone surrogates distinct from replacement characters and escape text", () => {
    const keys = [String.fromCharCode(0xd800), String.fromCharCode(0xdfff), "�", "\\ud800"].map(
      (text) => readFinalContentIdentity(reply(text)),
    );
    expect(new Set(keys).size).toBe(4);
  });

  it("preserves the rich-content, media, and import tuple with deterministic key order", () => {
    const image = { type: "image", source: { data: "synthetic", mediaType: "image/png" } };
    const content = [{ type: "text", text: "rich reply" }, image];
    const attachment = { url: "https://example.com/image.png", mimeType: "image/png" };
    const media = [attachment];
    const metadata = {
      media,
      importedFrom: "fixture",
      cliSessionId: "source",
      externalId: "entry",
    };
    const message = { role: "assistant", content, __openclaw: metadata };
    const identity = readFinalContentIdentity(message);
    expect(identity).toBe(
      digest(["assistant", "rich reply", content, media, ["fixture", "source", "entry"]]),
    );
    expect(
      readFinalContentIdentity({
        ...message,
        content: [
          content[0],
          { source: { mediaType: "image/png", data: "synthetic" }, type: "image" },
        ],
        __openclaw: { ...metadata, media: [{ mimeType: "image/png", url: attachment.url }] },
      }),
    ).toBe(identity);
    for (const changed of [
      { ...message, role: "user" },
      {
        ...message,
        content: [content[0], { ...image, source: { ...image.source, data: "other" } }],
      },
      {
        ...message,
        __openclaw: {
          ...metadata,
          media: [{ ...attachment, url: "https://example.com/other.png" }],
        },
      },
      { ...message, __openclaw: { ...metadata, importedFrom: "other" } },
      { ...message, __openclaw: { ...metadata, cliSessionId: "other" } },
      { ...message, __openclaw: { ...metadata, externalId: "other" } },
    ]) {
      expect(readFinalContentIdentity(changed)).not.toBe(identity);
    }
  });

  it("projects status notices before fingerprinting the terminal reply", () => {
    const message = reply("accepted answer");
    expect(
      readFinalContentIdentity({
        ...message,
        content: [
          { type: "text", text: "status diagnostic", openclawStatusNotice: true },
          ...message.content,
        ],
      }),
    ).toBe(readFinalContentIdentity(message));
    expect(readFinalContentIdentity(reply(""))).toBeNull();
  });

  it.each([
    {
      metadata: {
        importedFrom: "fixture",
        cliSessionId: "source",
        externalId: "entry",
        id: "row",
        seq: 4,
        idempotencyKey: "send",
      },
      expected: 'import:assistant:["fixture","source","entry"]',
    },
    { metadata: { id: "row", seq: 4, idempotencyKey: "send" }, expected: "id:assistant:row" },
    { metadata: { seq: 4, idempotencyKey: "send" }, expected: "seq:assistant:4" },
    { metadata: { idempotencyKey: "send" }, expected: "key:assistant:send" },
  ])("preserves persisted identity precedence: $expected", ({ metadata, expected }) => {
    expect(
      readSessionProjectionFinalMessageIdentity({
        ...reply("unrelated content"),
        __openclaw: metadata,
      }),
    ).toBe(expected);
  });
});
