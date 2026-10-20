import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { resolveMemoryWikiAgentConfig, resolveMemoryWikiConfig } from "./config.js";
import { createWikiCorpusSupplement } from "./corpus-supplement.js";

const queryMocks = vi.hoisted(() => ({
  getMemoryWikiPage: vi.fn(),
  searchMemoryWiki: vi.fn(),
}));

vi.mock("./query.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./query.js")>()),
  ...queryMocks,
}));

describe("memory-wiki corpus supplement", () => {
  const appConfig: OpenClawConfig = { agents: { entries: { support: {}, marketing: {} } } };
  const config = resolveMemoryWikiConfig({
    vault: { scope: "agent", path: "/tmp/memory-wiki-agents" },
  });

  beforeEach(() => {
    queryMocks.searchMemoryWiki.mockReset().mockResolvedValue([]);
    queryMocks.getMemoryWikiPage.mockReset().mockResolvedValue(null);
  });

  function createSupplement() {
    const resolveConfig = vi.fn((agentId?: string, currentAppConfig?: OpenClawConfig) =>
      resolveMemoryWikiAgentConfig({ config, appConfig: currentAppConfig, agentId }),
    );
    return {
      resolveConfig,
      supplement: createWikiCorpusSupplement({ resolveConfig, getAppConfig: () => appConfig }),
    };
  }

  function expectedContext(agentId: string, sandboxed: boolean) {
    return {
      config: expect.objectContaining({
        agentId,
        vault: expect.objectContaining({ path: path.join(config.vault.path, agentId) }),
      }),
      appConfig,
      agentId,
      agentSessionKey: `agent:${agentId}:main`,
      sandboxed,
      searchBackend: "local",
      searchCorpus: "wiki",
    };
  }

  it("resolves search and get from each invocation's agent context", async () => {
    const { resolveConfig, supplement } = createSupplement();

    await supplement.search({
      query: "support handbook",
      maxResults: 4,
      agentId: "support",
      agentSessionKey: "agent:support:main",
      sandboxed: true,
    });
    await supplement.get({
      lookup: "marketing-plan",
      fromLine: 3,
      lineCount: 8,
      agentId: "marketing",
      agentSessionKey: "agent:marketing:main",
      sandboxed: false,
    });

    expect(resolveConfig).toHaveBeenNthCalledWith(1, "support", appConfig);
    expect(resolveConfig).toHaveBeenNthCalledWith(2, "marketing", appConfig);
    expect(queryMocks.searchMemoryWiki).toHaveBeenCalledWith({
      ...expectedContext("support", true),
      query: "support handbook",
      maxResults: 4,
    });
    expect(queryMocks.getMemoryWikiPage).toHaveBeenCalledWith({
      ...expectedContext("marketing", false),
      lookup: "marketing-plan",
      fromLine: 3,
      lineCount: 8,
    });
  });

  it("fails closed before querying when multi-agent context is missing", async () => {
    const { supplement } = createSupplement();

    await expect(supplement.search({ query: "shared data" })).rejects.toThrow(
      "agentId is required",
    );
    expect(queryMocks.searchMemoryWiki).not.toHaveBeenCalled();
  });
});
