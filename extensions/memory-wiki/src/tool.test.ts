import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import type { MemoryWikiPluginConfig, ResolvedMemoryWikiConfig } from "./config.js";
import { renderWikiMarkdown } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";
import { createWikiApplyTool, createWikiSearchTool } from "./tool.js";

const { getActiveMemorySearchManagerMock, resolveDefaultAgentIdMock, resolveSessionAgentIdMock } =
  vi.hoisted(() => ({
    getActiveMemorySearchManagerMock: vi.fn(),
    resolveDefaultAgentIdMock: vi.fn(() => "main"),
    resolveSessionAgentIdMock: vi.fn(() => "main"),
  }));

vi.mock("openclaw/plugin-sdk/memory-host-search", () => ({
  getActiveMemorySearchManager: getActiveMemorySearchManagerMock,
}));

vi.mock("openclaw/plugin-sdk/memory-host-core", () => ({
  resolveDefaultAgentId: resolveDefaultAgentIdMock,
  resolveSessionAgentId: resolveSessionAgentIdMock,
}));

const { createVault } = createMemoryWikiTestHarness();
let suiteRoot = "";
let caseIndex = 0;

function asSchemaObject(value: unknown): Record<string, unknown> {
  expect(value).toEqual(expect.any(Object));
  return value as Record<string, unknown>;
}

describe("memory-wiki tools", () => {
  beforeAll(async () => {
    suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-tools-suite-"));
  });

  afterAll(async () => {
    if (suiteRoot) {
      await fs.rm(suiteRoot, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    getActiveMemorySearchManagerMock.mockReset();
    getActiveMemorySearchManagerMock.mockResolvedValue({ manager: null, error: "unavailable" });
    resolveDefaultAgentIdMock.mockClear();
    resolveSessionAgentIdMock.mockClear();
  });

  async function createToolVault(options?: {
    config?: MemoryWikiPluginConfig;
    initialize?: boolean;
  }) {
    return createVault({
      prefix: "memory-wiki-tools-",
      rootDir: path.join(suiteRoot, `case-${caseIndex++}`),
      initialize: options?.initialize,
      config: options?.config,
    });
  }

  function createAppConfig(): OpenClawConfig {
    return {
      agents: {
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;
  }

  it("allows provenance metadata in wiki_apply claim evidence", () => {
    const tool = createWikiApplyTool({} as ResolvedMemoryWikiConfig);
    const applyProperties = asSchemaObject(asSchemaObject(tool.parameters).properties);
    const claimsSchema = asSchemaObject(applyProperties.claims);
    const claimSchema = asSchemaObject(claimsSchema.items);
    const claimProperties = asSchemaObject(claimSchema.properties);
    const evidenceSchema = asSchemaObject(claimProperties.evidence);
    const evidenceArraySchema = asSchemaObject(evidenceSchema.items);
    const evidenceProperties = asSchemaObject(evidenceArraySchema.properties);

    expect(Object.keys(evidenceProperties)).toEqual(
      expect.arrayContaining(["kind", "confidence", "privacyTier"]),
    );
    expect(evidenceProperties.confidence).toMatchObject({ minimum: 0, maximum: 1 });
  });

  it("keeps wiki_search tool output visible when shared memory search is unavailable", async () => {
    const { rootDir, config } = await createToolVault({
      initialize: true,
      config: {
        search: { backend: "shared", corpus: "all" },
      },
    });
    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "source", id: "source.alpha", title: "Alpha Source" },
        body: "# Alpha Source\n\nalpha tool result should remain visible\n",
      }),
      "utf8",
    );
    getActiveMemorySearchManagerMock.mockResolvedValue({ manager: { readFile: vi.fn() } });
    const tool = createWikiSearchTool(config, createAppConfig());

    const result = await tool.execute("tool-call-1", {
      query: "alpha",
      corpus: "all",
    });

    expect(result.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("Alpha Source (wiki/source)"),
      },
    ]);
    const details = result.details as { results: Array<{ corpus: string; title: string }> };
    expect(details.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          corpus: "wiki",
          title: "Alpha Source",
        }),
      ]),
    );
    expect(details.results.some((entry) => entry.corpus === "memory")).toBe(false);
  });
});
