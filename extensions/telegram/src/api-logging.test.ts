import { HttpError } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { withTelegramApiErrorLogging } from "./api-logging.js";

describe("Telegram API error logging", () => {
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
});
