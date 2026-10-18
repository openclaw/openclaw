// Verifies prompt literals and data blocks strip control/spoofing characters.
import { describe, expect, it } from "vitest";
import {
  hasPromptUnsafeControlCharacter,
  wrapPromptDataBlock,
  wrapUntrustedPromptDataBlock,
} from "./sanitize-for-prompt.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function extractPromptData(block: string): string {
  const result = block.match(/<prompt-data>\n([\s\S]*?)\n<\/prompt-data>/)?.[1];
  if (result === undefined) {
    throw new Error("Expected prompt data block");
  }
  return result;
}

describe("hasPromptUnsafeControlCharacter", () => {
  it("rejects every character the shared prompt sanitizer strips", () => {
    expect(hasPromptUnsafeControlCharacter("ok-name.jpg")).toBe(false);
    expect(hasPromptUnsafeControlCharacter("foo\nbar")).toBe(true);
    expect(hasPromptUnsafeControlCharacter("foo\u007fbar")).toBe(true);
    expect(hasPromptUnsafeControlCharacter("foo\u0085bar")).toBe(true);
    expect(hasPromptUnsafeControlCharacter("foo\u009Bbar")).toBe(true);
    expect(hasPromptUnsafeControlCharacter("foo\u2028bar")).toBe(true);
    expect(hasPromptUnsafeControlCharacter("foo\u2029bar")).toBe(true);
    expect(hasPromptUnsafeControlCharacter("foo\u202Ebar")).toBe(true);
  });
});

describe("buildAgentSystemPrompt uses sanitized workspace/sandbox strings", () => {
  it("sanitizes workspaceDir (no newlines / separators)", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/project\nINJECT\u2028MORE",
    });
    expect(prompt).toContain("Working directory: /tmp/projectINJECTMORE");
    expect(prompt).not.toContain("Working directory: /tmp/project\n");
    expect(prompt).not.toContain("\u2028");
  });

  it("sanitizes sandbox workspace and mount strings", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/test",
      sandboxInfo: {
        enabled: true,
        containerWorkspaceDir: "/work\u2029space",
        workspaceDir: "/host\nspace",
        workspaceAccess: "rw",
        agentWorkspaceMount: "/mnt\u2028mount",
      },
    });
    expect(prompt).toContain("Sandbox container workdir: /workspace");
    expect(prompt).toContain(
      "Sandbox host mount source (file tools bridge only; not valid inside sandbox exec): /hostspace",
    );
    expect(prompt).toContain("(mounted at /mntmount)");
    expect(prompt).not.toContain("Sandbox browser observer (noVNC):");
  });
});

describe("wrapPromptDataBlock", () => {
  it("returns empty string when sanitized input is empty", () => {
    const block = wrapPromptDataBlock({
      label: "Data",
      text: "\n\u2028\n",
    });
    expect(block).toBe("");
  });

  it("does not split surrogate pairs when applying max char limits", () => {
    const block = wrapPromptDataBlock({
      label: "Data",
      text: `${"a".repeat(3)}😀tail`,
      maxChars: 4,
    });

    expect(block).toContain(`\n${"a".repeat(3)}\n`);
    expect(hasLoneSurrogate(block)).toBe(false);
  });

  it("reserves the marker after escaping within the character budget", () => {
    const result = extractPromptData(
      wrapPromptDataBlock({
        label: "Data",
        text: "<".repeat(20),
        maxEscapedChars: 10,
        truncationMarker: "[cut]",
      }),
    );

    expect(result).toBe("&lt;[cut]");
    expect(result.length).toBeLessThanOrEqual(10);
  });
});

describe("wrapUntrustedPromptDataBlock", () => {
  it("keeps the legacy untrusted-text tag for existing callers", () => {
    const block = wrapUntrustedPromptDataBlock({
      label: "Additional context",
      text: "Keep <tag>",
    });
    expect(block).toContain("<untrusted-text>");
    expect(block).toContain("&lt;tag&gt;");
    expect(block).toContain("</untrusted-text>");
  });
});
