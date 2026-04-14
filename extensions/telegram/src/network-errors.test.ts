import { describe, expect, it } from "vitest";
import {
  getTelegramNetworkErrorOrigin,
  isRecoverableTelegramNetworkError,
  isTelegramRateLimitError,
  isSafeToRetrySendError,
  isStaleConnectionError,
  isTelegramClientRejection,
  isTelegramPollingNetworkError,
  isTelegramServerError,
  tagTelegramNetworkError,
} from "./network-errors.js";

const errorWithCode = (message: string, code: string) =>
  Object.assign(new Error(message), { code });
const errorWithTelegramCode = (message: string, error_code: number) =>
  Object.assign(new Error(message), { error_code });

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

  it.each([
    ["ETIMEDOUT", "timeout"],
    ["ECONNABORTED", "aborted"],
    ["ERR_NETWORK", "network"],
  ])("detects recoverable error code %s", (code, message) => {
    expect(isRecoverableTelegramNetworkError(errorWithCode(message, code))).toBe(true);
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

  it("honors allowMessageMatch=false for broad snippet matches", () => {
    expect(
      isRecoverableTelegramNetworkError(new Error("Undici: socket failure"), {
        allowMessageMatch: false,
      }),
    ).toBe(false);
    expect(
      isRecoverableTelegramNetworkError(new Error("TypeError: fetch failed"), {
        allowMessageMatch: false,
      }),
    ).toBe(true);
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

  it("normalizes blank tagged origins to null and finds nested tags", () => {
    const inner = new Error("inner");
    tagTelegramNetworkError(inner, { method: " ", url: " " });
    const outer = Object.assign(new Error("outer"), { cause: inner });
    expect(getTelegramNetworkErrorOrigin(outer)).toEqual({ method: null, url: null });
    expect(isTelegramPollingNetworkError(outer)).toBe(false);
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
  class MockHttpError extends Error {
    constructor(
      message: string,
      public readonly error: unknown,
    ) {
      super(message);
      this.name = "HttpError";
    }
  }

  it.each([
    ["ECONNREFUSED", "connect ECONNREFUSED", true],
    ["ENOTFOUND", "getaddrinfo ENOTFOUND", true],
    ["EAI_AGAIN", "getaddrinfo EAI_AGAIN", true],
    ["ENETUNREACH", "connect ENETUNREACH", true],
    ["EHOSTUNREACH", "connect EHOSTUNREACH", true],
    ["ECONNRESET", "read ECONNRESET", false],
    ["ETIMEDOUT", "connect ETIMEDOUT", false],
    ["EPIPE", "write EPIPE", false],
    ["UND_ERR_CONNECT_TIMEOUT", "connect timeout", false],
  ])("returns %s => %s", (code, message, expected) => {
    expect(isSafeToRetrySendError(errorWithCode(message, code))).toBe(expected);
  });

  it("does NOT allow retry for non-network errors", () => {
    expect(isSafeToRetrySendError(new Error("400: Bad Request"))).toBe(false);
    expect(isSafeToRetrySendError(null)).toBe(false);
  });

  it("detects pre-connect error nested in cause chain", () => {
    const root = Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
    const wrapped = Object.assign(new Error("fetch failed"), { cause: root });
    expect(isSafeToRetrySendError(wrapped)).toBe(true);
  });

  it("detects pre-connect error wrapped in grammY HttpError", () => {
    const root = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const fetchError = Object.assign(new TypeError("fetch failed"), { cause: root });
    const wrapped = new MockHttpError("Network request for 'sendMessage' failed!", fetchError);
    expect(isSafeToRetrySendError(wrapped)).toBe(true);
  });
});

describe("isTelegramServerError", () => {
  it.each([
    ["Internal Server Error", 500, true],
    ["Bad Gateway", 502, true],
    ["Forbidden", 403, false],
  ])("returns %s for error_code %s", (message, errorCode, expected) => {
    expect(isTelegramServerError(errorWithTelegramCode(message, errorCode))).toBe(expected);
  });

  it("returns false for plain Error", () => {
    expect(isTelegramServerError(new Error("500: Internal Server Error"))).toBe(false);
  });
});

describe("isTelegramRateLimitError", () => {
  it("returns true for Telegram 429 errors", () => {
    expect(isTelegramRateLimitError(errorWithTelegramCode("Too Many Requests", 429))).toBe(true);
  });

  it("detects wrapped 429 retry_after errors without error_code", () => {
    const wrapped = {
      message: "429 Too Many Requests",
      response: { parameters: { retry_after: 1 } },
    };
    expect(isTelegramRateLimitError(wrapped)).toBe(true);
  });

  it("detects error_code in nested cause", () => {
    const inner = Object.assign(new Error("Too Many Requests"), { error_code: 429 });
    const outer = Object.assign(new Error("wrapped"), { cause: inner });
    expect(isTelegramRateLimitError(outer)).toBe(true);
  });
});

describe("isTelegramClientRejection", () => {
  it.each([
    ["Bad Request", 400, true],
    ["Forbidden", 403, true],
    ["Bad Gateway", 502, false],
  ])("returns %s for error_code %s", (message, errorCode, expected) => {
    expect(isTelegramClientRejection(errorWithTelegramCode(message, errorCode))).toBe(expected);
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

describe("isStaleConnectionError", () => {
  it.each([
    ["ECONNRESET", "read ECONNRESET"],
    ["ETIMEDOUT", "connect ETIMEDOUT"],
    ["UND_ERR_SOCKET", "socket error"],
    ["EPIPE", "write EPIPE"],
    ["ECONNABORTED", "connection aborted"],
    ["UND_ERR_HEADERS_TIMEOUT", "headers timeout"],
    ["UND_ERR_BODY_TIMEOUT", "body timeout"],
    ["UND_ERR_ABORTED", "aborted"],
    ["ERR_NETWORK", "network error"],
  ])("detects post-connect error code %s as stale", (code, message) => {
    expect(isStaleConnectionError(errorWithCode(message, code))).toBe(true);
  });

  it.each([
    ["ECONNREFUSED", "connect ECONNREFUSED"],
    ["ENOTFOUND", "getaddrinfo ENOTFOUND"],
    ["EAI_AGAIN", "getaddrinfo EAI_AGAIN"],
    ["ENETUNREACH", "connect ENETUNREACH"],
    ["EHOSTUNREACH", "connect EHOSTUNREACH"],
    ["UND_ERR_CONNECT_TIMEOUT", "connect timeout"],
  ])("does NOT treat connect-time error code %s as stale", (code, message) => {
    // Connect-time failures mean the health-check probe failed to open a new
    // connection; the existing long-poll socket may still be healthy.
    expect(isStaleConnectionError(errorWithCode(message, code))).toBe(false);
  });

  it("detects our own health check timeout as stale", () => {
    expect(isStaleConnectionError(new Error("Health check timeout"))).toBe(true);
  });

  it("detects fetch failed as stale", () => {
    expect(isStaleConnectionError(new TypeError("fetch failed"))).toBe(true);
  });

  it("detects socket hang up as stale", () => {
    expect(isStaleConnectionError(new Error("socket hang up"))).toBe(true);
  });

  it("does NOT treat HTTP 504 Gateway Timeout as stale", () => {
    // 504 means the Telegram server responded -- TCP connection is alive
    const err = Object.assign(new Error("Gateway Timeout"), { error_code: 504 });
    expect(isStaleConnectionError(err)).toBe(false);
    // Verify it IS recoverable (it should still be retried, just not treated as stale)
    expect(isRecoverableTelegramNetworkError(err, { context: "polling" })).toBe(true);
  });

  it("does NOT treat HTTP 502 Bad Gateway as stale", () => {
    const err = Object.assign(new Error("Bad Gateway"), { error_code: 502 });
    expect(isStaleConnectionError(err)).toBe(false);
  });

  it("does NOT treat HTTP 429 Too Many Requests as stale", () => {
    const err = Object.assign(new Error("Too Many Requests: retry after 30"), { error_code: 429 });
    expect(isStaleConnectionError(err)).toBe(false);
  });

  it("does NOT treat HTTP 500 Internal Server Error as stale", () => {
    const err = Object.assign(new Error("Internal Server Error"), { error_code: 500 });
    expect(isStaleConnectionError(err)).toBe(false);
  });

  it("detects connection error nested in cause chain", () => {
    const root = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const wrapped = Object.assign(new TypeError("fetch failed"), { cause: root });
    expect(isStaleConnectionError(wrapped)).toBe(true);
  });

  it("does NOT treat HTTP error wrapped in HttpError as stale", () => {
    // Grammy wraps API errors in HttpError with .error property
    const inner = Object.assign(new Error("Gateway Timeout"), { error_code: 504 });
    const outer = Object.assign(new Error("Network request for 'getMe' failed!"), {
      name: "HttpError",
      error: inner,
    });
    expect(isStaleConnectionError(outer)).toBe(false);
  });

  it.each([["ENOTFOUND"], ["ECONNREFUSED"], ["EAI_AGAIN"], ["UND_ERR_CONNECT_TIMEOUT"]])(
    "does NOT treat fetch-failed wrapper with nested connect-time code %s as stale",
    (code) => {
      // A health-check probe that fails to open a new connection surfaces as
      // TypeError("fetch failed") wrapping a cause whose `code` is a connect-time
      // failure. The existing long-poll socket may still be healthy, so we must
      // not classify this as a stale connection.
      const cause = Object.assign(new Error(`connect ${code}`), { code });
      const wrapped = Object.assign(new TypeError("fetch failed"), { cause });
      expect(isStaleConnectionError(wrapped)).toBe(false);
    },
  );

  it("does NOT treat self-induced AbortError as stale", () => {
    // polling-session aborts in-flight fetches itself during stall recovery
    // and forced restarts. The resulting AbortError on a pending health-check
    // getMe must not be misclassified as a broken socket.
    const err = Object.assign(new Error("The operation was aborted"), {
      name: "AbortError",
    });
    expect(isStaleConnectionError(err)).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isStaleConnectionError(null)).toBe(false);
    expect(isStaleConnectionError(undefined)).toBe(false);
  });

  it("returns false for unrelated errors", () => {
    expect(isStaleConnectionError(new Error("invalid token"))).toBe(false);
  });
});
