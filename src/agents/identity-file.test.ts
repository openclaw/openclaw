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
    ["- **Vibe:** Warm", { vibe: "Warm" }],
    [
      "- **Name:** `Samantha`\n- `Creature`: Robot\n- **`Avatar`**: `avatars/openclaw.png`",
      { name: "Samantha", creature: "Robot", avatar: "avatars/openclaw.png" },
    ],
    ["- **Avatar:** `(workspace-relative path, http(s) URL, or data URI)`", null],
    ["- **Avatar:** *(not set yet)*", null],
    ["- Name: Café 🤖 �\n", { name: "Café 🤖 �" }],
    [
      "- Name: Atlas\n```markdown\n- Name: Example\n- Emoji: ❌\n```\n- Creature: Turtle\n",
      { name: "Atlas", creature: "Turtle" },
    ],
    ["- Name: Atlas\n\n## Example\n\n   ~~~markdown\n- Name: Example\n   ~~~\n", { name: "Atlas" }],
    ["- Name: Atlas\n````markdown\n```\n- Name: Example\n````\n", { name: "Atlas" }],
    ["- Name: Atlas\n```markdown\n- Name: Example", { name: "Atlas" }],
    ["- Name: Atlas\r\n```markdown\r\n- Name: Example\r\n```\r\n", { name: "Atlas" }],
    ["```markdown\n- Name: Example\n```\n", null],
    ["Name: First\nName: Atlas\n", { name: "Atlas" }],
    ["    - Name: Atlas\n", { name: "Atlas" }],
  ] as const)(
    "reads identity fields outside examples and ignores placeholders: %s",
    async (content, expected) => {
      expect(await parseIdentityFromContent(content)).toEqual(expected);
    },
  );
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
  [
    "- Name: Old\n- Name: Older\n```markdown\n- Name: Example\n- Emoji: ❌\n```\n",
    { name: "New", emoji: "🦀" },
    "- Name: New\n- Emoji: 🦀\n```markdown\n- Name: Example\n- Emoji: ❌\n```\n",
  ],
  [
    "# Identity\n\n~~~markdown\n- Name: Example\n~~~\n",
    { name: "New" },
    "# Identity\n\n- Name: New\n~~~markdown\n- Name: Example\n~~~\n",
  ],
  [
    "```markdown\n# Example\n\nExample prose.\n```\n",
    { name: "New", emoji: "🦀" },
    "- Name: New\n- Emoji: 🦀\n```markdown\n# Example\n\nExample prose.\n```\n",
  ],
  [
    "```markdown\n# Example\n- Name: Example",
    { name: "New" },
    "- Name: New\n```markdown\n# Example\n- Name: Example\n",
  ],
  ["    - Name: Old\n", { name: "New" }, "- Name: New\n"],
] as const)(
  "normalizes writable fields and preserves rich content: %s",
  (content, identity, expected) => {
    expect(mergeIdentityMarkdownContent(content, identity)).toBe(expected);
  },
);
it.each([
  [
    "- Name: Atlas\n\n1. Example:\n\n    ```markdown\n    - Name: Example\n    ```\n",
    "- Name: Nova\n- Emoji: X\n\n1. Example:\n\n    ```markdown\n    - Name: Example\n    ```\n",
  ],
  [
    "- Example:\n  ```markdown\n  - Name: Example\n- Name: Atlas\n",
    "- Example:\n  ```markdown\n  - Name: Example\n- Name: Nova\n- Emoji: X\n",
  ],
])(
  "keeps list-fenced examples out of identity reads and updates: %s",
  async (content, expected) => {
    expect(await parseIdentityFromContent(content)).toEqual({ name: "Atlas" });
    const merged = mergeIdentityMarkdownContent(content, { name: "Nova", emoji: "X" });
    expect(merged).toBe(expected);
    expect(await parseIdentityFromContent(merged)).toEqual({ name: "Nova", emoji: "X" });
  },
);

it.each([
  [
    "  ```md\n- Name: Example\n  ```\n",
    "- Name: Nova\n- Emoji: X\n\n<!-- -->\n\n  ```md\n- Name: Example\n  ```\n",
  ],
  [
    "  ```md\n- Name: Example",
    "- Name: Nova\n- Emoji: X\n\n<!-- -->\n\n  ```md\n- Name: Example\n",
  ],
  [
    "# Identity\n\n  ```md\n- Name: Example\n  ```\n",
    "- Name: Nova\n- Emoji: X\n\n<!-- -->\n\n# Identity\n\n  ```md\n- Name: Example\n  ```\n",
  ],
  [
    "-   Name: Old\n   ```md\n- Name: Example\n   ```\n",
    "- Emoji: X\n\n<!-- -->\n\n-   Name: Nova\n   ```md\n- Name: Example\n   ```\n",
  ],
  [
    "-\tName: Old\n   ```md\n- Name: Example\n   ```\n",
    "- Emoji: X\n\n<!-- -->\n\n-\tName: Nova\n   ```md\n- Name: Example\n   ```\n",
  ],
  [
    "- Name: Old\n  - Name: Again\n    - Name: Third\n      ```md\n      - Name: Example\n      ```\n",
    "- Emoji: X\n\n<!-- -->\n\n- Name: Nova\n  - Name: Nova\n    - Name: Nova\n      ```md\n      - Name: Example\n      ```\n",
  ],
  [
    "- Name: Old\n  ```md\n  sample\n- Name: Again\n  prose\n",
    "- Emoji: X\n\n<!-- -->\n\n- Name: Nova\n  ```md\n  sample\n- Name: Nova\n  prose\n",
  ],
  [
    "Name: Old\n\n  ```md\n- Name: Example\n  ```\n",
    "- Emoji: X\n\n<!-- -->\n\nName: Nova\n\n  ```md\n- Name: Example\n  ```\n",
  ],
  [
    "- Name: Old\n- Name: Again\n-   Creature: Turtle\n   ```md\n- Name: Example\n   ```\n",
    "- Emoji: X\n\n<!-- -->\n\n- Name: Nova\n-   Creature: Turtle\n   ```md\n- Name: Example\n   ```\n",
  ],
])("preserves fence context across repeated identity writes: %s", async (content, expected) => {
  const merged = mergeIdentityMarkdownContent(content, { name: "Nova", emoji: "X" });
  expect(merged).toBe(expected);
  expect(await parseIdentityFromContent(merged)).toMatchObject({ name: "Nova", emoji: "X" });
  expect(mergeIdentityMarkdownContent(merged, { name: "Nova", emoji: "X" })).toBe(merged);
  const changed = mergeIdentityMarkdownContent(merged, { name: "Orion", emoji: "Y" });
  expect(changed).toBe(expected.replaceAll("Nova", "Orion").replace("- Emoji: X", "- Emoji: Y"));
  expect(await parseIdentityFromContent(changed)).toMatchObject({ name: "Orion", emoji: "Y" });
});

