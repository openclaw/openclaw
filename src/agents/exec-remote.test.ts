import { describe, expect, it } from "vitest";
import { sanitizeRemoteShellOutput } from "./exec-remote.js";

describe("sanitizeRemoteShellOutput", () => {
  it("strips echoed command and marker lines from interactive PTY output", () => {
    const marker = "__OPENCLAW_RC_123__";
    const markerPrint = `printf '\\n${marker}:%s\\n' "$?"`;
    const rawOutput = [
      "pwd",
      markerPrint,
      `\u001b[?2004h\u001b]0;root@pod:/app\u0007root@pod:/app# pwd`,
      "\u001b[?2004l/app",
      `\u001b[?2004h\u001b]0;root@pod:/app\u0007root@pod:/app# ${markerPrint}`,
      "\u001b[?2004l",
    ].join("\n");

    const cleaned = sanitizeRemoteShellOutput({
      rawOutput,
      command: "pwd",
      marker,
    });

    expect(cleaned).toBe("/app");
  });

  it("keeps command output content, including ANSI styling", () => {
    const marker = "__OPENCLAW_RC_456__";
    const markerPrint = `printf '\\n${marker}:%s\\n' "$?"`;
    const colored = "\u001b[31mred\u001b[0m";
    const rawOutput = [`echo red`, colored, markerPrint].join("\n");

    const cleaned = sanitizeRemoteShellOutput({
      rawOutput,
      command: "echo red",
      marker,
    });

    expect(cleaned).toBe(colored);
  });
});
