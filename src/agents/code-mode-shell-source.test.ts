import { describe, expect, it } from "vitest";
import {
  CODE_MODE_SHELL_SOURCE_ERROR,
  isShellLikeCodeModeSource,
} from "./code-mode-shell-source.js";

describe("isShellLikeCodeModeSource", () => {
  it.each([
    "ls -la /workspace/",
    "ls /workspace/",
    "pwd",
    "echo hello",
    "/bin/ls /workspace/",
    "/bin/ls --color=never /workspace/",
    "sh -c 'ls /workspace/'",
    "find /workspace -maxdepth 1 -type f -o -type d | head -50",
    "echo listing; ls /workspace/ 2>&1 || echo failed",
    "ls /workspace/ > /tmp/wlist.txt 2>&1; cat /tmp/wlist.txt",
    "cat /workspace/HEARTBEAT.md",
    "dir /workspace",
  ])("flags shell-shaped payloads: %s", (source) => {
    expect(isShellLikeCodeModeSource(source)).toBe(true);
  });

  it.each([
    "return 7;",
    'const result = await tools.callValue("exec", { command: "ls /workspace" });\nreturn result;',
    'const hit = ALL_TOOLS.find((t) => t.id === "openclaw:core:read");\nreturn await tools.callValue(hit.id, { path: "/workspace" });',
    'return "test";',
    "console.log(await tools.callValue('openclaw:core:read', { path: '/workspace/' }));",
  ])("allows JS/TS guest programs: %s", (source) => {
    expect(isShellLikeCodeModeSource(source)).toBe(false);
  });

  it("exports an actionable rejection message", () => {
    expect(CODE_MODE_SHELL_SOURCE_ERROR).toContain("not shell");
    expect(CODE_MODE_SHELL_SOURCE_ERROR).toContain("tools.callValue");
  });
});
