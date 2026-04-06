import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyMemoryWikiMutation,
  normalizeMemoryWikiMutationInput,
  type ApplyMemoryWikiMutation,
} from "./apply.js";
import { registerMemoryWikiGatewayMethods } from "./gateway.js";
import { ingestMemoryWikiSource } from "./ingest.js";
import { searchMemoryWiki } from "./query.js";
import { syncMemoryWikiImportedSources } from "./source-sync.js";
import { resolveMemoryWikiStatus } from "./status.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

vi.mock("./apply.js", () => ({
  applyMemoryWikiMutation: vi.fn(),
  normalizeMemoryWikiMutationInput: vi.fn(),
}));

vi.mock("./compile.js", () => ({
  compileMemoryWikiVault: vi.fn(),
}));

vi.mock("./ingest.js", () => ({
  ingestMemoryWikiSource: vi.fn(),
}));

vi.mock("./lint.js", () => ({
  lintMemoryWikiVault: vi.fn(),
}));

vi.mock("./obsidian.js", () => ({
  probeObsidianCli: vi.fn(),
  runObsidianCommand: vi.fn(),
  runObsidianDaily: vi.fn(),
  runObsidianOpen: vi.fn(),
  runObsidianSearch: vi.fn(),
}));

vi.mock("./query.js", () => ({
  getMemoryWikiPage: vi.fn(),
  searchMemoryWiki: vi.fn(),
}));

vi.mock("./source-sync.js", () => ({
  syncMemoryWikiImportedSources: vi.fn(),
}));

vi.mock("./status.js", () => ({
  buildMemoryWikiDoctorReport: vi.fn(),
  resolveMemoryWikiStatus: vi.fn(),
}));

vi.mock("./vault.js", () => ({
  initializeMemoryWikiVault: vi.fn(),
}));

const { createPluginApi, createVault } = createMemoryWikiTestHarness();

function findGatewayHandler(
  registerGatewayMethod: ReturnType<typeof vi.fn>,
  method: string,
):
  | ((ctx: {
      params: Record<string, unknown>;
      respond: (ok: boolean, payload?: unknown, error?: unknown) => void;
    }) => Promise<void>)
  | undefined {
  return registerGatewayMethod.mock.calls.find((call) => call[0] === method)?.[1];
}

describe("memory-wiki gateway methods", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(syncMemoryWikiImportedSources).mockResolvedValue({
      importedCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      removedCount: 0,
      artifactCount: 0,
      workspaces: 0,
      pagePaths: [],
      indexesRefreshed: false,
      indexUpdatedFiles: [],
      indexRefreshReason: "no-import-changes",
    });
    vi.mocked(resolveMemoryWikiStatus).mockResolvedValue({
      vaultMode: "isolated",
      vaultExists: true,
    } as never);
    vi.mocked(ingestMemoryWikiSource).mockResolvedValue({
      pagePath: "sources/alpha-notes.md",
    } as never);
    vi.mocked(normalizeMemoryWikiMutationInput).mockReturnValue({
      op: "create_synthesis",
      title: "Gateway Alpha",
      body: "Gateway summary.",
      sourceIds: ["source.alpha"],
    } satisfies ApplyMemoryWikiMutation);
    vi.mocked(applyMemoryWikiMutation).mockResolvedValue({
      operation: "create_synthesis",
      pagePath: "syntheses/gateway-alpha.md",
    } as never);
    vi.mocked(searchMemoryWiki).mockResolvedValue({
      items: [],
      total: 0,
    } as never);
  });

  it("returns wiki status over the gateway", async () => {
    const { config } = await createVault({ prefix: "memory-wiki-gateway-" });
    const { api, registerGatewayMethod } = createPluginApi();

    registerMemoryWikiGatewayMethods({ api, config });
    const handler = findGatewayHandler(registerGatewayMethod, "wiki.status");
    if (!handler) {
      throw new Error("wiki.status handler missing");
    }
    const respond = vi.fn();

    await handler({
      params: {},
      respond,
    });

    expect(syncMemoryWikiImportedSources).toHaveBeenCalledWith({ config, appConfig: undefined });
    expect(resolveMemoryWikiStatus).toHaveBeenCalledWith(config);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        vaultMode: "isolated",
        vaultExists: true,
      }),
    );
  });

  it("validates required query params for wiki.search", async () => {
    const { config } = await createVault({ prefix: "memory-wiki-gateway-" });
    const { api, registerGatewayMethod } = createPluginApi();

    registerMemoryWikiGatewayMethods({ api, config });
    const handler = findGatewayHandler(registerGatewayMethod, "wiki.search");
    if (!handler) {
      throw new Error("wiki.search handler missing");
    }
    const respond = vi.fn();

    await handler({
      params: {},
      respond,
    });

    expect(searchMemoryWiki).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "query is required." }),
    );
  });

  it("forwards ingest requests over the gateway", async () => {
    const { config } = await createVault({ prefix: "memory-wiki-gateway-" });
    const { api, registerGatewayMethod } = createPluginApi();

    registerMemoryWikiGatewayMethods({ api, config });
    const handler = findGatewayHandler(registerGatewayMethod, "wiki.ingest");
    if (!handler) {
      throw new Error("wiki.ingest handler missing");
    }
    const respond = vi.fn();

    await handler({
      params: {
        inputPath: "/tmp/alpha-notes.txt",
        title: "Alpha",
      },
      respond,
    });

    expect(ingestMemoryWikiSource).toHaveBeenCalledWith({
      config,
      inputPath: "/tmp/alpha-notes.txt",
      title: "Alpha",
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        pagePath: "sources/alpha-notes.md",
      }),
    );
  });

  it("applies wiki mutations over the gateway", async () => {
    const { config } = await createVault({ prefix: "memory-wiki-gateway-" });
    const { api, registerGatewayMethod } = createPluginApi();

    registerMemoryWikiGatewayMethods({ api, config });
    const handler = findGatewayHandler(registerGatewayMethod, "wiki.apply");
    if (!handler) {
      throw new Error("wiki.apply handler missing");
    }
    const respond = vi.fn();
    const params = {
      op: "create_synthesis",
      title: "Gateway Alpha",
      body: "Gateway summary.",
      sourceIds: ["source.alpha"],
    };

    await handler({
      params,
      respond,
    });

    expect(normalizeMemoryWikiMutationInput).toHaveBeenCalledWith(params);
    expect(applyMemoryWikiMutation).toHaveBeenCalledWith({
      config,
      mutation: expect.objectContaining({
        op: "create_synthesis",
        title: "Gateway Alpha",
      }),
    });
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        operation: "create_synthesis",
        pagePath: "syntheses/gateway-alpha.md",
      }),
    );
  });
});
