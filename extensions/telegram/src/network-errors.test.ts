import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { describe, expect, it } from "vitest";
import {
  isRecoverableTelegramNetworkError,
  isTelegramAuthenticationError,
  isTelegramRateLimitError,
  isSafeToRetrySendError,
  isTelegramClientRejection,
  isTelegramServerError,
  rethrowTelegramSendError,
  TelegramRequestNotStartedError,
} from "./network-errors.js";

const errorWithCode = (message: string, code: string) =>
  Object.assign(new Error(message), { code });
const errorWithTelegramCode = (message: string, error_code: number) =>
  Object.assign(new Error(message), { error_code });
const causedBy = (error: unknown, message = "wrapped") =>
  Object.assign(new Error(message), { cause: error });
class MockHttpError extends Error {
  constructor(
    message: string,
    public readonly error: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function captureTelegramSendError(error: unknown): unknown {
  try {
    rethrowTelegramSendError(error);
  } catch (caught) {
    return caught;
  }
  throw new Error("Expected Telegram send error to be rethrown");
}

describe("Telegram error_code predicate contracts", () => {
  it.each([
    [isTelegramServerError, new Error("500: Internal Server Error"), false],
    [isTelegramClientRejection, new Error("400: Bad Request"), false],
    [isTelegramRateLimitError, causedBy(errorWithTelegramCode("Too Many Requests", 429)), true],
    [isTelegramClientRejection, causedBy(errorWithTelegramCode("Forbidden", 403)), true],
  ] as const)("classifies %s (%s)", (predicate, error, expected) => {
    expect(predicate(error)).toBe(expected);
  });
});

describe("isTelegramAuthenticationError", () => {
  it.each([
    ["Unauthorized", 401, true],
    ["Forbidden", 403, false],
    ["Not Found", 404, true],
  ])("returns %s for error_code %s", (message, errorCode, expected) => {
    expect(isTelegramAuthenticationError(errorWithTelegramCode(message, errorCode))).toBe(expected);
  });

  it("does not infer authentication failure from an unstructured message", () => {
    expect(isTelegramAuthenticationError(new Error("Unauthorized"))).toBe(false);
  });
});

describe("isRecoverableTelegramNetworkError", () => {
  const snippet = new Error("Undici: socket failure");
  const fetchFailure = new Error("TypeError: fetch failed");
  const envelope = new Error("Network request for 'sendMessage' failed!");
  it.each([
    ["ETIMEDOUT", "timeout"],
    ["ENETDOWN", "network down"],
    ["ECONNABORTED", "aborted"],
    ["ERR_NETWORK", "network"],
  ])("detects recoverable error code %s", (code, message) => {
    expect(isRecoverableTelegramNetworkError(errorWithCode(message, code))).toBe(true);
  });

  it.each<[Error, boolean]>([
    [Object.assign(new Error("The operation was aborted"), { name: "AbortError" }), true],
    [fetchFailure, true],
    [snippet, true],
    [new TypeError("fetch failed"), true],
    [envelope, true],
    [new Error("Network request for 'sendMessage' failed after 2 attempts."), true],
    [new Error("invalid token"), false],
    [new Error("Request to 'getUpdates' timed out after 500 seconds"), true],
    [
      new MockHttpError(
        "Bad Request: invalid token",
        new Error("Unauthorized: bot token is invalid"),
      ),
      false,
    ],
  ])("classifies %s as recoverable=%s (#3815, #7239)", (error, expected) => {
    expect(isRecoverableTelegramNetworkError(error)).toBe(expected);
  });

  it("keeps direct and grammY-wrapped request-not-started markers recoverable", () => {
    const marker = new TelegramRequestNotStartedError();
    const wrapped = Object.assign(new Error("Network request for 'getUpdates' failed!"), {
      name: "HttpError",
      error: marker,
    });

    expect(isRecoverableTelegramNetworkError(marker)).toBe(true);
    expect(isRecoverableTelegramNetworkError(wrapped)).toBe(true);
  });
});

describe("isSafeToRetrySendError", () => {
  it.each([
    ["ECONNREFUSED", "connect ECONNREFUSED", true],
    ["ENOTFOUND", "getaddrinfo ENOTFOUND", true],
    ["EAI_AGAIN", "getaddrinfo EAI_AGAIN", true],
    ["ENETDOWN", "connect ENETDOWN", true],
    ["ENETUNREACH", "connect ENETUNREACH", true],
    ["EHOSTUNREACH", "connect EHOSTUNREACH", true],
    ["ECONNRESET", "read ECONNRESET", false],
    ["ETIMEDOUT", "connect ETIMEDOUT", false],
    ["EPIPE", "write EPIPE", false],
    ["UND_ERR_CONNECT_TIMEOUT", "connect timeout", true],
  ])("returns %s => %s", (code, message, expected) => {
    expect(isSafeToRetrySendError(errorWithCode(message, code))).toBe(expected);
  });

  it("does NOT allow retry for non-network errors", () => {
    expect(isSafeToRetrySendError(new Error("400: Bad Request"))).toBe(false);
    expect(isSafeToRetrySendError(null)).toBe(false);
  });

  it("detects pre-connect error nested in cause chain", () => {
    const wrapped = causedBy(errorWithCode("ECONNREFUSED", "ECONNREFUSED"), "fetch failed");
    expect(isSafeToRetrySendError(wrapped)).toBe(true);
  });

  it("detects pre-connect error wrapped in grammY HttpError", () => {
    const fetchError = Object.assign(new TypeError("fetch failed"), {
      cause: errorWithCode("connect ECONNREFUSED", "ECONNREFUSED"),
    });
    const wrapped = new MockHttpError("Network request for 'sendMessage' failed!", fetchError);
    expect(isSafeToRetrySendError(wrapped)).toBe(true);
  });

  it("does not infer safe send retry from a plain grammY network envelope", () => {
    const wrapped = new MockHttpError(
      "Network request for 'sendMessage' failed!",
      new TypeError("fetch failed"),
    );
    expect(isSafeToRetrySendError(wrapped)).toBe(false);
  });

  it("accepts only direct and exact grammY-wrapped request-not-started markers", () => {
    const marker = new TelegramRequestNotStartedError();

    expect(isSafeToRetrySendError(marker)).toBe(true);
    expect(
      isSafeToRetrySendError(
        new MockHttpError("Network request for 'sendMessage' failed!", marker),
      ),
    ).toBe(true);
  });

  it.each([
    ["status", Object.assign(new Error("Misdirected Request"), { status: 421 })],
    ["statusCode", Object.assign(new Error("Misdirected Request"), { statusCode: "421" })],
    ["error_code", errorWithTelegramCode("Misdirected Request", 421)],
    ["message", new Error("421 Misdirected Request")],
    [
      "nested cause",
      Object.assign(new Error("Network request for 'sendMessage' failed!"), {
        cause: Object.assign(new Error("Misdirected Request"), { status: 421 }),
      }),
    ],
    [
      "grammY HttpError",
      new MockHttpError(
        "Network request for 'sendMessage' failed!",
        Object.assign(new Error("Misdirected Request"), { status: 421 }),
      ),
    ],
  ])("does not infer safe retry from broad Telegram 421 shape %s", (_name, err) => {
    expect(isSafeToRetrySendError(err)).toBe(false);
  });
});

describe("rethrowTelegramSendError", () => {
  const migratedChatId = -1_001_234_567_890;
  const migrationError = Object.assign(
    new Error("400: Bad Request: group chat was upgraded to a supergroup chat"),
    {
      name: "GrammyError",
      error_code: 400,
      description: "Bad Request: group chat was upgraded to a supergroup chat",
      parameters: { migrate_to_chat_id: migratedChatId },
    },
  );

  it.each([
    ["direct grammY rejection", migrationError],
    [
      "nested provider rejection",
      Object.assign(new Error("Telegram send failed"), { cause: migrationError }),
    ],
  ])("marks a migrated supergroup as a permanent non-dispatch for %s", (_name, error) => {
    const caught = captureTelegramSendError(error);

    expect(caught).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(caught).toMatchObject({
      retryable: false,
      cause: error,
    });
    expect(caught).toMatchObject({ message: expect.stringContaining(String(migratedChatId)) });
  });

  it.each(["chat not found", "message thread not found"])(
    "preserves retryable no-send proof for an exact %s rejection",
    (reason) => {
      const error = Object.assign(new Error(`400: Bad Request: ${reason}`), {
        error_code: 400,
        description: `Bad Request: ${reason}`,
      });
      expect(captureTelegramSendError(error)).toMatchObject({
        name: "PlatformMessageNotDispatchedError",
        message: error.message,
        retryable: true,
        cause: error,
      });
    },
  );

  it.each([
    ["rate limit", errorWithTelegramCode("Too Many Requests", 429)],
    ["server failure", errorWithTelegramCode("Bad Gateway", 502)],
    ["unrelated client rejection", errorWithTelegramCode("Bad Request: message is empty", 400)],
    ["ambiguous network failure", errorWithCode("read ECONNRESET", "ECONNRESET")],
    ...(["status", "statusCode"] as const).map((statusField): [string, Error] => [
      `non-Telegram ${statusField} lookalike`,
      Object.assign(new Error("migration-shaped HTTP error"), {
        [statusField]: 400,
        description: "Bad Request: group chat was upgraded to a supergroup chat",
        parameters: { migrate_to_chat_id: migratedChatId },
      }),
    ]),
    [
      "migration parameter without matching description",
      Object.assign(new Error("different bad request"), {
        error_code: 400,
        description: "Bad Request: message is empty",
        parameters: { migrate_to_chat_id: migratedChatId },
      }),
    ],
    [
      "partially accepted album",
      Object.assign(new Error("album partly failed"), {
        error_code: 400,
        description:
          'Bad Request: Failed to send message #2 with the error message "message thread not found"',
      }),
    ],
    [
      "mixed aggregate",
      new AggregateError([
        Object.assign(new Error("route rejected"), {
          error_code: 400,
          description: "Bad Request: message thread not found",
        }),
        errorWithCode("read ECONNRESET", "ECONNRESET"),
      ]),
    ],
    ["plain route text", new Error("400: Bad Request: message thread not found")],
    ["plain migration text", new Error("400: group chat was upgraded to a supergroup chat")],
  ])("does not terminalize a %s", (_name, error) => {
    expect(captureTelegramSendError(error)).toBe(error);
  });

  it.each([
    ["without response parameters", undefined],
    ["with an unsafe replacement id", Number.MAX_SAFE_INTEGER + 1],
  ])("terminalizes a migration response %s without surfacing a target", (_name, target) => {
    const error = Object.assign(new Error("migration"), {
      error_code: 400,
      description: "Bad Request: group chat was upgraded to a supergroup chat",
      ...(target === undefined ? {} : { parameters: { migrate_to_chat_id: target } }),
    });

    const caught = captureTelegramSendError(error);

    expect(caught).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(caught).toMatchObject({ retryable: false, cause: error });
    expect(caught).not.toMatchObject({ message: expect.stringContaining(String(target)) });
  });
});
describe("isTelegramRateLimitError", () => {
  it("detects wrapped 429 retry_after errors without error_code", () => {
    const wrapped = {
      message: "429 Too Many Requests",
      response: { parameters: { retry_after: 1 } },
    };
    expect(isTelegramRateLimitError(wrapped)).toBe(true);
  });
});
