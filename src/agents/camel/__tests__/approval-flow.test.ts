import { describe, expect, it, vi } from "vitest";
import { createApprovalPromptHandler } from "../approval-flow.js";

describe("camel/approval-flow", () => {
  function withNonTty<T>(fn: () => Promise<T>): Promise<T> {
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const stderrDescriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
    return fn().finally(() => {
      if (stdinDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      }
      if (stderrDescriptor) {
        Object.defineProperty(process.stderr, "isTTY", stderrDescriptor);
      }
    });
  }

  it("warns and denies when TTY is unavailable", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await withNonTty(async () => {
      const handler = createApprovalPromptHandler();
      const approved = await handler({
        toolName: "exec",
        reason: "tainted input",
      });

      expect(approved).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("non-interactive TTY"));
    });
    warnSpy.mockRestore();
  });

  it("uses gateway-backed approvals when non-TTY routing context is available", async () => {
    const gatewayRequester = vi.fn(async () => "allow-once" as const);
    await withNonTty(async () => {
      const handler = createApprovalPromptHandler({
        gatewayApproval: { sessionKey: "agent:main:signal:dm:+15555550123", turnSourceTo: "+1" },
        gatewayRequester,
      });
      const approved = await handler({
        toolName: "message.send",
        reason: 'tainted argument "body"',
        content: `Line\u200bOne\u202e`,
      });

      expect(approved).toBe(true);
    });
    expect(gatewayRequester).toHaveBeenCalledTimes(1);
    const firstCall = gatewayRequester.mock.calls.at(0);
    const request = (firstCall?.at(0) ?? undefined) as { command?: string } | undefined;
    const command = request?.command ?? "";
    expect(command.length).toBeGreaterThan(0);
    expect(command).toContain("LineOne");
    expect(command).not.toContain("\u200b");
    expect(command).not.toContain("\u202e");
  });
});
