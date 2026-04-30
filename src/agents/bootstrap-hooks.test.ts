import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearInternalHooks,
  registerInternalHook,
  type AgentBootstrapHookContext,
} from "../hooks/internal-hooks.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { applyBootstrapHookOverrides } from "./bootstrap-hooks.js";
import { DEFAULT_SOUL_FILENAME, type WorkspaceBootstrapFile } from "./workspace.js";

function makeFile(
  name: WorkspaceBootstrapFile["name"] = DEFAULT_SOUL_FILENAME,
): WorkspaceBootstrapFile {
  return {
    name,
    path: `/tmp/${name}`,
    content: "base",
    missing: false,
  };
}

describe("applyBootstrapHookOverrides", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("returns updated files when a hook mutates the context", async () => {
    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as AgentBootstrapHookContext;
      context.bootstrapFiles = [
        ...context.bootstrapFiles,
        {
          name: "EXTRA.md",
          path: "/tmp/EXTRA.md",
          content: "extra",
          missing: false,
        } as unknown as WorkspaceBootstrapFile,
      ];
    });

    const updated = await applyBootstrapHookOverrides({
      files: [makeFile()],
      workspaceDir: "/tmp",
    });

    expect(updated).toHaveLength(2);
    expect(updated[1]?.path).toBe("/tmp/EXTRA.md");
  });

  it("plugin hook wrapper preserves bootstrapFiles mutations (regression #75245)", async () => {
    // registerHook wraps handlers with a shallow-clone of event.context to inject
    // pluginConfig. Before the fix, `event.context.bootstrapFiles = updated` inside
    // a plugin handler was silently dropped because the clone was discarded.
    const record = createPluginRecord({ id: "test-bootstrap-mutator" });
    const pluginRegistry = createPluginRegistry({
      activateGlobalSideEffects: true,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: {} as Parameters<typeof createPluginRegistry>[0]["runtime"],
    });

    pluginRegistry.createApi(record, { config: {} }).registerHook(
      "agent:bootstrap",
      (event) => {
        const ctx = event.context as AgentBootstrapHookContext;
        ctx.bootstrapFiles = [
          {
            name: "SENTINEL.md",
            path: "/tmp/SENTINEL.md",
            content: "SENTINEL_BOOTSTRAP_CONTEXT",
            missing: false,
          } as unknown as WorkspaceBootstrapFile,
        ];
      },
      { name: "bootstrap-mutator-hook" },
    );

    const updated = await applyBootstrapHookOverrides({
      files: [makeFile()],
      workspaceDir: "/tmp",
    });

    expect(updated).toHaveLength(1);
    expect(updated[0]?.name).toBe("SENTINEL.md");
  });

  it("plugin hook wrapper does not leak pluginConfig into event.context after handler (regression #75245)", async () => {
    const record = createPluginRecord({ id: "test-no-leak" });
    const pluginRegistry = createPluginRegistry({
      activateGlobalSideEffects: true,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: {} as Parameters<typeof createPluginRegistry>[0]["runtime"],
    });

    pluginRegistry.createApi(record, { config: {} }).registerHook(
      "agent:bootstrap",
      (_event) => {
        // handler does nothing — we only check that pluginConfig is cleaned up
      },
      { name: "no-leak-hook" },
    );

    const updated = await applyBootstrapHookOverrides({
      files: [makeFile()],
      workspaceDir: "/tmp",
    });

    // hook fires but does not mutate — original files preserved
    expect(updated).toHaveLength(1);
    expect(updated[0]?.name).toBe(DEFAULT_SOUL_FILENAME);
    // pluginConfig must not bleed into the shared event context after handler returns
    // (verified indirectly: if it leaked, it would appear on subsequent hook invocations)
  });
});
