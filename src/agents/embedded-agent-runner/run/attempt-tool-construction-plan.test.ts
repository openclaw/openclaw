// Coverage for embedded attempt tool construction and runtime allowlists.
import { describe, expect, it } from "vitest";
import { attachToolAllowlistIntersection } from "../../tool-policy.js";
import {
  applyEmbeddedAttemptToolsAllow,
  mergeForcedEmbeddedAttemptToolsAllow,
  resolveEmbeddedAttemptToolConstructionPlan,
  shouldCreateBundleLspRuntimeForAttempt,
  shouldCreateBundleMcpRuntimeForAttempt,
} from "./attempt-tool-construction-plan.js";

type EmbeddedAttemptToolConstructionPlan = ReturnType<
  typeof resolveEmbeddedAttemptToolConstructionPlan
>;

function expectConstructionPlan(
  plan: EmbeddedAttemptToolConstructionPlan,
  expected: {
    constructTools?: boolean;
    includeCoreTools?: boolean;
    runtimeToolAllowlist?: string[];
    coding?: Partial<EmbeddedAttemptToolConstructionPlan["codingToolConstructionPlan"]>;
  },
) {
  // Plans are intentionally wide; tests assert only the decision bits relevant
  // to the scenario under review.
  if ("constructTools" in expected) {
    expect(plan.constructTools).toBe(expected.constructTools);
  }
  if ("includeCoreTools" in expected) {
    expect(plan.includeCoreTools).toBe(expected.includeCoreTools);
  }
  if ("runtimeToolAllowlist" in expected) {
    expect(plan.runtimeToolAllowlist).toEqual(expected.runtimeToolAllowlist);
  }
  if (expected.coding) {
    for (const [key, value] of Object.entries(expected.coding)) {
      expect(plan.codingToolConstructionPlan[key as keyof typeof expected.coding]).toBe(value);
    }
  }
}

