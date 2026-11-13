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
  const { coding, runtimeToolAllowlist, ...decisions } = expected;
  if ("runtimeToolAllowlist" in expected) {
    expect(plan.runtimeToolAllowlist).toEqual(runtimeToolAllowlist);
  }
  expect(plan).toMatchObject({
    ...decisions,
    ...(coding ? { codingToolConstructionPlan: coding } : {}),
  });
}

function filteredNames(
  tools: { name: string }[],
  allow?: string[],
  options?: Parameters<typeof applyEmbeddedAttemptToolsAllow>[2],
) {
  return applyEmbeddedAttemptToolsAllow(tools, allow, options).map((tool) => tool.name);
}

const namedTools = (...names: string[]) => names.map((name) => ({ name }));
const mcp = (toolsAllow?: string[]) =>
  shouldCreateBundleMcpRuntimeForAttempt({ toolsEnabled: true, toolsAllow });
const lsp = (toolsAllow?: string[]) =>
  shouldCreateBundleLspRuntimeForAttempt({ toolsEnabled: true, toolsAllow });

describe("applyEmbeddedAttemptToolsAllow", () => {
  it("materializes host-required collector output through empty runtime allowlists", () => {
    const tools = namedTools("structured_output", "read");
    const toolsAllow = mergeForcedEmbeddedAttemptToolsAllow([], {
      forceToolNames: ["structured_output"],
    });

    expect(toolsAllow).toEqual(["structured_output"]);
    expect(filteredNames(tools, toolsAllow)).toEqual(["structured_output"]);
    expect(resolveEmbeddedAttemptToolConstructionPlan({ toolsAllow })).toMatchObject({
      constructTools: true,
      includeCoreTools: true,
      codingToolConstructionPlan: { includeOpenClawTools: true },
    });
  });

  it("keeps forced tools through preserved hook intersections", () => {
    const tools = namedTools("web_search", "message", "read");
    const toolsAllow = mergeForcedEmbeddedAttemptToolsAllow(
      attachToolAllowlistIntersection([], [["web_*"], ["*_search"]]),
      { forceMessageTool: true },
    );

    expect(filteredNames(tools, toolsAllow)).toEqual(["web_search", "message"]);
  });

  it("honors wildcard and group allowlists in the final filter", () => {
    const tools = namedTools("exec", "read", "message");

    expect(filteredNames(tools, ["*"])).toEqual(["exec", "read", "message"]);
    expect(filteredNames(tools, ["exec*"])).toEqual(["exec"]);
    expect(filteredNames(tools, ["group:fs"])).toEqual(["read"]);
  });

  it("preserves runtime write compatibility in the final filter", () => {
    const tools = namedTools("write", "apply_patch", "exec");

    expect(filteredNames(tools, ["write"])).toEqual(["write", "apply_patch"]);
  });

  it("expands plugin group and plugin-id allowlists before the final filter", () => {
    const tools = namedTools("exec", "memory_search", "memory_get", "browser");
    const toolMeta = (tool: { name: string }) => {
      if (tool.name.startsWith("memory_")) {
        return { pluginId: "active-memory" };
      }
      if (tool.name === "browser") {
        return { pluginId: "browser" };
      }
      return undefined;
    };

    expect(filteredNames(tools, ["group:plugins"], { toolMeta })).toEqual([
      "memory_search",
      "memory_get",
      "browser",
    ]);
    expect(filteredNames(tools, ["active-memory"], { toolMeta })).toEqual([
      "memory_search",
      "memory_get",
    ]);
  });

  it("filters bundled runtime tools by explicit tool name and bundled plugin id", () => {
    // Bundled MCP/LSP tools are plugin-owned tools, so allowlists can target
    // either exact tool names or bundled plugin ids.
    const tools = namedTools(
      "strict__strict_probe",
      "loose__extra_probe",
      "lsp_hover_typescript",
      "lsp_definition_typescript",
    );
    const toolMeta = (tool: { name: string }) => {
      if (tool.name.includes("__")) {
        return { pluginId: "bundle-mcp" };
      }
      if (tool.name.startsWith("lsp_")) {
        return { pluginId: "bundle-lsp" };
      }
      return undefined;
    };

    expect(filteredNames(tools, ["strict__strict_probe"], { toolMeta })).toEqual([
      "strict__strict_probe",
    ]);
    expect(filteredNames(tools, ["lsp_hover_typescript"], { toolMeta })).toEqual([
      "lsp_hover_typescript",
    ]);
    expect(filteredNames(tools, ["bundle-mcp"], { toolMeta })).toEqual([
      "strict__strict_probe",
      "loose__extra_probe",
    ]);
  });

  it("treats an explicit empty toolsAllow as no tools", () => {
    const tools = namedTools("exec", "read", "message");

    expect(filteredNames(tools, [])).toStrictEqual([]);
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
    expect(mcp()).toBe(true);
    expect(mcp(["*"])).toBe(true);
    expect(mcp([])).toBe(false);
    expect(mcp(["memory_search", "memory_get"])).toBe(false);
    expect(mcp(["group:plugins"])).toBe(true);
    expect(mcp(["bundle-mcp"])).toBe(true);
    expect(mcp(["strict__strict_probe"])).toBe(true);
  });
});

describe("shouldCreateBundleLspRuntimeForAttempt", () => {
  it("skips bundle LSP startup when runtime allowlists cannot reach LSP tools", () => {
    expect(lsp()).toBe(true);
    expect(lsp(["*"])).toBe(true);
    expect(lsp([])).toBe(false);
    expect(lsp(["memory_search"])).toBe(false);
    expect(lsp(["lsp_hover_typescript"])).toBe(true);
  });
});
