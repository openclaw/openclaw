import { HttpError } from "grammy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { createTelegramRequestWithDiag } from "./send-context.js";

const logs = vi.hoisted(() => ({ apiError: vi.fn(), httpWarning: vi.fn() }));
const rejecting = (error: unknown) => async () => {
  throw error;
};
const safeFailure = 'network request failed transport={"code":"ECONNRESET","syscall":"read"}';

async function expectLogged(error: HttpError, suffix = "", useRuntime = false) {
  const logger = vi.fn();
  await expect(
    withTelegramApiErrorLogging({
      operation: "sendMessage",
      fn: rejecting(error),
      ...(useRuntime ? { runtime: { error: logger } } : { logger }),
    }),
  ).rejects.toBe(error);
  expect(logger).toHaveBeenCalledExactlyOnceWith(
    `telegram sendMessage failed: network request failed${suffix}`,
  );
}

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
    await expectLogged(error, ' transport={"code":"ECONNRESET","syscall":"read"}');
  });

  it("does not serialize arbitrary cause fields as transport diagnostics", async () => {
    const error = new HttpError("Network request for 'sendMessage' failed!", {
      code: "https://example.test/bot-private-token",
      syscall: "private request body",
      cause: { code: "UND_ERR_SOCKET", syscall: "connect" },
    });
    await expectLogged(error, ' transport={"code":"UND_ERR_SOCKET","syscall":"connect"}', true);
  });

  it("does not print an HTTP error's request text when no transport fields are available", async () => {
    const error = new HttpError("private request body", new Error("private nested request body"));
    await expectLogged(error);
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
        ? new HttpError(
            "private outer request text",
            Object.assign(new Error("private nested request text"), {
              code: "ECONNRESET",
              syscall: "read",
            }),
          )
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
