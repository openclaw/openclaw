import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createArtifactRegistry } from "../artifacts/artifact-registry.js";
import { buildBootstrapContextFiles, DEFAULT_BOOTSTRAP_MAX_CHARS } from "./pi-embedded-helpers.js";
import { DEFAULT_AGENTS_FILENAME } from "./workspace.js";

const makeFile = (overrides: Partial<WorkspaceBootstrapFile>): WorkspaceBootstrapFile => ({
  name: DEFAULT_AGENTS_FILENAME,
  path: "/tmp/AGENTS.md",
  content: "",
  missing: false,
  ...overrides,
});
describe("buildBootstrapContextFiles", () => {
  it("keeps missing markers", async () => {
    const files = [makeFile({ missing: true, content: undefined })];
    expect(await buildBootstrapContextFiles(files)).toEqual([
      {
        path: DEFAULT_AGENTS_FILENAME,
        content: "[MISSING] Expected at: /tmp/AGENTS.md",
      },
    ]);
  });
  it("skips empty or whitespace-only content", async () => {
    const files = [makeFile({ content: "   \n  " })];
    expect(await buildBootstrapContextFiles(files)).toEqual([]);
  });
  it("truncates large bootstrap content", async () => {
    const head = `HEAD-${"a".repeat(600)}`;
    const tail = `${"b".repeat(300)}-TAIL`;
    const long = `${head}${tail}`;
    const files = [makeFile({ name: "TOOLS.md", content: long })];
    const warnings: string[] = [];
    const maxChars = 200;
    const expectedTailChars = Math.floor(maxChars * 0.2);
    const [result] = await buildBootstrapContextFiles(files, {
      maxChars,
      warn: (message) => warnings.push(message),
    });
    expect(result?.content).toContain("[...truncated, read TOOLS.md for full content...]");
    expect(result?.content.length).toBeLessThan(long.length);
    expect(result?.content.startsWith(long.slice(0, 120))).toBe(true);
    expect(result?.content.endsWith(long.slice(-expectedTailChars))).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("TOOLS.md");
    expect(warnings[0]).toContain("limit 200");
  });
  it("keeps content under the default limit", async () => {
    const long = "a".repeat(DEFAULT_BOOTSTRAP_MAX_CHARS - 10);
    const files = [makeFile({ content: long })];
    const [result] = await buildBootstrapContextFiles(files);
    expect(result?.content).toBe(long);
    expect(result?.content).not.toContain("[...truncated, read AGENTS.md for full content...]");
  });

  it("uses ArtifactRef when artifact refs are enabled and content exceeds threshold", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-artifacts-"));
    const registry = createArtifactRegistry({ rootDir: tmp });

    const content = "# Big File\n" + "x".repeat(5000);
    const files = [makeFile({ name: "TOOLS.md", content })];

    const [result] = await buildBootstrapContextFiles(files, {
      maxChars: 500,
      artifactRefs: {
        enabled: true,
        thresholdChars: 1000,
        registry,
        mime: "text/markdown",
      },
    });

    expect(result?.content).toContain("ArtifactRef:");
    const match = result?.content.match(/ArtifactRef: ([a-f0-9]{64})/);
    expect(match?.[1]).toBeTruthy();

    const id = match![1];
    const stored = await registry.get(id);
    expect(stored.content).toBe(content.trimEnd());
  });
});
