// Matrix tests cover logger plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { LogService, setMatrixConsoleLogging } from "./logger.js";

const runtimeLogger = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  getMatrixRuntime: () => ({ logging: { getChildLogger: () => runtimeLogger } }),
}));

describe("Matrix logging", () => {
  afterEach(() => {
    setMatrixConsoleLogging(false);
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("redacts sensitive tokens in emitted log messages", () => {
    setMatrixConsoleLogging(true);
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});

    LogService.warn(
      "MatrixHttpClient",
      "Authorization: Bearer 123456:abcdefghijklmnopqrstuvwxyzABCDEFG",
    );

    const message = spy.mock.calls[0]?.[0];
    expect(message).toContain("[MatrixHttpClient] Authorization: Bearer ");
    expect(message).not.toContain("123456:abcdefghijklmnopqrstuvwxyzABCDEFG");
    expect(message).not.toContain("abcdefghijklmnopqrstuvwxyzABCDEFG");
  });

  it("leaves runtime records raw for the shared egress redactor", () => {
    LogService.warn(
      "MatrixHttpClient",
      "Authorization: Bearer 123456:abcdefghijklmnopqrstuvwxyzABCDEFG",
    );

    expect(runtimeLogger.warn).toHaveBeenCalledExactlyOnceWith(
      "[MatrixHttpClient] Authorization: Bearer 123456:abcdefghijklmnopqrstuvwxyzABCDEFG",
    );
  });
});
