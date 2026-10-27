import { expect, it, vi } from "vitest";

const observed = vi.hoisted(() => ({
  catalogImported: false,
  createCatalog: vi.fn(),
  startClient: vi.fn(() => {
    throw new Error("Harness import started a native catalog client");
  }),
  request: vi.fn(() => {
    throw new Error("Harness import sent a catalog RPC");
  }),
  process: vi.fn(() => {
    throw new Error("Harness import launched a process");
  }),
}));

vi.mock("openclaw/plugin-sdk/agent-runtime", () => {
  throw new Error("Harness import loaded host credential runtime");
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: observed.process,
    spawnSync: observed.process,
    exec: observed.process,
    execSync: observed.process,
    execFile: observed.process,
    execFileSync: observed.process,
    fork: observed.process,
  };
});

vi.mock("./src/app-server/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./src/app-server/client.js")>();
  vi.spyOn(actual.CodexAppServerClient, "start").mockImplementation(observed.startClient);
  vi.spyOn(actual.CodexAppServerClient.prototype, "request").mockImplementation(observed.request);
  return actual;
});

vi.mock("./src/app-server/model-catalog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./src/app-server/model-catalog.js")>();
  observed.catalogImported = true;
  observed.createCatalog.mockImplementation(actual.createCodexAppServerModelCatalog);
  return { ...actual, createCodexAppServerModelCatalog: observed.createCatalog };
});

it("prepares catalog code on harness import without starting discovery", async () => {
  const { createCodexAppServerAgentHarness } = await import("./harness.js");
  expect(observed.catalogImported).toBe(true);
  const { createCodexTestBindingStore } =
    await import("./src/app-server/session-binding.test-helpers.js");
  const harness = createCodexAppServerAgentHarness({ bindingStore: createCodexTestBindingStore() });
  try {
    expect(harness.loadModelCatalog).toBeTypeOf("function");
    expect(
      harness.readModelCatalogReadiness?.({
        config: {},
        agentId: "synthetic-agent",
        agentDir: "/synthetic/agent",
        workspaceDir: "/synthetic/workspace",
        provider: "openai",
        modelId: "synthetic-model",
      }),
    ).toBeUndefined();
  } finally {
    await harness.dispose?.();
  }
  expect(observed.createCatalog).not.toHaveBeenCalled();
  expect(observed.startClient).not.toHaveBeenCalled();
  expect(observed.request).not.toHaveBeenCalled();
  expect(observed.process).not.toHaveBeenCalled();
});
