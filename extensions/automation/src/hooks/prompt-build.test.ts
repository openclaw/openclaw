import { describe, expect, it, vi } from "vitest";
import { AUTOMATION_SYSTEM_PROMPT } from "../system-prompt.js";
import { setUserMode } from "../telegram-ui/user-state.js";
import { registerPromptBuildHook, resolveTelegramModePrompt } from "./prompt-build.js";

describe("automation prompt-build telegram mode context", () => {
  it("returns undefined for non-telegram providers", () => {
    setUserMode(1001, "code");
    expect(
      resolveTelegramModePrompt({ messageProvider: "discord", channelId: "1001" }),
    ).toBeUndefined();
  });

  it("returns code-mode guidance for telegram channel", () => {
    setUserMode(2002, "code");
    const result = resolveTelegramModePrompt({ messageProvider: "telegram", channelId: "2002" });
    expect(result).toContain("寫碼模式");
    expect(result).toContain("最小安全任務");
  });

  it("returns chat-mode guidance for telegram channel", () => {
    setUserMode(3003, "chat");
    const result = resolveTelegramModePrompt({ messageProvider: "telegram", channelId: "3003" });
    expect(result).toContain("對話模式");
  });

  it("registers hook and appends mode prompt to system context", async () => {
    setUserMode(5566, "code");
    const on = vi.fn();
    registerPromptBuildHook({ on } as never);

    const hook = on.mock.calls[0]?.[1] as (
      event: unknown,
      ctx: unknown,
    ) => Promise<{ appendSystemContext: string }>;
    expect(typeof hook).toBe("function");

    const result = await hook({}, { messageProvider: "telegram", channelId: "5566" });
    expect(result.appendSystemContext).toContain(AUTOMATION_SYSTEM_PROMPT);
    expect(result.appendSystemContext).toContain("寫碼模式");
  });
});
