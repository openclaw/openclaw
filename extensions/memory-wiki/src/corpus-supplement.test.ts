import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { resolveMemoryWikiAgentConfig, resolveMemoryWikiConfig } from "./config.js";
import { createWikiCorpusSupplement } from "./corpus-supplement.js";

const { getMemoryWikiPage, searchMemoryWiki } = vi.hoisted(() => ({
  getMemoryWikiPage: vi.fn(),
  searchMemoryWiki: vi.fn(),
}));

vi.mock("./query.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./query.js")>()),
  getMemoryWikiPage,
  searchMemoryWiki,
}));

describe("memory-wiki corpus supplement", () => {
  const appConfig: OpenClawConfig = { agents: { entries: { support: {}, marketing: {} } } };
  const config = resolveMemoryWikiConfig({
    vault: { scope: "agent", path: "/tmp/memory-wiki-agents" },
  });

  const resolveConfig = vi.fn((agentId?: string, currentAppConfig?: OpenClawConfig) =>
    resolveMemoryWikiAgentConfig({ config, appConfig: currentAppConfig, agentId }),
  );
  const supplement = createWikiCorpusSupplement({ resolveConfig, getAppConfig: () => appConfig });
  beforeEach(() => {
    resolveConfig.mockClear();
    searchMemoryWiki.mockReset().mockResolvedValue([]);
    getMemoryWikiPage.mockReset().mockResolvedValue(null);
  });

  function expectedContext(agentId: string) {
    const scopedConfig = expect.objectContaining({
      agentId,
      vault: expect.objectContaining({ path: path.join(config.vault.path, agentId) }),
    });
    return { config: scopedConfig, appConfig, searchBackend: "local", searchCorpus: "wiki" };
  }

  it("resolves search and get from each invocation's agent context", async () => {
    const search = {
      query: "support handbook",
      maxResults: 4,
      agentId: "support",
      agentSessionKey: "agent:support:main",
      sandboxed: true,
    };
    const get = {
      lookup: "marketing-plan",
      fromLine: 3,
      lineCount: 8,
      agentId: "marketing",
      agentSessionKey: "agent:marketing:main",
      sandboxed: false,
    };
    await supplement.search(search);
    await supplement.get(get);

    expect(resolveConfig).toHaveBeenNthCalledWith(1, "support", appConfig);
    expect(resolveConfig).toHaveBeenNthCalledWith(2, "marketing", appConfig);
    expect(searchMemoryWiki).toHaveBeenCalledWith({
      ...expectedContext("support"),
      ...search,
    });
    expect(getMemoryWikiPage).toHaveBeenCalledWith({
      ...expectedContext("marketing"),
      ...get,
    });
  });

  it("fails closed before querying when multi-agent context is missing", async () => {
    await expect(supplement.search({ query: "shared data" })).rejects.toThrow(
      "agentId is required",
    );
    expect(searchMemoryWiki).not.toHaveBeenCalled();
  });
});
