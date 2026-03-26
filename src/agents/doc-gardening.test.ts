import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDocGardeningSuggestion } from "./doc-gardening.js";

const tempDirs: string[] = [];

async function writeFile(root: string, relativePath: string, content: string) {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

describe("buildDocGardeningSuggestion", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("finds stale, missing, and metadata issues in repo knowledge docs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doc-garden-"));
    tempDirs.push(root);

    await writeFile(
      root,
      "docs/concepts/docs-index.md",
      `---
summary: "Docs index"
owner: "OpenClaw harness"
freshness: "monthly"
last_reviewed: "2025-01-01"
title: "Docs Index"
---
`,
    );
    await writeFile(
      root,
      "docs/exec-plans/README.md",
      `---
summary: "Exec plans"
owner: "OpenClaw harness"
freshness: "monthly"
last_reviewed: "2026-03-20"
title: "Execution Plans"
---
`,
    );
    await writeFile(
      root,
      "docs/exec-plans/missing-meta.md",
      `---
summary: "Missing metadata"
owner: "OpenClaw harness"
title: "Missing metadata"
---
`,
    );

    const suggestion = await buildDocGardeningSuggestion({
      workspaceDir: root,
      now: Date.UTC(2026, 2, 25, 12, 0, 0),
    });

    expect(suggestion.cadence).toBe("daily");
    expect(suggestion.focus).toContain("stale docs");
    expect(suggestion.focus).toContain("missing repo knowledge docs");
    expect(suggestion.focus).toContain("missing doc metadata");
    expect(suggestion.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "docs/concepts/docs-index.md",
          kind: "stale",
        }),
        expect.objectContaining({
          path: "docs/tech-debt/README.md",
          kind: "missing",
        }),
        expect.objectContaining({
          path: "docs/exec-plans/missing-meta.md",
          kind: "metadata",
        }),
      ]),
    );
  });
});
