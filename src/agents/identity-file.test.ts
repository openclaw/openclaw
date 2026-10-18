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

async function parseIdentityFromContent(content: string) {
  const tempDir = tempDirs.make("openclaw-identity-parse-");
  const filePath = path.join(tempDir, "IDENTITY.md");
  fs.writeFileSync(filePath, content, "utf-8");
  return await loadAgentIdentityFromFile(filePath);
}

describe("parseIdentityMarkdown", () => {
  it.each([
    "- Avatar: _portrait.png\n- Name: helper_",
    "- **Avatar:** _portrait.png\n- **Name:** helper_",
    "- Avatar: `_portrait.png`\n- Name: `helper_`",
    "- Avatar: **_portrait.png**\n- Name: **helper_**",
  ])("preserves literal identity punctuation: %s", async (content) => {
    expect(await parseIdentityFromContent(content)).toEqual({
      avatar: "_portrait.png",
      name: "helper_",
    });
  });

  it.each([
    [
      "\n# IDENTITY.md - Who Am I?\n\n- **Name:** *(pick something you like)*\n- **Creature:** *(AI? robot? familiar? ghost in the machine? something weirder?)*\n- **Vibe:** *(how do you come across? sharp? warm? chaotic? calm?)*\n- **Emoji:** *(your signature - pick one that feels right)*\n- **Avatar:** *(workspace-relative path, http(s) URL, or data URI)*\n    ",
      null,
    ],
    [
      "\n- **Name:** Samantha\n- **Creature:** Robot\n- **Vibe:** Warm\n- **Emoji:** :robot:\n- **Avatar:** avatars/openclaw.png\n",
      {
        name: "Samantha",
        creature: "Robot",
        vibe: "Warm",
        emoji: ":robot:",
        avatar: "avatars/openclaw.png",
      },
    ],
    [
      "- **Name:** `Samantha`\n- `Creature`: Robot\n- **`Avatar`**: `avatars/openclaw.png`",
      { name: "Samantha", creature: "Robot", avatar: "avatars/openclaw.png" },
    ],
    ["- **Avatar:** `(workspace-relative path, http(s) URL, or data URI)`", null],
    ["- **Avatar:** *(not set yet)*", null],
  ] as const)("parses decorated values and ignores placeholders: %s", async (content, expected) => {
    expect(await parseIdentityFromContent(content)).toEqual(expected);
  });
});

it.each([
  [
    "\n# IDENTITY.md - Agent Identity\n\n- **Name:** C-3PO\n- **Creature:** Flustered Protocol Droid\n- **Vibe:** Anxious, detail-obsessed\n- **Emoji:** 🤖\n\n## Role\n\nFluent in over six million error messages.\n",
    { name: "Patch Agent", emoji: "🦀", avatar: "avatars/patch.png" },
    "\n# IDENTITY.md - Agent Identity\n\n- Name: Patch Agent\n- **Creature:** Flustered Protocol Droid\n- **Vibe:** Anxious, detail-obsessed\n- Emoji: 🦀\n- Avatar: avatars/patch.png\n\n## Role\n\nFluent in over six million error messages.\n",
  ],
  [
    "\n- Name: Old Name\n- Name: Older Name\n- Emoji: 🙂\n",
    { name: "New Name", emoji: "🦀" },
    "\n- Name: New Name\n- Emoji: 🦀\n",
  ],
  ["- **`Name`**: Old Name\n", { name: "New Name" }, "- Name: New Name\n"],
] as const)(
  "normalizes writable fields and preserves rich content: %s",
  (content, identity, expected) => {
    expect(mergeIdentityMarkdownContent(content, identity)).toBe(expected);
  },
);
describe("loadAgentIdentityFromWorkspace", () => {
  let tempDir: string;
  const load = () => loadAgentIdentityFromWorkspaceAsync(tempDir);

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
        expect(await load()).toBeNull();
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
    const first = await load();
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
    const results = await Promise.all(Array.from({ length: 10 }, load));
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
      const first = await load();
      expect(first).toEqual({ name: "First" });
      fs.writeFileSync(`${filePath}.next`, "- Name: Other\n");
      fs.utimesSync(`${filePath}.next`, modified, modified);
      if (symlink) {
        fs.unlinkSync(filePath);
        fs.symlinkSync(`${filePath}.next`, filePath);
      } else {
        fs.renameSync(`${filePath}.next`, filePath);
      }
      expect(await load()).toEqual({ name: "Other" });
      fs.unlinkSync(filePath);
      expect(await load()).toBeNull();
      fs.writeFileSync(filePath, "- Name: First\n");
      const recreated = await load();
      expect(recreated).toEqual(first);
      expect(recreated).not.toBe(first);
    },
  );
});
