import { describe, expect, it } from "vitest";
import {
  getTelegramNetworkErrorOrigin,
  isRecoverableTelegramNetworkError,
  isSafeToRetrySendError,
  isTelegramClientRejection,
  isTelegramPollingNetworkError,
  isTelegramServerError,
  tagTelegramNetworkError,
} from "./network-errors.js";

describe("isRecoverableTelegramNetworkError", () => {
  it("tracks Telegram polling origin separately from generic network matching", () => {
    const slackDnsError = Object.assign(
      new Error("A request error occurred: getaddrinfo ENOTFOUND slack.com"),
      {
        code: "ENOTFOUND",
        hostname: "slack.com",
      },
    );
    expect(isRecoverableTelegramNetworkError(slackDnsError)).toBe(true);
    expect(isTelegramPollingNetworkError(slackDnsError)).toBe(false);

    tagTelegramNetworkError(slackDnsError, {
      method: "getUpdates",
      url: "https://api.telegram.org/bot123456:ABC/getUpdates",
    });
    expect(getTelegramNetworkErrorOrigin(slackDnsError)).toEqual({
      method: "getupdates",
      url: "https://api.telegram.org/bot123456:ABC/getUpdates",
    });
    expect(isTelegramPollingNetworkError(slackDnsError)).toBe(true);
  });

  it("detects recoverable error codes", () => {
    const err = Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    expect(isRecoverableTelegramNetworkError(err)).toBe(true);
  });

  it("detects additional recoverable error codes", () => {
    const aborted = Object.assign(new Error("aborted"), { code: "ECONNABORTED" });
    const network = Object.assign(new Error("network"), { code: "ERR_NETWORK" });
    expect(isRecoverableTelegramNetworkError(aborted)).toBe(true);
    expect(isRecoverableTelegramNetworkError(network)).toBe(true);
  });

  it("detects AbortError names", () => {
    const err = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    expect(isRecoverableTelegramNetworkError(err)).toBe(true);
  });

  it("detects nested causes", () => {
    const cause = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const err = Object.assign(new TypeError("fetch failed"), { cause });
    expect(isRecoverableTelegramNetworkError(err)).toBe(true);
  });

  it("detects expanded message patterns", () => {
    expect(isRecoverableTelegramNetworkError(new Error("TypeError: fetch failed"))).toBe(true);
    expect(isRecoverableTelegramNetworkError(new Error("Undici: socket failure"))).toBe(true);
  });

  it("treats undici fetch failed errors as recoverable in send context", () => {
    const err = new TypeError("fetch failed");
    expect(isRecoverableTelegramNetworkError(err, { context: "send" })).toBe(true);
    expect(
      isRecoverableTelegramNetworkError(new Error("TypeError: fetch failed"), { context: "send" }),
    ).toBe(true);
    expect(isRecoverableTelegramNetworkError(err, { context: "polling" })).toBe(true);
  });

  it("skips broad message matches for send context", () => {
    const networkRequestErr = new Error("Network request for 'sendMessage' failed!");
    expect(isRecoverableTelegramNetworkError(networkRequestErr, { context: "send" })).toBe(false);
    expect(isRecoverableTelegramNetworkError(networkRequestErr, { context: "polling" })).toBe(true);

    const undiciSnippetErr = new Error("Undici: socket failure");
    expect(isRecoverableTelegramNetworkError(undiciSnippetErr, { context: "send" })).toBe(false);
    expect(isRecoverableTelegramNetworkError(undiciSnippetErr, { context: "polling" })).toBe(true);
  });

  it("treats grammY failed-after envelope errors as recoverable in send context", () => {
    expect(
      isRecoverableTelegramNetworkError(
        new Error("Network request for 'sendMessage' failed after 2 attempts."),
        { context: "send" },
      ),
    ).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isRecoverableTelegramNetworkError(new Error("invalid token"))).toBe(false);
  });

  it("detects grammY 'timed out' long-poll errors (#7239)", () => {
    const err = new Error("Request to 'getUpdates' timed out after 500 seconds");
    expect(isRecoverableTelegramNetworkError(err)).toBe(true);
  });

  // Grammy HttpError tests (issue #3815)
  // Grammy wraps fetch errors in .error property, not .cause
  describe("Grammy HttpError", () => {
    class MockHttpError extends Error {
      constructor(
        message: string,
        public readonly error: unknown,
      ) {
        super(message);
        this.name = "HttpError";
      }
    }

    it("detects network error wrapped in HttpError", () => {
      const fetchError = new TypeError("fetch failed");
      const httpError = new MockHttpError(
        "Network request for 'setMyCommands' failed!",
        fetchError,
      );

      expect(isRecoverableTelegramNetworkError(httpError)).toBe(true);
    });

    it("detects network error with cause wrapped in HttpError", () => {
      const cause = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      const fetchError = Object.assign(new TypeError("fetch failed"), { cause });
      const httpError = new MockHttpError("Network request for 'getUpdates' failed!", fetchError);

      expect(isRecoverableTelegramNetworkError(httpError)).toBe(true);
    });

    it("returns false for non-network errors wrapped in HttpError", () => {
      const authError = new Error("Unauthorized: bot token is invalid");
      const httpError = new MockHttpError("Bad Request: invalid token", authError);

      expect(isRecoverableTelegramNetworkError(httpError)).toBe(false);
    });
  });
});

