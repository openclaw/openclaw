import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";
import type { OpenClawPluginApi } from "./api.js";
import plugin from "./index.js";

function createApi() {
  const registerCli = vi.fn();
  const registerGatewayMethod = vi.fn();
  const registerMemoryCorpusSupplement = vi.fn();
  const registerMemoryPromptSupplement = vi.fn();
  const registerTool = vi.fn();
  const api = createTestPluginApi({
    id: "memory-wiki",
    name: "Memory Wiki",
    source: "test",
    config: {},
    runtime: {} as OpenClawPluginApi["runtime"],
    registerCli,
    registerGatewayMethod,
    registerMemoryCorpusSupplement,
    registerMemoryPromptSupplement,
    registerTool,
  }) as OpenClawPluginApi;
  return {
    api,
    registerCli,
    registerGatewayMethod,
    registerMemoryCorpusSupplement,
    registerMemoryPromptSupplement,
    registerTool,
  };
}

describe("memory-wiki plugin", () => {
  it("registers prompt supplement, gateway methods, tools, and wiki cli surface", async () => {
    const {
      api,
      registerCli,
      registerGatewayMethod,
      registerMemoryCorpusSupplement,
      registerMemoryPromptSupplement,
      registerTool,
    } = createApi();

    await plugin.register(api);

    expect(registerMemoryCorpusSupplement).toHaveBeenCalledTimes(1);
    expect(registerMemoryPromptSupplement).toHaveBeenCalledTimes(1);
    expect(registerGatewayMethod.mock.calls.map((call) => call[0])).toEqual([
      "wiki.status",
      "wiki.init",
      "wiki.doctor",
      "wiki.compile",
      "wiki.ingest",
      "wiki.lint",
      "wiki.bridge.import",
      "wiki.unsafeLocal.import",
      "wiki.search",
      "wiki.apply",
      "wiki.get",
      "wiki.obsidian.status",
      "wiki.obsidian.search",
      "wiki.obsidian.open",
      "wiki.obsidian.command",
      "wiki.obsidian.daily",
    ]);
    expect(registerTool).toHaveBeenCalledTimes(5);
    expect(registerTool.mock.calls.map((call) => call[1]?.name)).toEqual([
      "wiki_status",
      "wiki_lint",
      "wiki_apply",
      "wiki_search",
      "wiki_get",
    ]);
    expect(registerCli).toHaveBeenCalledTimes(1);
    expect(registerCli.mock.calls[0]?.[1]).toMatchObject({
      descriptors: [
        expect.objectContaining({
          name: "wiki",
          hasSubcommands: true,
        }),
      ],
    });
  });
});
