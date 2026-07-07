// Prompt template tests cover markdown discovery and fallback metadata.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPromptTemplates } from "./prompt-templates.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadPromptTemplates", () => {
  it("keeps fallback descriptions on a UTF-16 boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-prompt-templates-"));
    tempDirs.push(root);
    const promptsDir = join(root, "prompts");
    await mkdir(promptsDir, { recursive: true });
    await writeFile(join(promptsDir, "emoji.md"), `${"a".repeat(59)}🚀tail\n`, "utf-8");

    const templates = loadPromptTemplates({
      cwd: root,
      agentDir: join(root, "agent"),
      promptPaths: [promptsDir],
      includeDefaults: false,
    });

    expect(templates).toHaveLength(1);
    expect(templates[0]?.description).toBe(`${"a".repeat(59)}...`);
  });
});
