import { describe, expect, it, vi } from "vitest";
import { createApprovalPromptHandler } from "../approval-flow.js";

describe("camel/approval-flow", () => {
  it("warns and denies when TTY is unavailable", async () => {
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const stderrDescriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const handler = createApprovalPromptHandler();
      const approved = await handler({
        toolName: "exec",
        reason: "tainted input",
      });

      expect(approved).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("non-interactive TTY"));
    } finally {
      warnSpy.mockRestore();
      if (stdinDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      }
      if (stderrDescriptor) {
        Object.defineProperty(process.stderr, "isTTY", stderrDescriptor);
      }
    }
  });
});
