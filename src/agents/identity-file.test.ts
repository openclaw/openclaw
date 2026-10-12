import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  loadAgentIdentityFromFile,
  loadAgentIdentityFromWorkspace,
  loadAgentIdentityFromWorkspaceAsync,
  mergeIdentityMarkdownContent,
} from "./identity-file.js";

const TEST_MAX_IDENTITY_FILE_BYTES = 4 * 1024 * 1024;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function parseIdentityFromContent(
  content: string,
): Promise<import("./identity-file.js").AgentIdentityFile | null> {
  const tempDir = tempDirs.make("openclaw-identity-parse-");
  const filePath = path.join(tempDir, "IDENTITY.md");
  fs.writeFileSync(filePath, content, "utf-8");
  return await loadAgentIdentityFromFile(filePath);
}

describe("parseIdentityMarkdown", () => {
  it.each([
    {
      content: `
# IDENTITY.md - Who Am I?

- **Name:** *(pick something you like)*
- **Creature:** *(AI? robot? familiar? ghost in the machine? something weirder?)*
- **Vibe:** *(how do you come across? sharp? warm? chaotic? calm?)*
- **Emoji:** *(your signature - pick one that feels right)*
- **Avatar:** *(workspace-relative path, http(s) URL, or data URI)*
    `,
      expected: null,
    },
    {
      content: `
- **Name:** Samantha
- **Creature:** Robot
- **Vibe:** Warm
- **Emoji:** :robot:
- **Avatar:** avatars/openclaw.png
`,
      expected: {
        name: "Samantha",
        creature: "Robot",
        vibe: "Warm",
        emoji: ":robot:",
        avatar: "avatars/openclaw.png",
      },
    },
    {
      content: [
        "- **Name:** `Samantha`",
        "- `Creature`: Robot",
        "- **`Avatar`**: `avatars/openclaw.png`",
      ].join("\n"),
      expected: {
        name: "Samantha",
        creature: "Robot",
        avatar: "avatars/openclaw.png",
      },
    },
    {
      content: "- **Avatar:** `(workspace-relative path, http(s) URL, or data URI)`",
      expected: null,
    },
    { content: "- **Avatar:** *(not set yet)*", expected: null },
  ])(
    "parses decorated identity values and ignores placeholders: $content",
    async ({ content, expected }) => {
      expect(await parseIdentityFromContent(content)).toEqual(expected);
    },
  );
});

describe("mergeIdentityMarkdownContent", () => {
  it.each([
    {
      content: `
# IDENTITY.md - Agent Identity

- **Name:** C-3PO
- **Creature:** Flustered Protocol Droid
- **Vibe:** Anxious, detail-obsessed
- **Emoji:** 🤖

## Role

Fluent in over six million error messages.
`,
      identity: {
        name: "Patch Agent",
        emoji: "🦀",
        avatar: "avatars/patch.png",
      },
      expected: `
# IDENTITY.md - Agent Identity

- Name: Patch Agent
- **Creature:** Flustered Protocol Droid
- **Vibe:** Anxious, detail-obsessed
- Emoji: 🦀
- Avatar: avatars/patch.png

## Role

Fluent in over six million error messages.
`,
    },
    {
      content: "\n- Name: Old Name\n- Name: Older Name\n- Emoji: 🙂\n",
      identity: { name: "New Name", emoji: "🦀" },
      expected: "\n- Name: New Name\n- Emoji: 🦀\n",
    },
    {
      content: "- **`Name`**: Old Name\n",
      identity: { name: "New Name" },
      expected: "- Name: New Name\n",
    },
  ])(
    "normalizes writable fields and preserves rich content: $content",
    ({ content, identity, expected }) => {
      expect(mergeIdentityMarkdownContent(content, identity)).toBe(expected);
    },
  );
});

