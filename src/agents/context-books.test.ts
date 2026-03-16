import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { CONTEXT_BOOKS_DIRNAME, loadContextBookBootstrapFiles } from "./context-books.js";

describe("loadContextBookBootstrapFiles", () => {
  it("loads enabled always-on entries from YAML and JSON files in descending order", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-context-books-");
    const contextBooksDir = path.join(workspaceDir, CONTEXT_BOOKS_DIRNAME);
    await fs.mkdir(contextBooksDir, { recursive: true });
    await fs.writeFile(
      path.join(contextBooksDir, "alpha.yaml"),
      [
        "entries:",
        "  - name: Low priority",
        "    enabled: true",
        "    alwaysActive: true",
        "    order: 1",
        "    content: |",
        "      low",
        "  - name: Triggered only",
        "    enabled: true",
        "    keywords: [vite]",
        "    content: |",
        "      skipped",
      ].join("\n"),
      "utf-8",
    );
    await fs.writeFile(
      path.join(contextBooksDir, "beta.json"),
      JSON.stringify({
        entries: [
          {
            name: "High priority",
            enabled: true,
            alwaysActive: true,
            order: 10,
            content: "high",
          },
        ],
      }),
      "utf-8",
    );

    const files = await loadContextBookBootstrapFiles({ workspaceDir });

    expect(files.map((file) => file.name)).toEqual([
      "CONTEXT_BOOK:High priority",
      "CONTEXT_BOOK:Low priority",
    ]);
    expect(files.map((file) => file.content)).toEqual(["high", "low"]);
    expect(files[0]?.path).toContain("beta.json#high-priority");
  });

  it("warns and skips entries with unsupported non-bootstrap positions", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-context-books-");
    const contextBooksDir = path.join(workspaceDir, CONTEXT_BOOKS_DIRNAME);
    await fs.mkdir(contextBooksDir, { recursive: true });
    await fs.writeFile(
      path.join(contextBooksDir, "depth.yaml"),
      [
        "entries:",
        "  - name: Tail reminder",
        "    enabled: true",
        "    alwaysActive: true",
        "    position: tail_reminder",
        "    content: |",
        "      do the thing",
      ].join("\n"),
      "utf-8",
    );

    const warnings: string[] = [];
    const files = await loadContextBookBootstrapFiles({
      workspaceDir,
      warn: (message) => warnings.push(message),
    });

    expect(files).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("unsupported position");
  });
});
