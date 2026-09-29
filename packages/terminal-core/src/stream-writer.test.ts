import { describe, expect, it, vi } from "vitest";
import { createSafeStreamWriter } from "./stream-writer.js";

describe("createSafeStreamWriter", () => {
  it.each([
    { code: "EPIPE", method: "writeLine", beforeWriteFails: false },
    { code: "EIO", method: "write", beforeWriteFails: true },
  ] as const)("keeps the writer closed after $code", ({ code, method, beforeWriteFails }) => {
    const failure = Object.assign(new Error(code), { code });
    const beforeWrite = vi.fn(() => {
      if (beforeWriteFails) {
        throw failure;
      }
    });
    const onBrokenPipe = vi.fn();
    const writer = createSafeStreamWriter({ beforeWrite, onBrokenPipe });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => {
      if (!beforeWriteFails) {
        throw failure;
      }
      return true;
    });
    try {
      expect(writer[method](process.stdout, "hello")).toBe(false);
      expect(onBrokenPipe).toHaveBeenCalledTimes(1);
      expect(onBrokenPipe.mock.calls[0]?.[0]).toBe(failure);
      expect(onBrokenPipe.mock.calls[0]?.[1]).toBe(
        beforeWriteFails ? process.stderr : process.stdout,
      );

      beforeWrite.mockReturnValue(undefined);
      write.mockReturnValue(true);
      expect(writer[method](process.stdout, "again")).toBe(false);
      expect(beforeWrite).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledTimes(beforeWriteFails ? 0 : 1);
      expect(onBrokenPipe).toHaveBeenCalledTimes(1);
    } finally {
      write.mockRestore();
    }
  });

  it("notifies once when a reentrant write closes before the outer write", () => {
    const failure = Object.assign(new Error("closed pipe"), { code: "EPIPE" });
    let entered = false;
    let nestedResult: boolean | undefined;
    let callbackResult: boolean | undefined;
    let notifications = 0;
    const writer = createSafeStreamWriter({
      beforeWrite: () => {
        if (!entered) {
          entered = true;
          nestedResult = writer.write(process.stdout, "nested");
        }
      },
      onBrokenPipe: () => {
        notifications += 1;
        callbackResult = writer.write(process.stdout, "callback");
      },
    });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => {
      throw failure;
    });
    try {
      expect(writer.write(process.stdout, "outer")).toBe(false);
      expect(nestedResult).toBe(false);
      expect(callbackResult).toBe(false);
      write.mockReturnValue(true);
      expect(writer.write(process.stdout, "ignored")).toBe(false);
      expect(notifications).toBe(1);
      expect(write.mock.calls.map(([text]) => text)).toEqual(["nested", "outer"]);
    } finally {
      write.mockRestore();
    }
  });

  it("keeps the output closed when the notification callback throws", () => {
    const failure = Object.assign(new Error("closed pipe"), { code: "EPIPE" });
    const callbackError = new Error("notification failed");
    const writer = createSafeStreamWriter({
      onBrokenPipe: () => {
        throw callbackError;
      },
    });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => {
      throw failure;
    });
    try {
      let thrown: unknown;
      try {
        writer.write(process.stdout, "first");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(callbackError);
      expect(writer.write(process.stdout, "ignored")).toBe(false);
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      write.mockRestore();
    }
  });
});
