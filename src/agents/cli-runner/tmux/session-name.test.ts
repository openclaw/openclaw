import { describe, expect, it } from "vitest";
import { buildTmuxSessionName, sanitizeTmuxNamePart } from "./session-name.js";

describe("buildTmuxSessionName", () => {
  it("builds stable safe tmux names", () => {
    const base = {
      prefix: "openclaw claude!",
      backendId: "claude-cli",
      workspaceDir: "/repo",
      sessionKey: "chat-1",
      modelId: "sonnet",
      systemPromptHash: "sys",
      memoryMode: "managed-disabled",
      hookMode: "managed",
    };

    expect(buildTmuxSessionName(base)).toBe(buildTmuxSessionName(base));
    expect(buildTmuxSessionName(base)).toMatch(/^openclaw-claude-[0-9a-f]{12}$/);
    expect(buildTmuxSessionName({ ...base, systemPromptHash: "other" })).not.toBe(
      buildTmuxSessionName(base),
    );
  });

  it("sanitizes arbitrary prefix text", () => {
    expect(sanitizeTmuxNamePart(" hello/world:tmux ")).toBe("hello-world-tmux");
  });
});