describe("applyEmbeddedAttemptToolsAllow", () => {
  it("materializes host-required collector output through empty runtime allowlists", () => {
    const tools = [{ name: "structured_output" }, { name: "read" }];
    const toolsAllow = mergeForcedEmbeddedAttemptToolsAllow([], {
      forceToolNames: ["structured_output"],
    });

    expect(toolsAllow).toEqual(["structured_output"]);
    expect(applyEmbeddedAttemptToolsAllow(tools, toolsAllow).map((tool) => tool.name)).toEqual([
      "structured_output",
    ]);
    expect(resolveEmbeddedAttemptToolConstructionPlan({ toolsAllow })).toMatchObject({
      constructTools: true,
      includeCoreTools: true,
      codingToolConstructionPlan: { includeOpenClawTools: true },
    });
  });

  it("keeps forced tools through preserved hook intersections", () => {
    const tools = [{ name: "web_search" }, { name: "message" }, { name: "read" }];
    const toolsAllow = mergeForcedEmbeddedAttemptToolsAllow(
      attachToolAllowlistIntersection([], [["web_*"], ["*_search"]]),
      { forceMessageTool: true },
    );

    expect(applyEmbeddedAttemptToolsAllow(tools, toolsAllow).map((tool) => tool.name)).toEqual([
      "web_search",
      "message",
    ]);
  });

  it("honors wildcard and group allowlists in the final filter", () => {
    const tools = [{ name: "exec" }, { name: "read" }, { name: "message" }];

    expect(applyEmbeddedAttemptToolsAllow(tools, ["*"]).map((tool) => tool.name)).toEqual([
      "exec",
      "read",
      "message",
    ]);
    expect(applyEmbeddedAttemptToolsAllow(tools, ["exec*"]).map((tool) => tool.name)).toEqual([
      "exec",
    ]);
    expect(applyEmbeddedAttemptToolsAllow(tools, ["group:fs"]).map((tool) => tool.name)).toEqual([
      "read",
    ]);
  });

  it("preserves runtime write compatibility in the final filter", () => {
    const tools = [{ name: "write" }, { name: "apply_patch" }, { name: "exec" }];

    expect(applyEmbeddedAttemptToolsAllow(tools, ["write"]).map((tool) => tool.name)).toEqual([
      "write",
      "apply_patch",
    ]);
  });

  it("expands plugin group and plugin-id allowlists before the final filter", () => {
    const tools = [
      { name: "exec" },
      { name: "memory_search" },
      { name: "memory_get" },
      { name: "browser" },
    ];
    const toolMeta = (tool: { name: string }) => {
      if (tool.name.startsWith("memory_")) {
        return { pluginId: "active-memory" };
      }
      if (tool.name === "browser") {
        return { pluginId: "browser" };
      }
      return undefined;
    };

    expect(
      applyEmbeddedAttemptToolsAllow(tools, ["group:plugins"], { toolMeta }).map(
        (tool) => tool.name,
      ),
    ).toEqual(["memory_search", "memory_get", "browser"]);
    expect(
      applyEmbeddedAttemptToolsAllow(tools, ["active-memory"], { toolMeta }).map(
        (tool) => tool.name,
      ),
    ).toEqual(["memory_search", "memory_get"]);
  });

  it("filters bundled runtime tools by explicit tool name and bundled plugin id", () => {
    // Bundled MCP/LSP tools are plugin-owned tools, so allowlists can target
    // either exact tool names or bundled plugin ids.
    const tools = [
      { name: "strict__strict_probe" },
      { name: "loose__extra_probe" },
      { name: "lsp_hover_typescript" },
      { name: "lsp_definition_typescript" },
    ];
    const toolMeta = (tool: { name: string }) => {
      if (tool.name.includes("__")) {
        return { pluginId: "bundle-mcp" };
      }
      if (tool.name.startsWith("lsp_")) {
        return { pluginId: "bundle-lsp" };
      }
      return undefined;
    };

    expect(
      applyEmbeddedAttemptToolsAllow(tools, ["strict__strict_probe"], { toolMeta }).map(
        (tool) => tool.name,
      ),
    ).toEqual(["strict__strict_probe"]);
    expect(
      applyEmbeddedAttemptToolsAllow(tools, ["lsp_hover_typescript"], { toolMeta }).map(
        (tool) => tool.name,
      ),
    ).toEqual(["lsp_hover_typescript"]);
    expect(
      applyEmbeddedAttemptToolsAllow(tools, ["bundle-mcp"], { toolMeta }).map((tool) => tool.name),
    ).toEqual(["strict__strict_probe", "loose__extra_probe"]);
  });

  it("treats an explicit empty toolsAllow as no tools", () => {
    const tools = [{ name: "exec" }, { name: "read" }, { name: "message" }];

    expect(applyEmbeddedAttemptToolsAllow(tools, []).map((tool) => tool.name)).toStrictEqual([]);
    expect(resolveEmbeddedAttemptToolConstructionPlan({ toolsAllow: [] })).toHaveProperty(
      "includeCoreTools",
      false,
    );
  });
});

describe("resolveEmbeddedAttemptToolConstructionPlan", () => {
  it("builds all tool families when no runtime allowlist is present", () => {
    expectConstructionPlan(resolveEmbeddedAttemptToolConstructionPlan({}), {
      constructTools: true,
      includeCoreTools: true,
      coding: {
        includeBaseCodingTools: true,
        includeShellTools: true,
        includeChannelTools: true,
        includeOpenClawTools: true,
        includePluginTools: true,
      },
    });
  });

  it("short-circuits tool construction when the model disables tools", () => {
    expectConstructionPlan(
      resolveEmbeddedAttemptToolConstructionPlan({
        toolsEnabled: false,
        toolsAllow: ["message"],
        forceMessageTool: true,
      }),
      {
        constructTools: false,
        includeCoreTools: false,
        runtimeToolAllowlist: undefined,
        coding: {
          includeBaseCodingTools: false,
          includeShellTools: false,
          includeChannelTools: false,
          includeOpenClawTools: false,
          includePluginTools: false,
        },
      },
    );
  });

  it("materializes OpenClaw tools when a plugin-only allowlist forces message", () => {
    expectConstructionPlan(
      resolveEmbeddedAttemptToolConstructionPlan({
        toolsAllow: ["memory_search"],
        forceMessageTool: true,
      }),
      {
        constructTools: true,
        includeCoreTools: true,
        runtimeToolAllowlist: ["memory_search", "message"],
        coding: {
          includeBaseCodingTools: false,
          includeShellTools: false,
          includeChannelTools: true,
          includeOpenClawTools: true,
          includePluginTools: true,
        },
      },
    );
  });

  it("honors runtime-cap intersections when selecting core families", () => {
    expectConstructionPlan(resolveEmbeddedAttemptToolConstructionPlan({ toolsAllow: ["write"] }), {
      includeCoreTools: true,
      coding: {
        includeBaseCodingTools: true,
        includeShellTools: false,
        includeOpenClawTools: false,
      },
    });

    const narrowedWildcard = attachToolAllowlistIntersection(["*", "write"], [["*"], ["write"]]);
    expectConstructionPlan(
      resolveEmbeddedAttemptToolConstructionPlan({ toolsAllow: narrowedWildcard }),
      {
        includeCoreTools: true,
        coding: {
          includeBaseCodingTools: true,
          includeShellTools: false,
          includeOpenClawTools: false,
        },
      },
    );

    const overlappingGlobs = attachToolAllowlistIntersection([], [["exec*"], ["*xec"]]);
    expectConstructionPlan(
      resolveEmbeddedAttemptToolConstructionPlan({ toolsAllow: overlappingGlobs }),
      {
        includeCoreTools: true,
        coding: {
          includeBaseCodingTools: false,
          includeShellTools: true,
          includeOpenClawTools: false,
        },
      },
    );
  });
});