it.each([
  ["**Nova**", { name: "Nova" }],
  ["`_Nova_`", { name: "_Nova_" }],
  ["*(not set yet)*", null],
] as const)(
  "retains decorated value semantics when preserving fence context: %s",
  async (name, expected) => {
    const content = "-   Name: Old\n   ```md\n- Name: Example\n   ```\n";
    const merged = mergeIdentityMarkdownContent(content, { name });
    expect(merged).toBe(content.replace("Old", name));
    expect(await parseIdentityFromContent(merged)).toEqual(expected);
    expect(mergeIdentityMarkdownContent(merged, { name })).toBe(merged);
    const changed = mergeIdentityMarkdownContent(merged, { name: "**Orion**" });
    expect(changed).toBe(content.replace("Old", "**Orion**"));
    expect(await parseIdentityFromContent(changed)).toEqual({ name: "Orion" });
  },
);

it("refuses an update that introduces a fence before writing the existing example", () => {
  const content = "```md\n- Name: Example\n```\n";
  expect(() => mergeIdentityMarkdownContent(content, { theme: "steady\n```" })).toThrow(
    "Identity update would change fenced Markdown content or field values",
  );
});

it("keeps existing multiline value parsing when fence boundaries remain intact", async () => {
  const content = "```md\n- Name: Example\n```\n";
  const merged = mergeIdentityMarkdownContent(content, { theme: "steady\nordinary prose" });
  expect(merged).toBe("- Theme: steady\nordinary prose\n" + content);
  expect(await parseIdentityFromContent(merged)).toEqual({ theme: "steady" });
});

describe("loadAgentIdentityFromWorkspace", () => {
  let tempDir: string;
  const load = () => loadAgentIdentityFromWorkspaceAsync(tempDir);

  beforeEach(() => {
    tempDir = tempDirs.make("openclaw-identity-");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["missing", "oversized", "invalid-encoding"])(
    "classifies %s identity reads without matching error text",
    async (kind) => {
      const identityPath = path.join(
        tempDir,
        kind === "missing" ? "identity-exceeds-limit.md" : "IDENTITY.md",
      );
      if (kind === "missing") {
        await expect(loadAgentIdentityFromFile(identityPath)).resolves.toBeNull();
      } else {
        fs.writeFileSync(
          identityPath,
          kind === "oversized"
            ? "x".repeat(TEST_MAX_IDENTITY_FILE_BYTES + 1)
            : Buffer.from([0x2d, 0x20, 0x4e, 0x61, 0x6d, 0x65, 0x3a, 0x20, 0xff]),
        );
        expect(loadAgentIdentityFromWorkspace(tempDir)).toBeNull();
        expect(await load()).toBeNull();
        await expect(loadAgentIdentityFromFile(identityPath)).rejects.toThrow(
          kind === "oversized"
            ? `exceeds the maximum size of ${TEST_MAX_IDENTITY_FILE_BYTES} bytes`
            : "must be valid UTF-8",
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
      const initial = "- Name: First\n- Emoji: 🤖\n";
      fs.writeFileSync(firstPath, initial);
      fs.utimesSync(firstPath, modified, modified);
      if (symlink) {
        fs.symlinkSync(firstPath, filePath);
      }
      const first = await load();
      expect(first).toEqual({ name: "First", emoji: "🤖" });
      expect(loadAgentIdentityFromWorkspace(tempDir)).toEqual(first);
      await expect(loadAgentIdentityFromFile(filePath)).resolves.toEqual(first);
      fs.writeFileSync(`${filePath}.next`, "- Name: Other\n- Emoji: 🤖\n");
      fs.utimesSync(`${filePath}.next`, modified, modified);
      if (symlink) {
        fs.unlinkSync(filePath);
        fs.symlinkSync(`${filePath}.next`, filePath);
      } else {
        fs.renameSync(`${filePath}.next`, filePath);
      }
      expect(await load()).toEqual({ name: "Other", emoji: "🤖" });
      fs.unlinkSync(filePath);
      expect(await load()).toBeNull();
      fs.writeFileSync(filePath, initial);
      const recreated = await load();
      expect(recreated).toEqual(first);
      expect(recreated).not.toBe(first);
    },
  );
});
