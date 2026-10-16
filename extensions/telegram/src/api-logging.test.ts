import { HttpError } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { createTelegramRequestWithDiag } from "./send-context.js";

const logs = vi.hoisted(() => ({ apiError: vi.fn(), httpWarning: vi.fn() }));

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

  it("retains safe transport diagnostics through grammY without logging nested request data", async () => {
    const cause = Object.assign(new Error("https://example.test/bot-private-token request body"), {
      code: "ECONNRESET",
      syscall: "read",
      address: "private-host",
    });
    const error = new HttpError(
      "Network request failed: https://example.test/bot-private-token request body",
      new TypeError("fetch failed", { cause }),
    );
    const logger = vi.fn();

    await expect(
      withTelegramApiErrorLogging({
        operation: "sendMessage",
        fn: async () => {
          throw error;
        },
        logger,
      }),
    ).rejects.toBe(error);

    expect(logger).toHaveBeenCalledExactlyOnceWith(
      `telegram sendMessage failed: network request failed transport={"code":"ECONNRESET","syscall":"read"}`,
    );
  });

  it("does not serialize arbitrary cause fields as transport diagnostics", async () => {
    const error = new HttpError("Network request for 'sendMessage' failed!", {
      code: "https://example.test/bot-private-token",
      syscall: "private request body",
      cause: { code: "UND_ERR_SOCKET", syscall: "connect" },
    });
    const logger = vi.fn();

    await expect(
      withTelegramApiErrorLogging({
        operation: "sendMessage",
        fn: async () => {
          throw error;
        },
        runtime: { error: logger },
      }),
    ).rejects.toBe(error);

    expect(logger).toHaveBeenCalledExactlyOnceWith(
      `telegram sendMessage failed: network request failed transport={"code":"UND_ERR_SOCKET","syscall":"connect"}`,
    );
  });

  it("does not print an HTTP error's request text when no transport fields are available", async () => {
    const error = new HttpError("private request body", new Error("private nested request body"));
    const logger = vi.fn();

    await expect(
      withTelegramApiErrorLogging({
        operation: "sendMessage",
        fn: async () => {
          throw error;
        },
        logger,
      }),
    ).rejects.toBe(error);
    expect(logger).toHaveBeenCalledExactlyOnceWith(
      "telegram sendMessage failed: network request failed",
    );
  });

  it.each([
    [true, true, true, false, true],
    [true, true, false, false, true],
    [true, false, true, false, true],
    [false, true, true, true, false],
    [false, true, false, false, false],
    [false, false, true, false, false],
  ] as const)(
    "keeps one content-free HTTP failure owner (diagnostics=%s, API logging=%s, predicate=%s)",
    async (diagnostics, useApiErrorLogging, shouldLog, apiRecord, httpRecord) => {
      const error = new HttpError(
        "private outer request text",
        Object.assign(new Error("private nested request text"), {
          code: "ECONNRESET",
          syscall: "read",
        }),
      );
      const request = createTelegramRequestWithDiag({
        cfg: { diagnostics: { flags: diagnostics ? ["telegram.http"] : [] } },
        useApiErrorLogging,
        retry: { attempts: 1 },
      });
      await expect(
        request(
          async () => {
            throw error;
          },
          "sendMessage",
          { shouldLog: () => shouldLog },
        ),
      ).rejects.toBe(error);

      expect(logs.apiError).toHaveBeenCalledTimes(Number(apiRecord));
      if (apiRecord) {
        expect(logs.apiError).toHaveBeenCalledWith(
          `telegram sendMessage failed: network request failed transport={"code":"ECONNRESET","syscall":"read"}`,
        );
      }
      expect(logs.httpWarning).toHaveBeenCalledTimes(Number(httpRecord));
      if (httpRecord) {
        expect(logs.httpWarning).toHaveBeenCalledWith(
          `telegram http error (sendMessage): network request failed transport={"code":"ECONNRESET","syscall":"read"}`,
        );
      }
    },
  );

  it.each([true, false])(
    "preserves the ordinary API log predicate for non-HTTP errors (%s)",
    async (shouldLog) => {
      const error = new Error("expected API rejection");
      const request = createTelegramRequestWithDiag({
        cfg: { diagnostics: { flags: ["telegram.http"] } },
        retry: { attempts: 1 },
      });
      await expect(
        request(
          async () => {
            throw error;
          },
          "sendMessage",
          { shouldLog: () => shouldLog },
        ),
      ).rejects.toBe(error);
      expect(logs.apiError.mock.calls).toEqual(
        shouldLog ? [["telegram sendMessage failed: expected API rejection"]] : [],
      );
      expect(logs.httpWarning).not.toHaveBeenCalled();
    },
  );
});
