import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callPluginToolsMcp } from "./suite-runtime-agent-tools.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const peer = new URL("./suite-runtime-agent-tools.v1-peer.fixture.mjs", import.meta.url).href;
const { cleanup, makeTempDir } = createTempDirHarness();

describe("QA MCP v1 stdio interoperability", () => {
  let root: string;
  let env: Parameters<typeof callPluginToolsMcp>[0]["env"];

  beforeEach(async () => {
    root = await makeTempDir("qa-mcp-v1-peer-");
    const entry = path.join(root, "dist", "mcp", "plugin-tools-serve.js");
    await fs.mkdir(path.dirname(entry), { recursive: true });
    await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
    await fs.writeFile(entry, `await import(${JSON.stringify(peer)});\n`);
    env = {
      repoRoot: root,
      gateway: { runtimeEnv: { MCP_PEER_STATE_DIR: root } },
    };
  });

  afterEach(cleanup);

  const call = (toolName: string, args = {}) => callPluginToolsMcp({ env, toolName, args });
  const events = async (): Promise<
    Array<{ event: string; pid?: number; cursor?: string | null; name?: string }>
  > => JSON.parse(await fs.readFile(path.join(root, "events.json"), "utf8"));

  async function expectClosedWithOneCatalogRequest() {
    const observed = await events();
    expect(observed.filter(({ event }) => event === "list")).toEqual([
      { event: "list", cursor: null },
    ]);
    const pid = observed.find(({ event }) => event === "started")?.pid;
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  }

  it("calls first-page tools and closes the real subprocess", async () => {
    await expect(call("fixture.echo")).resolves.toMatchObject({
      structuredContent: { value: "first-page-result" },
    });
    await expectClosedWithOneCatalogRequest();
  });

  it("keeps page-two-only tools unavailable without following the cursor", async () => {
    await expect(call("fixture.next")).rejects.toThrow(
      "MCP tool missing: fixture.next; available tools: fixture.echo, list_pages",
    );
    expect((await events()).filter(({ event }) => event === "call")).toEqual([]);
    await expectClosedWithOneCatalogRequest();
  });

  it("rejects output that does not match the selected first-page tool schema", async () => {
    await expect(call("fixture.echo", { invalid: true })).rejects.toThrow(/output|schema|valid/i);
    await expectClosedWithOneCatalogRequest();
  });
});
