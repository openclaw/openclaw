import { setImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createCombinedSessionMcpRuntime } from "./agent-bundle-mcp-combined.js";
import type {
  McpCatalogTool,
  McpToolCatalog,
  SessionMcpRuntime,
} from "./agent-bundle-mcp-types.js";

function catalog(serverName: string, toolName: string): McpToolCatalog {
  const tool: McpCatalogTool = {
    serverName,
    safeServerName: serverName,
    toolName,
    description: toolName,
    inputSchema: { type: "object" },
    fallbackDescription: toolName,
  };
  return {
    version: 1,
    generatedAt: 0,
    servers: {
      [serverName]: { serverName, launchSummary: serverName, toolCount: 1 },
    },
    tools: [tool],
  };
}

function runtimePart(params: {
  sessionId: string;
  getCatalog: () => Promise<McpToolCatalog>;
  peekCatalog: () => McpToolCatalog | null;
}): SessionMcpRuntime {
  const createdAt = 0;
  return {
    sessionId: params.sessionId,
    workspaceDir: "/workspace",
    configFingerprint: "fingerprint",
    createdAt,
    lastUsedAt: createdAt,
    markUsed: () => {},
    peekCatalog: params.peekCatalog,
    getCatalog: params.getCatalog,
    callTool: async () => ({ content: [] }),
    dispose: async () => {},
    joinCleanup: async () => {},
  };
}

function createCombined(parts: SessionMcpRuntime[]): SessionMcpRuntime {
  return createCombinedSessionMcpRuntime({
    sessionId: "combined-catalog-invalidation",
    workspaceDir: "/workspace",
    parts,
  });
}

function toolNames(value: McpToolCatalog): string[] {
  return value.tools.map((tool) => `${tool.serverName}:${tool.toolName}`);
}

describe("combined MCP catalog invalidation", () => {
  it("replays a part invalidated while a sibling discovery is in flight", async () => {
    const alphaOld = catalog("alpha", "old_tool");
    const alphaNew = catalog("alpha", "new_tool");
    const betaCatalog = catalog("beta", "beta_tool");
    const alphaDiscovered = createDeferred();
    const betaRelease = createDeferred();
    let alphaCatalog: McpToolCatalog | null = alphaOld;
    let betaCatalogValue: McpToolCatalog | null = null;
    let alphaCalls = 0;
    const alpha = runtimePart({
      sessionId: "alpha",
      getCatalog: async () => {
        alphaCalls += 1;
        const next = alphaCalls === 1 ? alphaOld : alphaNew;
        alphaCatalog = next;
        if (alphaCalls === 1) {
          alphaDiscovered.resolve();
        }
        return next;
      },
      peekCatalog: () => alphaCatalog,
    });
    const beta = runtimePart({
      sessionId: "beta",
      getCatalog: async () => {
        await betaRelease.promise;
        betaCatalogValue = betaCatalog;
        return betaCatalog;
      },
      peekCatalog: () => betaCatalogValue,
    });
    const combined = createCombined([alpha, beta]);
    const pending = combined.getCatalog();
    await alphaDiscovered.promise;
    // Let the completed alpha task record its result before its sibling still awaits I/O.
    await setImmediate();
    alphaCatalog = null;
    betaRelease.resolve();

    const merged = await pending;

    expect(alphaCalls).toBe(2);
    expect(toolNames(merged)).toEqual(["alpha:new_tool", "beta:beta_tool"]);
    const peeked = expectDefined(combined.peekCatalog(), "combined catalog after invalidation");
    expect(toolNames(peeked)).toEqual(["alpha:new_tool", "beta:beta_tool"]);
  });

  it("does not replay parts when no invalidation lands", async () => {
    const alphaCatalog = catalog("alpha", "alpha_tool");
    const betaCatalog = catalog("beta", "beta_tool");
    const alphaDiscovered = createDeferred();
    const betaRelease = createDeferred();
    let alphaCalls = 0;
    let betaCalls = 0;
    let alphaCurrent: McpToolCatalog | null = null;
    let betaCurrent: McpToolCatalog | null = null;
    const alpha = runtimePart({
      sessionId: "alpha",
      getCatalog: async () => {
        alphaCalls += 1;
        alphaCurrent = alphaCatalog;
        alphaDiscovered.resolve();
        return alphaCatalog;
      },
      peekCatalog: () => alphaCurrent,
    });
    const beta = runtimePart({
      sessionId: "beta",
      getCatalog: async () => {
        betaCalls += 1;
        await betaRelease.promise;
        betaCurrent = betaCatalog;
        return betaCatalog;
      },
      peekCatalog: () => betaCurrent,
    });
    const combined = createCombined([alpha, beta]);
    const pending = combined.getCatalog();
    await alphaDiscovered.promise;
    betaRelease.resolve();

    const merged = await pending;
    const cached = await combined.getCatalog();

    expect(alphaCalls).toBe(1);
    expect(betaCalls).toBe(1);
    expect(toolNames(merged)).toEqual(["alpha:alpha_tool", "beta:beta_tool"]);
    expect(toolNames(cached)).toEqual(["alpha:alpha_tool", "beta:beta_tool"]);
    expect(alphaCalls).toBe(1);
    expect(betaCalls).toBe(1);
  });

  it("bounds replay to one pass when invalidation repeats", async () => {
    const alphaV1 = catalog("alpha", "v1_tool");
    const alphaV2 = catalog("alpha", "v2_tool");
    const alphaV3 = catalog("alpha", "v3_tool");
    const betaCatalog = catalog("beta", "beta_tool");
    const alphaDiscovered = createDeferred();
    const betaRelease = createDeferred();
    let alphaCatalog: McpToolCatalog | null = alphaV1;
    let betaCatalogValue: McpToolCatalog | null = null;
    let alphaCalls = 0;
    const alpha = runtimePart({
      sessionId: "alpha",
      getCatalog: async () => {
        alphaCalls += 1;
        const next = alphaCalls === 1 ? alphaV1 : alphaCalls === 2 ? alphaV2 : alphaV3;
        alphaCatalog = next;
        if (alphaCalls === 1) {
          alphaDiscovered.resolve();
        }
        if (alphaCalls === 2) {
          // A second invalidation lands while the replay discovery is in flight.
          alphaCatalog = null;
        }
        return next;
      },
      peekCatalog: () => alphaCatalog,
    });
    const beta = runtimePart({
      sessionId: "beta",
      getCatalog: async () => {
        await betaRelease.promise;
        betaCatalogValue = betaCatalog;
        return betaCatalog;
      },
      peekCatalog: () => betaCatalogValue,
    });
    const combined = createCombined([alpha, beta]);
    const pending = combined.getCatalog();
    await alphaDiscovered.promise;
    await setImmediate();
    alphaCatalog = null;
    betaRelease.resolve();

    const merged = await pending;

    expect(alphaCalls).toBe(2);
    expect(toolNames(merged)).toEqual(["alpha:v2_tool", "beta:beta_tool"]);
    expect(combined.peekCatalog()).toBeNull();

    const refreshed = await combined.getCatalog();
    expect(alphaCalls).toBe(3);
    expect(toolNames(refreshed)).toEqual(["alpha:v3_tool", "beta:beta_tool"]);
  });
});
