import { describe, expect, it } from "vitest";
import {
  resolveExecApprovalCommandDisplay,
  sanitizeExecApprovalDisplayText,
} from "../infra/exec-approval-command-display.js";
import { normalizeExecAsk, requiresExecApproval } from "../infra/exec-approvals.js";

describe("exec log mode", () => {
  it("normalizeExecAsk accepts 'log'", () => {
    expect(normalizeExecAsk("log")).toBe("log");
    expect(normalizeExecAsk("LOG")).toBe("log");
    expect(normalizeExecAsk(" log ")).toBe("log");
  });

  it("log mode does NOT require exec approval", () => {
    expect(
      requiresExecApproval({
        ask: "log",
        security: "allowlist",
        analysisOk: true,
        allowlistSatisfied: true,
      }),
    ).toBe(false);

    expect(
      requiresExecApproval({
        ask: "log",
        security: "allowlist",
        analysisOk: false,
        allowlistSatisfied: false,
      }),
    ).toBe(false);

    expect(
      requiresExecApproval({
        ask: "log",
        security: "full",
        analysisOk: true,
        allowlistSatisfied: false,
      }),
    ).toBe(false);
  });

  it("command text is sanitized before display", () => {
    const { commandText } = resolveExecApprovalCommandDisplay({
      command: "echo hello\u200Bworld",
    });
    expect(commandText).toBe("echo hello\\u{200B}world");
    expect(commandText).not.toContain("\u200B");
  });

  it("sanitizeExecApprovalDisplayText escapes unicode format chars", () => {
    expect(sanitizeExecApprovalDisplayText("ls\u200B-la")).toBe("ls\\u{200B}-la");
    expect(sanitizeExecApprovalDisplayText("echo hello")).toBe("echo hello");
  });

  it("log notification format uses sanitized command text", () => {
    const { commandText } = resolveExecApprovalCommandDisplay({ command: "npm test" });
    const notification = `🔧 Running: \`${commandText}\``;
    expect(notification).toBe("🔧 Running: `npm test`");
  });
});
