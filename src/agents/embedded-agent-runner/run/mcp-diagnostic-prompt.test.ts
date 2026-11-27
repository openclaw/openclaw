import { describe, expect, it } from "vitest";
import type { McpToolCatalogDiagnostic } from "../../agent-bundle-mcp-catalog.types.js";
import { projectRuntimeContextFragments } from "../../internal-runtime-context.js";
import { McpOAuthDiagnosticError } from "../../mcp-oauth-identity.js";
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
    expect(fragments.at(-1)?.text).toMatch(/^\d+ additional unavailable MCP servers omitted\.$/);
    expect(fragments).toEqual(buildMcpDiagnosticPromptFragments(diagnostics.toReversed()));
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

  it.each([
    ["operator", "Sign in from Settings"],
    ["requester", "Reconnect from the channel"],
  ] as const)("retains %s OAuth guidance after a long escaped name", (principal, guidance) => {
    const serverName = "<".repeat(120);
    const error = new McpOAuthDiagnosticError(
      {
        storeKey: "synthetic",
        principal,
        serverName,
        serverUrl: "https://example.test/mcp",
        configured: true,
      },
      "requires OAuth authorization.",
    );
    const fragments = buildMcpDiagnosticPromptFragments([
      { ...diagnostic(serverName, error.message), promptMessage: error.promptMessage },
    ]);
    const legacy = fragments.map((fragment) => fragment.text).join("\n\n");
    expect(error.message).toContain(serverName);
    expect(error.promptMessage).not.toContain(serverName);
    expect(legacy).toContain(`requires OAuth authorization. ${guidance}`);
    if (principal === "operator") {
      expect(legacy).toContain("ask the agent to connect in a direct chat");
    }
    expect(legacy).toContain("openclaw mcp doctor <name>");
    expect(legacy.length).toBeLessThanOrEqual(2_000);
    const escaped = projectRuntimeContextFragments(fragments);
    expect(escaped).toContain(`requires OAuth authorization. ${guidance}`);
    if (principal === "operator") {
      expect(escaped).toContain("ask the agent to connect in a direct chat");
    }
    expect(escaped.length).toBeLessThanOrEqual(2_000);
  });

  it("does not add a fragment for a healthy catalog", () => {
    expect(buildMcpDiagnosticPromptFragments([])).toEqual([]);
  });
});
