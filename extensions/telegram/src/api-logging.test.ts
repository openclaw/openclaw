import { HttpError } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { createTelegramRequestWithDiag } from "./send-context.js";

const logs = vi.hoisted(() => ({ apiError: vi.fn(), httpWarning: vi.fn() }));
const rejecting = (error: unknown) => async () => {
  throw error;
};
const safeFailure = 'network request failed transport={"code":"ECONNRESET","syscall":"read"}';
const privateText = "https://example.test/bot-private-token request body";
const transportError = () =>
  Object.assign(new Error(privateText), {
    code: "ECONNRESET",
    syscall: "read",
    address: "private-host",
  });

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      if (subsystem === "telegram/api") {
        return { ...logger, error: logs.apiError };
      }
      if (subsystem === "telegram/diagnostic") {
        return { ...logger, warn: logs.httpWarning };
      }
      return logger;
    },
  };
});

describe("Telegram API error logging", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_DIAGNOSTICS", "");
    logs.apiError.mockClear();
    logs.httpWarning.mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(["nested", "unsafe-fields", "no-fields"])("redacts %s request data", async (kind) => {
    const cause =
      kind === "nested"
        ? new TypeError("fetch failed", { cause: transportError() })
        : kind === "unsafe-fields"
          ? {
              code: privateText,
              syscall: privateText,
              cause: { code: "UND_ERR_SOCKET", syscall: "connect" },
            }
          : new Error(privateText);
    const error = new HttpError(privateText, cause);
    const logger = kind === "unsafe-fields" ? vi.fn() : logs.apiError;
    await expect(
      withTelegramApiErrorLogging({
        operation: "sendMessage",
        fn: rejecting(error),
        ...(kind === "unsafe-fields" ? { runtime: { error: logger } } : {}),
      }),
    ).rejects.toBe(error);
    const suffix =
      kind === "nested"
        ? ' transport={"code":"ECONNRESET","syscall":"read"}'
        : kind === "unsafe-fields"
          ? ' transport={"code":"UND_ERR_SOCKET","syscall":"connect"}'
          : "";
    expect(logger).toHaveBeenCalledExactlyOnceWith(
      `telegram sendMessage failed: network request failed${suffix}`,
    );
  });

  it.each([
    [true, true, true, true, false, true],
    [true, true, false, true, false, true],
    [true, false, true, true, false, true],
    [false, true, true, true, true, false],
    [false, true, false, true, false, false],
    [false, false, true, true, false, false],
    [true, undefined, true, false, true, false],
    [true, undefined, false, false, false, false],
  ] as const)(
    "routes failure logs (diagnostics=%s, API logging=%s, predicate=%s, HTTP=%s)",
    async (diagnostics, useApiErrorLogging, shouldLog, httpError, apiRecord, httpRecord) => {
      const error = httpError
        ? new HttpError(privateText, transportError())
        : new Error("expected API rejection");
      const request = createTelegramRequestWithDiag({
        cfg: { diagnostics: { flags: diagnostics ? ["telegram.http"] : [] } },
        useApiErrorLogging,
        retry: { attempts: 1 },
      });
      await expect(
        request(rejecting(error), "sendMessage", { shouldLog: () => shouldLog }),
      ).rejects.toBe(error);

      expect(logs.apiError.mock.calls).toEqual(
        apiRecord
          ? [[`telegram sendMessage failed: ${httpError ? safeFailure : "expected API rejection"}`]]
          : [],
      );
      expect(logs.httpWarning.mock.calls).toEqual(
        httpRecord ? [[`telegram http error (sendMessage): ${safeFailure}`]] : [],
      );
    },
  );
});
