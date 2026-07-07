// Qqbot tests cover index plugin behavior.
import { describe, expect, it } from "vitest";
import { buildApprovalKeyboard, buildExecApprovalText } from "./index.js";

describe("buildApprovalKeyboard", () => {
  it("omits allow-always when the decision is unavailable", () => {
    const keyboard = buildApprovalKeyboard("approval-123", ["allow-once", "deny"]);
    const buttons = keyboard.content.rows[0]?.buttons ?? [];

    expect(buttons.map((button) => button.id)).toEqual(["allow", "deny"]);
    expect(buttons.map((button) => button.action.data)).toEqual([
      "approve:approval-123:allow-once",
      "approve:approval-123:deny",
    ]);
  });

  it("keeps all buttons when all decisions are allowed", () => {
    const keyboard = buildApprovalKeyboard("approval-123", ["allow-once", "allow-always", "deny"]);
    const buttons = keyboard.content.rows[0]?.buttons ?? [];

    expect(buttons.map((button) => button.id)).toEqual(["allow", "always", "deny"]);
  });
});

describe("buildExecApprovalText", () => {
  const hasLoneSurrogate = (value: string): boolean => {
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(i + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) {
          return true;
        }
        i++;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        return true;
      }
    }
    return false;
  };

  it("truncates the command preview on a UTF-16 boundary without splitting surrogate pairs", () => {
    // Mirrors the call shape at approval/index.ts:64 inside buildExecApprovalText:
    //   lines.push(`\`\`\`\n${truncateUtf16Safe(cmd, 300)}\n\`\`\``);
    // The command preview is user-visible in the approval message and must
    // not split a surrogate pair (which would render as garbage in the
    // QQ approval card UI).
    const longCommand = "echo " + "测试命令参数🎉🎉🎉🎉🎉".repeat(50);
    const text = buildExecApprovalText({
      id: "approval-1",
      expiresAtMs: Date.now() + 60_000,
      request: {
        commandPreview: longCommand,
        command: longCommand,
        cwd: "/tmp",
      },
    });
    const codeFence = text.split("```\n")[1]?.split("\n```")[0] ?? "";
    expect(codeFence.length).toBeLessThanOrEqual(300);
    expect(hasLoneSurrogate(codeFence)).toBe(false);
  });
});
