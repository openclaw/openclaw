import { expect, it, vi } from "vitest";

// Importing optional-feature entrypoints and using an empty session must not need the SDK.
// mock-isolation: optional SDK initialization must fail this import-boundary proof.
vi.mock("@modelcontextprotocol/client", () => {
  throw new Error("MCP client loaded before a server was used");
});
// mock-isolation: optional SDK initialization must fail this import-boundary proof.
vi.mock("@modelcontextprotocol/client/stdio", () => {
  throw new Error("MCP stdio loaded before a server was used");
});
// mock-isolation: optional SDK initialization must fail this import-boundary proof.
vi.mock("@modelcontextprotocol/client/validators/ajv", () => {
  throw new Error("MCP validator loaded before a server was used");
});

it("keeps empty session ownership and registration available without loading the MCP client", async () => {
  const { createSessionMcpRuntime } = await import("./agent-bundle-mcp-runtime.js");
  const { sessionMcpRuntimeOwners } = await import("./agent-bundle-mcp-runtime-owner.js");
  await import("./agent-bundle-mcp-manager-api.js");
  await import("./mcp-client-elicitation.js");
  await import("./mcp-event-request.js");
  await import("./mcp-oauth.js");
  const { createBundleLspToolRuntime } = await import("./agent-bundle-lsp-runtime.js");
  const params = {
    sessionId: "empty-import-boundary",
    workspaceDir: process.cwd(),
    cfg: { plugins: { enabled: false } },
    manifestRegistry: { plugins: [] },
  };
  const runtime = createSessionMcpRuntime(params);
  expect(runtime).not.toBeInstanceOf(Promise);
  const release = runtime.acquireLease!();
  expect(runtime.activeLeases).toBe(1);
  release();
  release();
  expect(runtime.activeLeases).toBe(0);
  expect(await runtime.getCatalog()).toMatchObject({ servers: {}, tools: [] });
  const owner = sessionMcpRuntimeOwners.get(runtime)!;
  expect(owner.hasServers()).toBe(false);
  await owner.reload({
    cfg: params.cfg,
    manifestRegistry: params.manifestRegistry,
    reloadPlugins: true,
  });
  const replacement = owner.replace(params);
  expect(replacement).not.toBeInstanceOf(Promise);
  await runtime.dispose();
  expect(owner.isCurrent()).toBe(false);
  expect(sessionMcpRuntimeOwners.get(replacement)?.isCurrent()).toBe(true);
  expect(await replacement.getCatalog()).toMatchObject({ servers: {}, tools: [] });
  await replacement.dispose();
  await replacement.joinCleanup?.();
  const lsp = await createBundleLspToolRuntime(params);
  expect(lsp.tools).toEqual([]);
  await lsp.dispose();
});
