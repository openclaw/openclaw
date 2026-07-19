// Memory Wiki tests cover corpus supplement visibility at the real query boundary.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { resolveMemoryWikiAgentConfig } from "./config.js";
import { createWikiCorpusSupplement } from "./corpus-supplement.js";
import { renderWikiMarkdown } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

describe("memory-wiki corpus supplement visibility", () => {
  it("denies sandboxed foreign bridge fallback reads and preserves global sharing", async () => {
    const { rootDir, config } = await createVault({
      initialize: true,
      config: { vault: { scope: "global" } },
    });
    await fs.writeFile(
      path.join(rootDir, "sources", "secondary-private.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.secondary-private",
          title: "Secondary Private",
          sourceType: "memory-bridge",
          sourcePath: "/tmp/secondary/MEMORY.md",
          bridgeRelativePath: "MEMORY.md",
          bridgeWorkspaceDir: "/tmp/secondary",
          bridgeAgentIds: ["secondary"],
        },
        body: "# Secondary Private\n\nREDACTED-FOREIGN-MARKER\n",
      }),
      "utf8",
    );
    const appConfig = {
      agents: { list: [{ id: "main", default: true }, { id: "secondary" }] },
    } as OpenClawConfig;
    const supplement = createWikiCorpusSupplement({
      getAppConfig: () => appConfig,
      resolveConfig: (agentId, currentAppConfig) =>
        resolveMemoryWikiAgentConfig({ config, appConfig: currentAppConfig, agentId }),
    });
    const caller = {
      agentId: "main",
      agentSessionKey: "agent:main:child-session",
    };

    const sandboxedSearch = await supplement.search({
      ...caller,
      sandboxed: true,
      query: "REDACTED-FOREIGN-MARKER",
    });
    const sandboxedGet = await supplement.get({
      ...caller,
      sandboxed: true,
      lookup: "secondary-private",
    });
    const globalSearch = await supplement.search({
      ...caller,
      sandboxed: false,
      query: "REDACTED-FOREIGN-MARKER",
    });
    const globalGet = await supplement.get({
      ...caller,
      sandboxed: false,
      lookup: "secondary-private",
    });

    expect(sandboxedSearch).toEqual([]);
    expect(sandboxedGet).toBeNull();
    expect(globalSearch.map((result) => result.path)).toEqual(["sources/secondary-private.md"]);
    expect(globalGet?.content).toContain("REDACTED-FOREIGN-MARKER");
  });
});
