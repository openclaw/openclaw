// Terminal Core tests cover decorative emoji behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decorativeEmoji,
  decorativePrefix,
  stripDecorativeEmojiForTerminal,
  supportsDecorativeEmoji,
} from "./decorative-emoji.js";

describe("decorative emoji terminal helpers", () => {
  const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const originalPlatform = process.platform;

  beforeEach(() => {
    for (const key of ["TERM_PROGRAM", "WT_SESSION", "LC_ALL", "LC_CTYPE"]) {
      vi.stubEnv(key, undefined);
    }
    vi.stubEnv("TERM", "xterm-256color");
    vi.stubEnv("LANG", "en_US.UTF-8");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    Object.defineProperty(process, "platform", { value: originalPlatform });
    if (ttyDescriptor) {
      Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
    } else {
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  });

  it("disables decorative emoji without a TTY", () => {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    expect(supportsDecorativeEmoji()).toBe(false);
  });

  it("formats decorative emoji prefixes conservatively", () => {
    expect(decorativeEmoji("🦞")).toBe("");
    expect(decorativePrefix("🦞", "OpenClaw")).toBe("OpenClaw");
    vi.stubEnv("TERM_PROGRAM", "ghostty");
    expect(decorativePrefix("🦞", "OpenClaw")).toBe("🦞 OpenClaw");
  });

  it("strips decorative emoji from curated terminal text only when unsupported", () => {
    expect(stripDecorativeEmojiForTerminal("The lobster in your shell. 🦞")).toBe(
      "The lobster in your shell.",
    );
    vi.stubEnv("TERM_PROGRAM", "iTerm.app");
    expect(stripDecorativeEmojiForTerminal("The lobster in your shell. 🦞")).toBe(
      "The lobster in your shell. 🦞",
    );
  });
});
