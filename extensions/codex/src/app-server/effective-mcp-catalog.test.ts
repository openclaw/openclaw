import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, expect, it, vi } from "vitest";
import { loadCodexEffectiveMcpCatalog } from "./effective-mcp-catalog.js";

const sharedClientMocks = vi.hoisted(() => ({
  retainById: vi.fn(),
}));

vi.mock("./shared-client.js", () => ({
  retainSharedCodexAppServerClientByInstanceId: sharedClientMocks.retainById,
}));

beforeEach(vi.clearAllMocks);

function loadCatalog(
  bindingStore: { readAsync: ReturnType<typeof vi.fn> },
  overrides: Partial<Parameters<typeof loadCodexEffectiveMcpCatalog>[0]> = {},
) {
  return loadCodexEffectiveMcpCatalog(
    {
      config: {},
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      workspaceDir: "/workspace",
      mcpServerNames: [],
      ...overrides,
    },
    { bindingStore: bindingStore as never },
  );
}
const binding = { threadId: "thread-1", clientId: "client-1" };
function bindClient(request: ReturnType<typeof vi.fn>, release = vi.fn()) {
  sharedClientMocks.retainById.mockReturnValueOnce({ client: { request }, release });
  return { readAsync: vi.fn().mockResolvedValue(binding) };
}

const server = (name: string, tools: Record<string, unknown> = {}) => ({ name, tools });
const page = (data: unknown[] = [], nextCursor: string | null = null) => ({ data, nextCursor });

it("reads every page from the exact bound client and thread, then releases the lease", async () => {
  const release = vi.fn();
  const inputSchema = { type: "object" };
  const search = {
    description: "Search docs",
    inputSchema: { ...inputSchema, properties: { query: { type: "string" } } },
  };
  const request = vi
    .fn()
    .mockResolvedValueOnce(page([server("docs!", { search })], "page-2"))
    .mockResolvedValueOnce(
      page([
        server("docs?", { read: { description: "Read docs", inputSchema } }),
        server("__proto__"),
        server("constructor", { inspect: { inputSchema } }),
        server("native-only", { mutate: { inputSchema } }),
      ]),
    );
  const bindingStore = bindClient(request, release);

  const catalog = await loadCatalog(bindingStore, {
    mcpServerNames: ["docs!", "docs?", "__proto__", "constructor"],
    toolOverrides: { mcpToolsDeny: { "docs!": ["delete", "search"] } },
  });

  expect(sharedClientMocks.retainById).toHaveBeenCalledWith("client-1");
  const params = { threadId: "thread-1", detail: "toolsAndAuthOnly", limit: 100 };
  expect(request.mock.calls).toEqual([
    ["mcpServerStatus/list", params],
    ["mcpServerStatus/list", { ...params, cursor: "page-2" }],
  ]);
  expect(catalog?.servers).toMatchObject({
    "docs!": { safeServerName: "docs-", toolCount: 2 },
    "docs?": { safeServerName: "docs--2" },
  });
  expect(Object.hasOwn(catalog?.servers ?? {}, "__proto__")).toBe(true);
  expect(catalog?.servers).not.toHaveProperty("native-only");
  expect(catalog?.tools).toMatchObject([
    { serverName: "constructor", toolName: "inspect" },
    { serverName: "docs?", safeServerName: "docs--2", toolName: "read" },
  ]);
  expect(catalog?.sessionDeniedTools).toMatchObject([
    { serverName: "docs!", toolName: "search", description: "Search docs" },
    { serverName: "docs!", toolName: "delete", deniedBySession: true },
  ]);
  expect(release).toHaveBeenCalledOnce();
});

it.each(["success", "failure"] as const)(
  "retains the bound client until its final catalog page settles with %s",
  async (outcome) => {
    const finalPage = createDeferred<void>();
    const release = vi.fn();
    const request = vi
      .fn()
      .mockResolvedValueOnce(page([], "page-2"))
      .mockImplementationOnce(() => finalPage.promise.then(() => page()));
    const bindingStore = bindClient(request, release);

    const catalog = loadCatalog(bindingStore);

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(release).not.toHaveBeenCalled();

    if (outcome === "success") {
      finalPage.resolve();
      await expect(catalog).resolves.toMatchObject({ tools: [] });
    } else {
      finalPage.reject(new Error("final MCP catalog page failed"));
      await expect(catalog).rejects.toThrow("final MCP catalog page failed");
    }

    expect(release).toHaveBeenCalledOnce();
  },
);

it("does not start a new Codex process when the binding has no live client", async () => {
  const bindingStore = {
    readAsync: vi.fn().mockResolvedValue({ ...binding, clientId: undefined }),
  };

  await expect(loadCatalog(bindingStore)).resolves.toBeUndefined();
  expect(sharedClientMocks.retainById).not.toHaveBeenCalled();
});
