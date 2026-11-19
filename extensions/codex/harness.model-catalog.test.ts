import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { expect, it, onTestFinished, vi } from "vitest";
import { createCodexAppServerAgentHarness } from "./harness.js";
import type { CodexAppServerBindingStore } from "./src/app-server/session-binding.js";

const catalog = vi.hoisted(() => ({
  create: vi.fn(),
  load: vi.fn(async () => ({ entries: [] })),
  read: vi.fn(),
  dispose: vi.fn(),
}));
const auth = vi.hoisted(() => ({
  started: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
  imported: vi.fn(),
  ensureAuthProfileStoreAsync: vi.fn(),
  resolveAuthProfileOrder: vi.fn(),
}));

// mock-isolation: Hold only the fallback import; the harness owns disposal and auth selection.
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async () => {
  auth.imported();
  auth.started.resolve();
  await auth.release.promise;
  return {
    ensureAuthProfileStoreAsync: auth.ensureAuthProfileStoreAsync,
    resolveAuthProfileOrder: auth.resolveAuthProfileOrder,
  };
});
vi.mock("./src/app-server/model-catalog.js", () => ({
  createCodexAppServerModelCatalog: catalog.create,
}));

it("retains host auth and rejects catalog creation after disposal during fallback auth loading", async () => {
  catalog.create.mockReturnValue(catalog);
  const harnesses: ReturnType<typeof createCodexAppServerAgentHarness>[] = [];
  const pending: {
    catalog?: ReturnType<NonNullable<(typeof harnesses)[number]["loadModelCatalog"]>>;
  } = {};
  onTestFinished(async () => {
    auth.release.resolve();
    await pending.catalog;
    await Promise.all(
      harnesses.map(async (harness) => {
        await harness.dispose?.();
      }),
    );
  });
  const makeHarness = (runtime?: PluginRuntime) => {
    const harness = createCodexAppServerAgentHarness({
      // Catalog discovery has no session binding. Any use would fail this fixture.
      bindingStore: {} as CodexAppServerBindingStore,
      runtime,
    });
    harnesses.push(harness);
    return harness;
  };
  const params = { config: {}, agentId: "main", agentDir: "/agent", workspaceDir: "/workspace" };
  const hostAuth = {
    ensureAuthProfileStoreAsync: vi.fn(),
    resolveAuthProfileOrder: vi.fn(),
  };
  const injected = makeHarness({ modelAuth: hostAuth } as unknown as PluginRuntime);
  await expect(injected.loadModelCatalog!(params)).resolves.toEqual({ entries: [] });
  expect(catalog.create).toHaveBeenCalledExactlyOnceWith("codex", hostAuth);
  expect(auth.imported).not.toHaveBeenCalled();
  await injected.dispose?.();
  catalog.create.mockClear();
  catalog.load.mockClear();

  const retired = makeHarness();
  pending.catalog = retired.loadModelCatalog!(params);
  await auth.started.promise;
  await retired.dispose?.();
  auth.release.resolve();
  await expect(pending.catalog).resolves.toEqual({ entries: [] });
  expect(catalog.create).not.toHaveBeenCalled();
  expect(catalog.load).not.toHaveBeenCalled();

  const current = makeHarness();
  await expect(current.loadModelCatalog!(params)).resolves.toEqual({ entries: [] });
  expect(catalog.create).toHaveBeenCalledExactlyOnceWith("codex", {
    ensureAuthProfileStoreAsync: auth.ensureAuthProfileStoreAsync,
    resolveAuthProfileOrder: auth.resolveAuthProfileOrder,
  });
  expect(catalog.load).toHaveBeenCalledExactlyOnceWith(params, undefined);
});
