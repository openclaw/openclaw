import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as secretsState from "../secrets/runtime-state.js";
import { createOpenClawCodingToolsAsync } from "./agent-tools.js";
import type { OpenClawCodingToolsOptions } from "./agent-tools.options.js";
import type { WebFetchTransport } from "./tools/web-fetch-transport.js";

afterEach(() => {
  vi.restoreAllMocks();
});

async function assemble(webFetchTransport: WebFetchTransport, config: OpenClawConfig = {}) {
  return createOpenClawCodingToolsAsync({
    config: {
      ...config,
      tools: { ...config.tools, web: { ...config.tools?.web, search: { enabled: false } } },
    },
    disableMessageTool: true,
    wrapBeforeToolCallHook: false,
    webFetchTransport,
    toolConstructionPlan: {
      includeBaseCodingTools: false,
      includeShellTools: false,
      includeChannelTools: false,
      includeOpenClawTools: true,
      includePluginTools: false,
    },
  } satisfies OpenClawCodingToolsOptions);
}

function hostTransport(): WebFetchTransport {
  return {
    assertInvocationCurrent: () => {},
    acquire: vi.fn<WebFetchTransport["acquire"]>(async (request) => ({
      response: new Response('{"source":"host"}', {
        headers: { "content-type": "application/json" },
      }),
      finalUrl: request.url,
      release: async () => {},
    })),
  };
}

describe("web_fetch transport through native coding-tool assembly", () => {
  it("binds one native tool and honors runtime disable/re-enable before cache reuse", async () => {
    const transport = hostTransport();
    const tools = await assemble(transport);
    const fetchTools = tools.filter((tool) => tool.name === "web_fetch");
    expect(fetchTools).toHaveLength(1);
    const tool = fetchTools[0];
    assert(tool);
    const args = { url: "https://example.com/assembled-host" };
    const first = await tool.execute("first", args);
    expect(first.details).toMatchObject({
      extractor: "json",
      externalContent: { untrusted: true, source: "web_fetch", wrapped: true },
      text: expect.stringContaining('"source": "host"'),
    });
    const config: OpenClawConfig = { tools: { web: { fetch: { enabled: false } } } };
    const snapshot = vi
      .spyOn(secretsState, "getActiveSecretsRuntimeConfigSnapshot")
      .mockReturnValue({
        config,
        sourceConfig: config,
        configRefsPrepared: true,
      });
    await expect(tool.execute("disabled", args)).rejects.toThrow("web_fetch is disabled");
    snapshot.mockRestore();
    expect((await tool.execute("enabled", args)).details).toMatchObject({ cached: true });
    expect(transport.acquire).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "disabled", config: { tools: { web: { fetch: { enabled: false } } } } },
    { label: "denied by name", config: { tools: { deny: ["web_fetch"] } } },
    { label: "denied by group", config: { tools: { deny: ["group:web"] } } },
  ])("preserves $label user policy on rebuilt surfaces", async ({ config }) => {
    const transport = hostTransport();
    expect((await assemble(transport)).some((tool) => tool.name === "web_fetch")).toBe(true);
    expect((await assemble(transport, config)).some((tool) => tool.name === "web_fetch")).toBe(
      false,
    );
    expect(transport.acquire).not.toHaveBeenCalled();
  });
});
