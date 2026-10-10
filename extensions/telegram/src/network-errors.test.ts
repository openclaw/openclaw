// Telegram tests cover network errors plugin behavior.
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { describe, expect, it } from "vitest";
import {
  isRecoverableTelegramNetworkError,
  isTelegramAuthenticationError,
  isTelegramRateLimitError,
  isSafeToRetrySendError,
  isTelegramServerError,
  rethrowTelegramSendError,
  TelegramRequestNotStartedError,
} from "./network-errors.js";

const errorWithCode = (message: string, code: string) =>
  Object.assign(new Error(message), { code });
const errorWithTelegramCode = (message: string, error_code: number) =>
  Object.assign(new Error(message), { error_code });

function captureTelegramSendError(error: unknown): unknown {
  try {
    rethrowTelegramSendError(error);
  } catch (caught) {
    return caught;
  }
  throw new Error("Expected Telegram send error to be rethrown");
}

const plainErrorPredicateCases = [
  {
    name: "isTelegramServerError",
    predicate: isTelegramServerError,
    error: new Error("500: Internal Server Error"),
  },
];

describe("Telegram error_code predicate contracts", () => {
  it.each(plainErrorPredicateCases)(
    "$name returns false for plain Error",
    ({ error, predicate }) => {
      expect(predicate(error)).toBe(false);
    },
  );
});

describe("isTelegramAuthenticationError", () => {
  it.each([["Not Found", 404, true]])(
    "returns %s for error_code %s",
    (message, errorCode, expected) => {
      expect(isTelegramAuthenticationError(errorWithTelegramCode(message, errorCode))).toBe(
        expected,
      );
    },
  );
});

describe("isRecoverableTelegramNetworkError", () => {
  it.each([
    ["ENETDOWN", "network down"],
    ["ERR_NETWORK", "network"],
  ])("detects recoverable error code %s", (code, message) => {
    expect(isRecoverableTelegramNetworkError(errorWithCode(message, code))).toBe(true);
  });

  it("detects AbortError names", () => {
    const err = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    expect(isRecoverableTelegramNetworkError(err)).toBe(true);
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

  it("keeps request-not-started markers recoverable across Telegram contexts", () => {
    const marker = new TelegramRequestNotStartedError();
    const wrapped = Object.assign(new Error("Network request for 'getUpdates' failed!"), {
      name: "HttpError",
      error: marker,
    });

    expect(isRecoverableTelegramNetworkError(marker, { context: "send" })).toBe(true);
    expect(isRecoverableTelegramNetworkError(wrapped, { context: "polling" })).toBe(true);
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

  it("does NOT allow retry for non-network errors", () => {
    expect(isSafeToRetrySendError(new Error("400: Bad Request"))).toBe(false);
    expect(isSafeToRetrySendError(null)).toBe(false);
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

  it.each([
    ["unrelated client rejection", errorWithTelegramCode("Bad Request: message is empty", 400)],
  ])("does not terminalize a %s", (_name, error) => {
    expect(captureTelegramSendError(error)).toBe(error);
  });

  it.each([["without response parameters", undefined]])(
    "terminalizes a migration response %s without surfacing a target",
    (_name, target) => {
      const error = Object.assign(new Error("migration"), {
        error_code: 400,
        description: "Bad Request: group chat was upgraded to a supergroup chat",
        ...(target === undefined ? {} : { parameters: { migrate_to_chat_id: target } }),
      });

      const caught = captureTelegramSendError(error);

      expect(caught).toBeInstanceOf(PlatformMessageNotDispatchedError);
      expect(caught).toMatchObject({ retryable: false, cause: error });
      expect(caught).not.toMatchObject({ message: expect.stringContaining(String(target)) });
    },
  );
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
