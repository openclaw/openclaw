import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerMemoryWikiGatewayMethods } from "./gateway.js";
import { renderWikiMarkdown } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createPluginApi, createTempDir, createVault } = createMemoryWikiTestHarness();

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
  it("returns wiki status over the gateway", async () => {
    const { config } = await createVault({
      prefix: "memory-wiki-gateway-",
      initialize: true,
    });
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

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        vaultMode: "isolated",
        vaultExists: true,
      }),
    );
  });

  it("validates required query params for wiki.search", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-gateway-",
      initialize: true,
    });
    const { api, registerGatewayMethod } = createPluginApi();
    await fs.writeFile(
      path.join(rootDir, "sources", "alpha.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "source", id: "source.alpha", title: "Alpha" },
        body: "# Alpha\n",
      }),
      "utf8",
    );

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

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "query is required." }),
    );
  });

  it("ingests local files over the gateway and refreshes indexes", async () => {
    const inputRootDir = await createTempDir("memory-wiki-gateway-");
    const inputPath = path.join(inputRootDir, "alpha-notes.txt");
    await fs.writeFile(inputPath, "alpha over gateway\n", "utf8");
    const { api, registerGatewayMethod } = createPluginApi();
    const { config } = await createVault({
      rootDir: path.join(inputRootDir, "vault"),
    });

    registerMemoryWikiGatewayMethods({ api, config });
    const handler = findGatewayHandler(registerGatewayMethod, "wiki.ingest");
    if (!handler) {
      throw new Error("wiki.ingest handler missing");
    }
    const respond = vi.fn();

    await handler({
      params: {
        inputPath,
      },
      respond,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        pagePath: "sources/alpha-notes.md",
      }),
    );
    await expect(fs.readFile(path.join(config.vault.path, "index.md"), "utf8")).resolves.toContain(
      "[alpha notes](sources/alpha-notes.md)",
    );
  });

  it("applies wiki mutations over the gateway", async () => {
    const { config } = await createVault({
      prefix: "memory-wiki-gateway-",
    });
    const { api, registerGatewayMethod } = createPluginApi();

    registerMemoryWikiGatewayMethods({ api, config });
    const handler = findGatewayHandler(registerGatewayMethod, "wiki.apply");
    if (!handler) {
      throw new Error("wiki.apply handler missing");
    }
    const respond = vi.fn();

    await handler({
      params: {
        op: "create_synthesis",
        title: "Gateway Alpha",
        body: "Gateway summary.",
        sourceIds: ["source.alpha"],
      },
      respond,
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
