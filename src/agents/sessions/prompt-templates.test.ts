// Prompt template tests cover markdown discovery and fallback metadata.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPromptTemplates } from "./prompt-templates.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("loadPromptTemplates", () => {
  it("keeps fallback descriptions on a UTF-16 boundary", async () => {
    const root = await makeTempDir("openclaw-prompt-templates-");
    const promptsDir = join(root, "prompts");
    await mkdir(promptsDir, { recursive: true });
    await writeFile(join(promptsDir, "emoji.md"), `${"a".repeat(59)}\u{1f63e}tail\n`, "utf-8");

    const templates = loadPromptTemplates({
      cwd: root,
      agentDir: join(root, "agent"),
      promptPaths: [promptsDir],
      includeDefaults: false,
    });

    expect(templates).toHaveLength(1);
    expect(templates[0]?.description).toBe(`${"a".repeat(59)}...`);
    expect(hasLoneSurrogate(templates[0]?.description ?? "")).toBe(false);
  });
});