describe("isSafeToRetrySendError", () => {
  it("allows retry for ECONNREFUSED (pre-connect, message not sent)", () => {
    const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    expect(isSafeToRetrySendError(err)).toBe(true);
  });

  it("allows retry for ENOTFOUND (DNS failure, message not sent)", () => {
    const err = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    expect(isSafeToRetrySendError(err)).toBe(true);
  });

  it("allows retry for EAI_AGAIN (transient DNS, message not sent)", () => {
    const err = Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" });
    expect(isSafeToRetrySendError(err)).toBe(true);
  });

  it("allows retry for ENETUNREACH (no route to host, message not sent)", () => {
    const err = Object.assign(new Error("connect ENETUNREACH"), { code: "ENETUNREACH" });
    expect(isSafeToRetrySendError(err)).toBe(true);
  });

  it("allows retry for EHOSTUNREACH (host unreachable, message not sent)", () => {
    const err = Object.assign(new Error("connect EHOSTUNREACH"), { code: "EHOSTUNREACH" });
    expect(isSafeToRetrySendError(err)).toBe(true);
  });

  it("does NOT allow retry for ECONNRESET (message may already be delivered)", () => {
    const err = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    expect(isSafeToRetrySendError(err)).toBe(false);
  });

  it("does NOT allow retry for ETIMEDOUT (message may already be delivered)", () => {
    const err = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
    expect(isSafeToRetrySendError(err)).toBe(false);
  });

  it("does NOT allow retry for EPIPE (connection broken mid-transfer, message may be delivered)", () => {
    const err = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    expect(isSafeToRetrySendError(err)).toBe(false);
  });

  it("does NOT allow retry for UND_ERR_CONNECT_TIMEOUT (ambiguous timing)", () => {
    const err = Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" });
    expect(isSafeToRetrySendError(err)).toBe(false);
  });

  it("does NOT allow retry for non-network errors", () => {
    expect(isSafeToRetrySendError(new Error("400: Bad Request"))).toBe(false);
    expect(isSafeToRetrySendError(null)).toBe(false);
  });

  it("allows retry for 429 rate-limit with retry_after parameter", () => {
    const err = Object.assign(new Error("Too Many Requests: retry after 30"), {
      parameters: { retry_after: 30 },
    });
    expect(isSafeToRetrySendError(err)).toBe(true);
  });

  it("does NOT allow retry for error with parameters but no retry_after", () => {
    const err = Object.assign(new Error("Bad Request"), {
      parameters: {},
    });
    expect(isSafeToRetrySendError(err)).toBe(false);
  });

  it("allows retry for grammY 'failed after N attempts' envelope error", () => {
    const err = new Error("Network request for 'sendMessage' failed after 3 attempts.");
    expect(isSafeToRetrySendError(err)).toBe(true);
  });

  it("detects pre-connect error nested in cause chain", () => {
    const root = Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
    const wrapped = Object.assign(new Error("fetch failed"), { cause: root });
    expect(isSafeToRetrySendError(wrapped)).toBe(true);
  });
});

describe("isTelegramServerError", () => {
  it("returns true for error_code 500", () => {
    const err = Object.assign(new Error("Internal Server Error"), { error_code: 500 });
    expect(isTelegramServerError(err)).toBe(true);
  });

  it("returns true for error_code 502", () => {
    const err = Object.assign(new Error("Bad Gateway"), { error_code: 502 });
    expect(isTelegramServerError(err)).toBe(true);
  });

  it("returns false for error_code 403", () => {
    const err = Object.assign(new Error("Forbidden"), { error_code: 403 });
    expect(isTelegramServerError(err)).toBe(false);
  });

  it("returns false for plain Error", () => {
    expect(isTelegramServerError(new Error("500: Internal Server Error"))).toBe(false);
  });
});

describe("isTelegramClientRejection", () => {
  it("returns true for error_code 400", () => {
    const err = Object.assign(new Error("Bad Request"), { error_code: 400 });
    expect(isTelegramClientRejection(err)).toBe(true);
  });

  it("returns true for error_code 403", () => {
    const err = Object.assign(new Error("Forbidden"), { error_code: 403 });
    expect(isTelegramClientRejection(err)).toBe(true);
  });

  it("returns false for error_code 502", () => {
    const err = Object.assign(new Error("Bad Gateway"), { error_code: 502 });
    expect(isTelegramClientRejection(err)).toBe(false);
  });

  it("returns false for plain Error", () => {
    expect(isTelegramClientRejection(new Error("400: Bad Request"))).toBe(false);
  });

  it("detects error_code in nested cause", () => {
    const inner = Object.assign(new Error("Forbidden"), { error_code: 403 });
    const outer = Object.assign(new Error("wrapped"), { cause: inner });
    expect(isTelegramClientRejection(outer)).toBe(true);
  });
});
