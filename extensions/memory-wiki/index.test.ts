// Memory Wiki tests cover index plugin behavior.
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import type { AnyAgentTool } from "./api.js";
import plugin from "./index.js";
import { createMemoryWikiTestHarness } from "./src/test-helpers.js";

const { createPluginApi } = createMemoryWikiTestHarness();

describe("memory-wiki plugin", () => {
  it("registers prompt supplement, gateway methods, tools, and wiki cli surface", () => {
    const {
      api,
      registerCli,
      registerGatewayMethod,
      registerMemoryCorpusSupplement,
      registerMemoryPromptSupplement,
      registerTool,
    } = createPluginApi();

    plugin.register(api);

    expect(registerMemoryCorpusSupplement).toHaveBeenCalledTimes(1);
    expect(registerMemoryPromptSupplement).toHaveBeenCalledTimes(1);
    expect(registerGatewayMethod.mock.calls.map((call) => call[0])).toEqual([
      "wiki.status",
      "wiki.importRuns",
      "wiki.importInsights",
      "wiki.palace",
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
    expect(registerCli.mock.calls[0]?.[1]).toStrictEqual({
      descriptors: [
        {
          name: "wiki",
          description: "Inspect and initialize the memory wiki vault",
          hasSubcommands: true,
        },
      ],
    });
  });

  it("marks wiki memory tools explicit-only in shared sessions", () => {
    const { api, registerTool } = createPluginApi();

    plugin.register(api);

    const wikiSearchFactory = registerTool.mock.calls.find(
      (call) => call[1]?.name === "wiki_search",
    )?.[0] as (ctx: OpenClawPluginToolContext) => AnyAgentTool;
    const wikiStatusFactory = registerTool.mock.calls.find(
      (call) => call[1]?.name === "wiki_status",
    )?.[0] as (ctx: OpenClawPluginToolContext) => AnyAgentTool;
    const wikiGetFactory = registerTool.mock.calls.find(
      (call) => call[1]?.name === "wiki_get",
    )?.[0] as (ctx: OpenClawPluginToolContext) => AnyAgentTool;
    const wikiLintFactory = registerTool.mock.calls.find(
      (call) => call[1]?.name === "wiki_lint",
    )?.[0] as (ctx: OpenClawPluginToolContext) => AnyAgentTool;
    const wikiApplyFactory = registerTool.mock.calls.find(
      (call) => call[1]?.name === "wiki_apply",
    )?.[0] as (ctx: OpenClawPluginToolContext) => AnyAgentTool;

    const sharedContext = {
      agentId: "main",
      sessionKey: "agent:main:acp:binding:opaque",
      chatType: "group",
    } as OpenClawPluginToolContext;
    const directContext = {
      ...sharedContext,
      chatType: "direct",
    } as OpenClawPluginToolContext;

    expect(wikiStatusFactory(sharedContext).description).toContain("Limited wiki status");
    expect(wikiStatusFactory(directContext).description).not.toContain("Limited wiki status");
    expect(wikiSearchFactory(sharedContext).description).toContain("explicitly asks");
    expect(wikiGetFactory(sharedContext).description).toContain("explicitly asks");
    expect(wikiSearchFactory(directContext).description).not.toContain("explicitly asks");
    expect(wikiGetFactory(directContext).description).not.toContain("explicitly asks");
    expect(wikiLintFactory(sharedContext).description).toContain("disabled for shared sessions");
    expect(wikiApplyFactory(sharedContext).description).toContain("disabled for shared sessions");
    expect(wikiLintFactory(directContext).description).not.toContain("disabled for shared sessions");
    expect(wikiApplyFactory(directContext).description).not.toContain(
      "disabled for shared sessions",
    );
  });
});