describe("shouldCreateBundleMcpRuntimeForAttempt", () => {
  it("does not treat a generated bash namespace as the core exec alias", () => {
    expect(
      shouldCreateBundleMcpRuntimeForAttempt({
        toolsEnabled: true,
        toolsAllow: ["exec*"],
        resolveConfiguredMcpNamespaces: () => ["bash__"],
      }),
    ).toBe(false);
  });

  it("skips bundle MCP runtime when tools are disabled", () => {
    expect(shouldCreateBundleMcpRuntimeForAttempt({ toolsEnabled: false })).toBe(false);
    expect(shouldCreateBundleMcpRuntimeForAttempt({ toolsEnabled: true, disableTools: true })).toBe(
      false,
    );
  });

  it("creates bundle MCP only when the allowlist can reach bundle MCP tool names", () => {
    expect(shouldCreateBundleMcpRuntimeForAttempt({ toolsEnabled: true })).toBe(true);
    expect(shouldCreateBundleMcpRuntimeForAttempt({ toolsEnabled: true, toolsAllow: ["*"] })).toBe(
      true,
    );
    expect(shouldCreateBundleMcpRuntimeForAttempt({ toolsEnabled: true, toolsAllow: [] })).toBe(
      false,
    );
    expect(
      shouldCreateBundleMcpRuntimeForAttempt({
        toolsEnabled: true,
        toolsAllow: ["memory_search", "memory_get"],
      }),
    ).toBe(false);
    expect(
      shouldCreateBundleMcpRuntimeForAttempt({
        toolsEnabled: true,
        toolsAllow: ["group:plugins"],
      }),
    ).toBe(true);
    expect(
      shouldCreateBundleMcpRuntimeForAttempt({
        toolsEnabled: true,
        toolsAllow: ["bundle-mcp"],
      }),
    ).toBe(true);
    expect(
      shouldCreateBundleMcpRuntimeForAttempt({
        toolsEnabled: true,
        toolsAllow: ["strict__strict_probe"],
      }),
    ).toBe(true);
  });
});

describe("shouldCreateBundleLspRuntimeForAttempt", () => {
  it("skips bundle LSP startup when runtime allowlists cannot reach LSP tools", () => {
    expect(shouldCreateBundleLspRuntimeForAttempt({ toolsEnabled: true })).toBe(true);
    expect(shouldCreateBundleLspRuntimeForAttempt({ toolsEnabled: true, toolsAllow: ["*"] })).toBe(
      true,
    );
    expect(shouldCreateBundleLspRuntimeForAttempt({ toolsEnabled: true, toolsAllow: [] })).toBe(
      false,
    );
    expect(
      shouldCreateBundleLspRuntimeForAttempt({
        toolsEnabled: true,
        toolsAllow: ["memory_search"],
      }),
    ).toBe(false);
    expect(
      shouldCreateBundleLspRuntimeForAttempt({
        toolsEnabled: true,
        toolsAllow: ["lsp_hover_typescript"],
      }),
    ).toBe(true);
  });
});
