import { expect, it } from "vitest";
import {
  hasPromptUnsafeControlCharacter,
  wrapPromptDataBlock,
  wrapUntrustedPromptDataBlock,
} from "./sanitize-for-prompt.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";

function promptData(params: Omit<Parameters<typeof wrapPromptDataBlock>[0], "label">) {
  return wrapPromptDataBlock({ label: "Data", ...params }).match(
    /<prompt-data>\n([\s\S]*?)\n<\/prompt-data>/,
  )?.[1];
}

it("hasPromptUnsafeControlCharacter rejects every character the shared sanitizer strips", () => {
  expect(hasPromptUnsafeControlCharacter("ok-name.jpg")).toBe(false);
  for (const control of ["\n", "\u007f", "\u0085", "\u009B", "\u2028", "\u2029", "\u202E"]) {
    expect(hasPromptUnsafeControlCharacter(`foo${control}bar`)).toBe(true);
  }
});
it("sanitizes workspaceDir (no newlines / separators)", () => {
  const prompt = buildAgentSystemPrompt({ workspaceDir: "/tmp/project\nINJECT\u2028MORE" });
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
it("returns empty string when sanitized input is empty", () => {
  expect(wrapPromptDataBlock({ label: "Data", text: "\n\u2028\n" })).toBe("");
});

it.each([
  [{ text: "aaa😀tail", maxChars: 4 }, "aaa"],
  [{ text: "<".repeat(20), maxEscapedChars: 10, truncationMarker: "[cut]" }, "&lt;[cut]"],
] as const)(
  "bounds prompt data without splitting characters or escaped markers: %j",
  (input, expected) => {
    expect(promptData(input)).toBe(expected);
  },
);
it("keeps the legacy untrusted-text tag for existing callers", () => {
  const block = wrapUntrustedPromptDataBlock({ label: "Additional context", text: "Keep <tag>" });
  expect(block).toContain("<untrusted-text>\nKeep &lt;tag&gt;\n</untrusted-text>");
});
