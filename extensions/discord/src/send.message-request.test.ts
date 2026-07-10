import { describe, expect, it } from "vitest";
import { buildDiscordMessageRequest } from "./send.message-request.js";

describe("buildDiscordMessageRequest", () => {
  it("enforces a supplied nonce across retries", () => {
    const body = buildDiscordMessageRequest({
      text: "hello",
      nonce: "stable-create-nonce",
    });

    expect(body).toMatchObject({
      content: "hello",
      nonce: "stable-create-nonce",
      enforce_nonce: true,
    });
  });

  it("adds a nonce for each logical create", () => {
    const body = buildDiscordMessageRequest({ text: "hello" });

    expect(body).toMatchObject({
      content: "hello",
      enforce_nonce: true,
    });
    expect(body.nonce).toMatch(/^[0-9a-f]{24}$/);
  });
});
