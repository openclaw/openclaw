import type {
  OpenClawPluginNodeHostCommand,
  ProviderPlugin,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi, type TestPluginApiInput } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import type { SessionCatalogProvider } from "openclaw/plugin-sdk/session-catalog";
import { afterEach, expect, it, vi } from "vitest";

async function register(overrides: TestPluginApiInput) {
  const { default: plugin } = await import("./index.js");
  plugin.register(
    createTestPluginApi({
      id: "anthropic",
      name: "Anthropic",
      source: "test",
      config: {},
      runtime: createPluginRuntimeMock(),
      ...overrides,
    }),
  );
}

function failImport(message: string) {
  return () => {
    throw new Error(message);
  };
}

afterEach(() => {
  vi.doUnmock("./session-catalog.js");
  vi.doUnmock("./session-catalog-node-commands.js");
  vi.doUnmock("openclaw/plugin-sdk/provider-auth");
  vi.doUnmock("openclaw/plugin-sdk/provider-stream-shared");
  vi.doUnmock("./stream-wrappers.js");
  vi.doUnmock("./live-model-projection.js");
  vi.resetModules();
});

it("loads catalog and node handlers only on first use", async () => {
  let catalogImports = 0;
  let nodeCommandImports = 0;
  // mock-isolation: count lazy catalog evaluation without loading the real session store.
  vi.doMock("./session-catalog.js", () => {
    catalogImports += 1;
    return { createClaudeSessionCatalogRuntime: () => ({ list: async () => [] }) };
  });
  // mock-isolation: count lazy command evaluation without loading native session handlers.
  vi.doMock("./session-catalog-node-commands.js", () => {
    nodeCommandImports += 1;
    return { listClaudeSessions: async () => "[]" };
  });

  const catalogs: SessionCatalogProvider[] = [];
  const nodeCommands: OpenClawPluginNodeHostCommand[] = [];
  let nodePolicies = 0;
  await register({
    registerSessionCatalog: (provider) => catalogs.push(provider),
    registerNodeHostCommand: (command) => nodeCommands.push(command),
    registerNodeInvokePolicy: () => nodePolicies++,
  });

  expect([catalogImports, nodeCommandImports]).toEqual([0, 0]);
  expect([catalogs.length, nodeCommands.length, nodePolicies]).toEqual([1, 4, 1]);

  await expect(catalogs[0]?.list({ agentId: "main" })).resolves.toEqual([]);
  await expect(catalogs[0]?.list({ agentId: "main" })).resolves.toEqual([]);
  await expect(nodeCommands[0]?.handle()).resolves.toBe("[]");
  await expect(nodeCommands[0]?.handle()).resolves.toBe("[]");
  expect([catalogImports, nodeCommandImports]).toEqual([1, 1]);
});

it("registers callable provider hooks before loading execution runtimes", async () => {
  // mock-isolation: loading any execution module during registration must fail.
  vi.doMock("openclaw/plugin-sdk/provider-auth", failImport("auth execution loaded"));
  // mock-isolation: importing the real stream transport would bypass the eager-load tripwire.
  vi.doMock("openclaw/plugin-sdk/provider-stream-shared", failImport("stream transport loaded"));
  // mock-isolation: importing real stream wrappers would bypass the eager-load tripwire.
  vi.doMock("./stream-wrappers.js", failImport("stream execution loaded"));
  // mock-isolation: importing the real catalog would bypass the eager-load tripwire.
  vi.doMock("./live-model-projection.js", failImport("live catalog loaded"));
  const providers: ProviderPlugin[] = [];
  await register({
    registerProvider: (provider) => providers.push(provider),
  });
  const provider = providers[0]!;
  expect(provider.auth.map(({ id }) => id)).toEqual(["cli", "setup-token", "api-key"]);
  for (const hook of [provider.wrapStreamFn, provider.wrapSimpleCompletionStreamFn]) {
    expect(hook?.({ provider: "anthropic", modelId: "synthetic-model" })).toEqual(
      expect.any(Function),
    );
  }
  const failure = { provider: "anthropic", errorMessage: "", code: "API_ERROR" };
  expect(provider.classifyFailoverReason?.(failure)).toBe("server_error");
  const auth = { provider: "anthropic", store: { version: 1, profiles: {} } };
  await expect(provider.buildAuthDoctorHint!(auth)).rejects.toMatchObject({
    cause: { message: "auth execution loaded" },
  });
});
