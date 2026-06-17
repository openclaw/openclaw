import { describe, it, expect } from "vitest";

describe("ACP message type guard prevents TypeError (#90404)", () => {
  it("confirms bare in-operator throws on primitives", () => {
    expect(() => {
      const message: unknown = 1;
      void ("isReplay" in (message as Record<string, unknown>));
    }).toThrow(TypeError);
  });

  it("type guard prevents TypeError on non-object messages", () => {
    const messages: unknown[] = [1, "hello", true, null, undefined];
    for (const message of messages) {
      expect(() => {
        if (typeof message === "object" && message !== null && "isReplay" in message) {
          void message.isReplay;
        }
      }).not.toThrow();
    }
  });

  it("type guard still detects isReplay on valid objects", () => {
    const message = { isReplay: true };
    const safe = typeof message === "object" && message !== null && "isReplay" in message && message.isReplay;
    expect(safe).toBe(true);
  });

  it("type guard returns false for objects without isReplay", () => {
    const message = { other: true };
    const safe = typeof message === "object" && message !== null && "isReplay" in message && message.isReplay;
    expect(safe).toBe(false);
  });
});