describe("loadAgentIdentityFromWorkspace", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-identity-");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    "loads workspace and explicit identity files (symlink: %s)",
    async (symlink) => {
      if (symlink && process.platform === "win32") {
        return;
      }
      const identityPath = path.join(tempDir, "IDENTITY.md");
      const targetPath = symlink ? path.join(tempDir, "REAL_IDENTITY.md") : identityPath;
      const expected = { name: symlink ? "Linked Agent" : "Test Agent", emoji: "🤖" };
      fs.writeFileSync(targetPath, `- **Name:** ${expected.name}\n- **Emoji:** 🤖`);
      if (symlink) {
        fs.symlinkSync(targetPath, identityPath);
      }
      expect(loadAgentIdentityFromWorkspace(tempDir)).toEqual(expected);
      await expect(loadAgentIdentityFromFile(identityPath)).resolves.toEqual(expected);
    },
  );

  it.each(["missing", "oversized"])(
    "classifies %s identity reads without matching error text",
    async (kind) => {
      const identityPath = path.join(
        tempDir,
        kind === "missing" ? "identity-exceeds-limit.md" : "IDENTITY.md",
      );
      if (kind === "missing") {
        await expect(loadAgentIdentityFromFile(identityPath)).resolves.toBeNull();
      } else {
        fs.writeFileSync(identityPath, "x".repeat(TEST_MAX_IDENTITY_FILE_BYTES + 1));
        expect(loadAgentIdentityFromWorkspace(tempDir)).toBeNull();
        expect(await loadAgentIdentityFromWorkspaceAsync(tempDir)).toBeNull();
        await expect(loadAgentIdentityFromFile(identityPath)).rejects.toThrow(
          `exceeds the maximum size of ${TEST_MAX_IDENTITY_FILE_BYTES} bytes`,
        );
      }
    },
  );

  it("coalesces admission and retains unchanged parsed values without main-thread file reads", async () => {
    const filePath = path.join(tempDir, "IDENTITY.md");
    fs.writeFileSync(
      filePath,
      `- Name: Prepared\n- Avatar: data:image/png;base64,${"A".repeat(1024 * 1024)}\n`,
    );
    const first = await loadAgentIdentityFromWorkspaceAsync(tempDir);
    expect(first?.name).toBe("Prepared");
    const operations = [
      "openSync",
      "readSync",
      "readFileSync",
      "statSync",
      "lstatSync",
      "fstatSync",
      "realpathSync",
    ] as const;
    const spies = operations.map((operation) => vi.spyOn(fs, operation));
    const results = await Promise.all(
      Array.from({ length: 10 }, () => loadAgentIdentityFromWorkspaceAsync(tempDir)),
    );
    for (const result of results) {
      expect(result).toBe(first);
    }
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it.each([false, true])(
    "refreshes after replacement, deletion, and recreation (symlink: %s)",
    async (symlink) => {
      if (symlink && process.platform === "win32") {
        return;
      }
      const filePath = path.join(tempDir, "IDENTITY.md");
      const firstPath = symlink ? path.join(tempDir, "FIRST.md") : filePath;
      const modified = new Date("2024-01-01T00:00:00Z");
      fs.writeFileSync(firstPath, "- Name: First\n");
      fs.utimesSync(firstPath, modified, modified);
      if (symlink) {
        fs.symlinkSync(firstPath, filePath);
      }
      const first = await loadAgentIdentityFromWorkspaceAsync(tempDir);
      expect(first).toEqual({ name: "First" });
      fs.writeFileSync(`${filePath}.next`, "- Name: Other\n");
      fs.utimesSync(`${filePath}.next`, modified, modified);
      if (symlink) {
        fs.unlinkSync(filePath);
        fs.symlinkSync(`${filePath}.next`, filePath);
      } else {
        fs.renameSync(`${filePath}.next`, filePath);
      }
      expect(await loadAgentIdentityFromWorkspaceAsync(tempDir)).toEqual({ name: "Other" });
      fs.unlinkSync(filePath);
      expect(await loadAgentIdentityFromWorkspaceAsync(tempDir)).toBeNull();
      fs.writeFileSync(filePath, "- Name: First\n");
      const recreated = await loadAgentIdentityFromWorkspaceAsync(tempDir);
      expect(recreated).toEqual(first);
      expect(recreated).not.toBe(first);
    },
  );
});

describe("identity file UTF-8 admission", () => {
  it("rejects invalid UTF-8 identity files for explicit --identity-file loads", async () => {
    const tempDir = tempDirs.make("openclaw-identity-latin1-");
    const filePath = path.join(tempDir, "IDENTITY.md");
    // Latin-1 "é" (0xe9) is not valid UTF-8; trailing emoji bytes are valid UTF-8 alone.
    fs.writeFileSync(
      filePath,
      Buffer.from([
        0x2d, 0x20, 0x2a, 0x2a, 0x4e, 0x61, 0x6d, 0x65, 0x3a, 0x2a, 0x2a, 0x20, 0x43, 0x61, 0x66,
        0xe9, 0x20, 0x42, 0x6f, 0x74, 0x0a, 0x2d, 0x20, 0x2a, 0x2a, 0x45, 0x6d, 0x6f, 0x6a, 0x69,
        0x3a, 0x2a, 0x2a, 0x20, 0xf0, 0x9f, 0xa4, 0x96, 0x0a,
      ]),
    );
    await expect(loadAgentIdentityFromFile(filePath)).rejects.toThrow(/must be valid UTF-8/);
  });

  it("treats invalid UTF-8 workspace IDENTITY.md as absent", async () => {
    const tempDir = tempDirs.make("openclaw-identity-ws-latin1-");
    fs.writeFileSync(
      path.join(tempDir, "IDENTITY.md"),
      Buffer.from([
        0x2d, 0x20, 0x2a, 0x2a, 0x4e, 0x61, 0x6d, 0x65, 0x3a, 0x2a, 0x2a, 0x20, 0x43, 0x61, 0x66,
        0xe9, 0x20, 0x42, 0x6f, 0x74, 0x0a,
      ]),
    );
    expect(loadAgentIdentityFromWorkspace(tempDir)).toBeNull();
    await expect(loadAgentIdentityFromWorkspaceAsync(tempDir)).resolves.toBeNull();
  });

  it("still loads valid UTF-8 identity files", async () => {
    const tempDir = tempDirs.make("openclaw-identity-utf8-");
    const filePath = path.join(tempDir, "IDENTITY.md");
    fs.writeFileSync(filePath, "- **Name:** Café Bot\n- **Emoji:** 🤖\n", "utf-8");
    await expect(loadAgentIdentityFromFile(filePath)).resolves.toMatchObject({
      name: "Café Bot",
      emoji: "🤖",
    });
  });
});
