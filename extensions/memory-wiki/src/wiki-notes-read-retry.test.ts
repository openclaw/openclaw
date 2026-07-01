import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ingestMemoryWikiSource } from "./ingest.js";
import { renderMarkdownFence, renderWikiMarkdown } from "./markdown.js";
import { writeImportedSourcePage } from "./source-page-shared.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const securityRuntimeMock = vi.hoisted(() => ({
  failReadTextOnceFor: undefined as string | undefined,
  readTextFailureInjected: false,
}));

vi.mock("openclaw/plugin-sdk/security-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/security-runtime")>();
  return {
    ...actual,
    root: async (...args: Parameters<typeof actual.root>) => {
      const vault = await actual.root(...args);
      return new Proxy(vault, {
        get(target, prop, receiver) {
          if (prop !== "readText") {
            return Reflect.get(target, prop, receiver);
          }
          return async (relativePath: string) => {
            if (
              securityRuntimeMock.failReadTextOnceFor === relativePath &&
              !securityRuntimeMock.readTextFailureInjected
            ) {
              securityRuntimeMock.readTextFailureInjected = true;
              throw new Error("transient existing-page read failure");
            }
            return target.readText(relativePath);
          };
        },
      });
    },
  };
});

const { createTempDir, createVault } = createMemoryWikiTestHarness();

function buildSourcePage(raw: string, updatedAt: string): string {
  return renderWikiMarkdown({
    frontmatter: {
      pageType: "source",
      id: "source.imported",
      title: "imported",
      sourceType: "memory-unsafe-local",
      status: "active",
      updatedAt,
    },
    body: [
      "# imported",
      "",
      "## Content",
      renderMarkdownFence(raw, "text"),
      "",
      "## Notes",
      "<!-- openclaw:human:start -->",
      "<!-- openclaw:human:end -->",
      "",
    ].join("\n"),
  });
}

describe("memory-wiki existing-page read retry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    securityRuntimeMock.failReadTextOnceFor = undefined;
    securityRuntimeMock.readTextFailureInjected = false;
  });

  it("preserves ingest notes after a transient existing-page read failure", async () => {
    const rootDir = await createTempDir("memory-wiki-reingest-read-retry-");
    const inputPath = path.join(rootDir, "roadmap.txt");
    const { config } = await createVault({ rootDir: path.join(rootDir, "vault") });

    await fs.writeFile(inputPath, "v1 content\n", "utf8");
    await ingestMemoryWikiSource({
      config,
      inputPath,
      nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
    });

    const pagePath = path.join(config.vault.path, "sources", "roadmap.md");
    const userNote = "KEY INSIGHT: covers the Q2 roadmap";
    const edited = (await fs.readFile(pagePath, "utf8")).replace(
      "<!-- openclaw:human:start -->\n<!-- openclaw:human:end -->",
      `<!-- openclaw:human:start -->\n${userNote}\n<!-- openclaw:human:end -->`,
    );
    await fs.writeFile(pagePath, edited, "utf8");

    await fs.writeFile(inputPath, "v2 content updated\n", "utf8");
    const originalReadFile = fs.readFile.bind(fs);
    let injectedFailure = false;
    vi.spyOn(fs, "readFile").mockImplementation(
      async (...args: Parameters<typeof fs.readFile>): ReturnType<typeof fs.readFile> => {
        if (!injectedFailure && args[0] === pagePath && args[1] === "utf8") {
          injectedFailure = true;
          throw new Error("transient existing-page read failure");
        }
        return originalReadFile(...args);
      },
    );

    await ingestMemoryWikiSource({
      config,
      inputPath,
      nowMs: Date.UTC(2026, 3, 6, 12, 0, 0),
    });

    const after = await originalReadFile(pagePath, "utf8");
    expect(injectedFailure).toBe(true);
    expect(after).toContain("v2 content updated");
    expect(after).toContain(userNote);
  });

  it("preserves imported notes after a transient existing-page read failure", async () => {
    const suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-source-page-"));
    const sourcePath = path.join(suiteRoot, "imported-retry.txt");
    const pagePath = "sources/imported-retry.md";
    const absPage = path.join(suiteRoot, pagePath);
    const state: Parameters<typeof writeImportedSourcePage>[0]["state"] = {
      entries: {},
      version: 1,
    };

    try {
      await fs.writeFile(sourcePath, "first body", "utf8");
      await writeImportedSourcePage({
        vaultRoot: suiteRoot,
        syncKey: "bridge:imported-retry",
        sourcePath,
        sourceUpdatedAtMs: Date.UTC(2026, 4, 1),
        sourceSize: 10,
        renderFingerprint: "fp-1",
        pagePath,
        group: "bridge",
        state,
        buildRendered: buildSourcePage,
      });

      const userNote = "IMPORTED PAGE NOTE FROM HUMAN";
      const edited = (await fs.readFile(absPage, "utf8")).replace(
        "<!-- openclaw:human:start -->\n<!-- openclaw:human:end -->",
        `<!-- openclaw:human:start -->\n${userNote}\n<!-- openclaw:human:end -->`,
      );
      await fs.writeFile(absPage, edited, "utf8");

      securityRuntimeMock.failReadTextOnceFor = pagePath;

      await fs.writeFile(sourcePath, "second body changed", "utf8");
      const result = await writeImportedSourcePage({
        vaultRoot: suiteRoot,
        syncKey: "bridge:imported-retry",
        sourcePath,
        sourceUpdatedAtMs: Date.UTC(2026, 4, 2),
        sourceSize: 19,
        renderFingerprint: "fp-2",
        pagePath,
        group: "bridge",
        state,
        buildRendered: buildSourcePage,
      });

      const after = await fs.readFile(absPage, "utf8");
      expect(securityRuntimeMock.readTextFailureInjected).toBe(true);
      expect(result.changed).toBe(true);
      expect(after).toContain("second body changed");
      expect(after).toContain(userNote);
    } finally {
      await fs.rm(suiteRoot, { recursive: true, force: true });
    }
  });
});
