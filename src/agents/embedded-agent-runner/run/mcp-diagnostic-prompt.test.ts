import { describe, expect, it } from "vitest";
import type { McpToolCatalogDiagnostic } from "../../agent-bundle-mcp-catalog.types.js";
import { projectRuntimeContextFragments } from "../../internal-runtime-context.js";
import { buildMcpDiagnosticPromptFragments } from "./mcp-diagnostic-prompt.js";

function diagnostic(serverName: string, message = "listing failed"): McpToolCatalogDiagnostic {
  return { serverName, safeServerName: serverName, launchSummary: "synthetic", message };
}

describe("MCP diagnostic prompt projection", () => {
  it("sorts notices and bounds the actual legacy and escaped renderings with an omission count", () => {
    const diagnostics = Array.from({ length: 25 }, (_, index) =>
      diagnostic(
        `server-${String(24 - index).padStart(2, "0")}`,
        `failed <retry> ${'\\"'.repeat(300)}`,
      ),
    );
    const fragments = buildMcpDiagnosticPromptFragments(diagnostics);
    const legacy = fragments.map((fragment) => fragment.text).join("\n\n");
    const escaped = projectRuntimeContextFragments(fragments);
    expect(legacy.length).toBeLessThanOrEqual(2_000);
    expect(escaped.length).toBeLessThanOrEqual(2_000);
    expect(legacy).toContain("MCP server server-00 unavailable");
    expect(legacy).toMatch(/\d+ additional unavailable MCP servers omitted/);
    expect(fragments.at(-1)?.text).toMatch(/^\d+ additional unavailable MCP servers omitted\.$/);
    expect(fragments).toEqual(buildMcpDiagnosticPromptFragments([...diagnostics].reverse()));
    expect(escaped).not.toContain("<retry>");
  });

  it("keeps OAuth sign-in guidance and does not suggest a timer or reachability retry", () => {
    const fragments = buildMcpDiagnosticPromptFragments([
      diagnostic("remote", "Sign in from Settings to authorize this server"),
    ]);
    const rendered = projectRuntimeContextFragments(fragments);
    expect(rendered).toContain("Sign in from Settings");
    expect(rendered).toContain("openclaw mcp status --verbose");
    expect(rendered).toContain("for shared OAuth credentials use openclaw mcp doctor");
    expect(rendered).not.toContain("reachability");
    expect(rendered).not.toContain("later turn");
  });

  it("keeps the operator next step when one diagnostic fills its data allowance", () => {
    const fragments = buildMcpDiagnosticPromptFragments([
      diagnostic("remote", "listing failed: " + "x".repeat(5_000)),
    ]);
    const legacy = fragments.map((fragment) => fragment.text).join("\n\n");
    const escaped = projectRuntimeContextFragments(fragments);
    expect(legacy).toContain("openclaw mcp status --verbose");
    expect(legacy).toContain("openclaw mcp probe <name>");
    expect(legacy).toContain("MCP server remote unavailable");
    expect(legacy.length).toBeLessThanOrEqual(2_000);
    expect(escaped.length).toBeLessThanOrEqual(2_000);
  });

  it("reserves room for sign-in guidance after a long escaped server name", () => {
    const fragments = buildMcpDiagnosticPromptFragments([
      diagnostic("<".repeat(2_000), "Sign in from Settings to authorize this server"),
    ]);
    const legacy = fragments.map((fragment) => fragment.text).join("\n\n");
    expect(legacy).toContain("Sign in from Settings");
    expect(legacy).toContain("openclaw mcp doctor <name>");
    expect(legacy.length).toBeLessThanOrEqual(2_000);
    expect(projectRuntimeContextFragments(fragments).length).toBeLessThanOrEqual(2_000);
  });

  it("does not add a fragment for a healthy catalog", () => {
    expect(buildMcpDiagnosticPromptFragments([])).toEqual([]);
  });
});
