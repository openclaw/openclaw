import { describe, expect, it } from "vitest";
import { isRawApiErrorPayload, sanitizeUserFacingText } from "./pi-embedded-helpers.js";

describe("sanitizeUserFacingText", () => {
  it("strips final tags", () => {
    expect(sanitizeUserFacingText("<final>Hello</final>")).toBe("Hello");
    expect(sanitizeUserFacingText("Hi <final>there</final>!")).toBe("Hi there!");
  });

  it("does not clobber normal numeric prefixes", () => {
    expect(sanitizeUserFacingText("202 results found")).toBe("202 results found");
    expect(sanitizeUserFacingText("400 days left")).toBe("400 days left");
  });

  it("strips model artifact tags like </s>", () => {
    expect(sanitizeUserFacingText("Hello</s>")).toBe("Hello");
    expect(sanitizeUserFacingText("Hello <s>world</s>")).toBe("Hello world");
  });

  // sanitizeUserFacingText must NOT content-match normal reply text for
  // error keywords. It runs on every assistant reply in the pipeline —
  // if it clobbered replies mentioning "expired", "unauthorized",
  // "401", "permission denied", "timeout", "rate limit", etc., then
  // any time Claw tried to explain one of those situations, its reply
  // would get replaced by a canned error message. Error classification
  // for actual errors lives in formatAssistantErrorText, which only
  // runs on error-tagged messages (stopReason === "error"). The one
  // exception here is a structurally-shaped JSON API error payload,
  // since that shape essentially never occurs in natural text.
  it("passes through legitimate text mentioning 'permission denied'", () => {
    const text = "If you see `permission denied` in your logs, try sudo or check file ACLs.";
    expect(sanitizeUserFacingText(text)).toBe(text);
  });

  it("passes through legitimate text mentioning EACCES", () => {
    const text = "Node reports EACCES when your process lacks permission to open a socket.";
    expect(sanitizeUserFacingText(text)).toBe(text);
  });

  it("passes through legitimate text mentioning 'command line is too long'", () => {
    const text =
      "Windows cmd.exe has an 8191-character limit; you'll see 'The command line is too long' if you exceed it.";
    expect(sanitizeUserFacingText(text)).toBe(text);
  });

  it("passes through legitimate text containing a Node stack-frame-like pattern", () => {
    const text = "Here's the line that threw: (server.js:42:7) — it's a null deref.";
    expect(sanitizeUserFacingText(text)).toBe(text);
  });

  it("passes through legitimate text explaining an expired auth token", () => {
    const text =
      "Your gog token expired because the file keyring backend needs GOG_KEYRING_PASSWORD set. " +
      "Export it and re-authenticate.";
    expect(sanitizeUserFacingText(text)).toBe(text);
  });

  it("passes through legitimate text mentioning 401 and unauthorized", () => {
    const text =
      "When the API returns 401 unauthorized, check that your token hasn't expired and that you're " +
      "hitting the right base URL.";
    expect(sanitizeUserFacingText(text)).toBe(text);
  });

  it("passes through legitimate text mentioning rate limits and 429", () => {
    const text =
      "If you're hitting rate limits (HTTP 429), the API is throttling you. Back off and retry.";
    expect(sanitizeUserFacingText(text)).toBe(text);
  });

  it("passes through legitimate text mentioning timeouts", () => {
    const text =
      "The LLM request timed out — probably because we were doing a lot of back-to-back tool calls.";
    expect(sanitizeUserFacingText(text)).toBe(text);
  });

  it("passes through legitimate text mentioning billing/payment", () => {
    const text =
      "Your Anthropic credit balance is low. Top up before the next batch of requests runs.";
    expect(sanitizeUserFacingText(text)).toBe(text);
  });

  it("passes through legitimate text mentioning role ordering", () => {
    const text =
      "Anthropic returned 'incorrect role information' — that means two user turns landed back-to-back in the history.";
    expect(sanitizeUserFacingText(text)).toBe(text);
  });

  it("passes through legitimate text mentioning context overflow", () => {
    const text =
      "Context length exceeded because the system prompt grew too large. Try compacting the session.";
    expect(sanitizeUserFacingText(text)).toBe(text);
  });

  it("passes through HTTP status phrases in natural text", () => {
    const text =
      "A 500 Internal Server Error from the backend means something broke on the server side.";
    expect(sanitizeUserFacingText(text)).toBe(text);
  });

  it("still reformats structurally-shaped JSON error payloads", () => {
    // Upstream callers (e.g. pi-embedded-subscribe) explicitly pass
    // raw API error JSON into the sanitizer after a shape check — keep
    // that path working via the structural isRawApiErrorPayload check.
    const raw = '{"type":"error","error":{"message":"Something exploded","type":"server_error"}}';
    expect(sanitizeUserFacingText(raw)).toBe("*Something exploded*");
  });

  it("still reformats API Error: prefixed JSON payloads", () => {
    const raw =
      'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_abc"}';
    expect(sanitizeUserFacingText(raw)).toBe("*Overloaded*");
  });

  it("collapses consecutive duplicate paragraphs", () => {
    const text = "Hello there!\n\nHello there!";
    expect(sanitizeUserFacingText(text)).toBe("Hello there!");
  });

  it("does not collapse distinct paragraphs", () => {
    const text = "Hello there!\n\nDifferent line.";
    expect(sanitizeUserFacingText(text)).toBe(text);
  });
});

describe("isRawApiErrorPayload", () => {
  it("detects raw JSON error payloads", () => {
    expect(
      isRawApiErrorPayload(
        '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      ),
    ).toBe(true);
  });

  it("detects API Error prefixed payloads with status code", () => {
    expect(
      isRawApiErrorPayload(
        'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_abc"}',
      ),
    ).toBe(true);
  });

  it("returns false for normal text", () => {
    expect(isRawApiErrorPayload("Hello world")).toBe(false);
  });
});
