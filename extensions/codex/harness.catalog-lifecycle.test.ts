import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { createCodexAppServerAgentHarness } from "./harness.js";
import plugin from "./index.js";
import * as modelCatalogModule from "./src/app-server/model-catalog.js";
import { createCodexTestBindingStore } from "./src/app-server/session-binding.test-helpers.js";
import { codexBuildSymbol } from "./src/build-state.js";

describe("Codex model catalog registration lifetime", () => {
  it.each(["loaded", "importing"])(
    "disposes its %s model catalog through registration cleanup",
    async (phase) => {
      const closing = createDeferred<void>();
      const owner = {
        load: vi.fn(async () => []),
        read: vi.fn(),
        dispose: vi.fn(() => closing.promise),
      };
      const factory = vi
        .spyOn(modelCatalogModule, "createCodexAppServerModelCatalog")
        .mockReturnValue(owner);
      const registerAgentHarness = vi.fn<OpenClawPluginApi["registerAgentHarness"]>();
      const disposers: Array<() => void | Promise<void>> = [];
      const api = createTestPluginApi({
        id: "codex",
        runtime: createPluginRuntimeMock(),
        registerAgentHarness,
      });
      api.lifecycle.onDispose = (cleanup) => {
        disposers.push(cleanup);
        return () => {};
      };
      try {
        plugin.register(api);
        const harness = registerAgentHarness.mock.calls[0]![0];
        const params = {
          config: {},
          agentId: "main",
          agentDir: "/synthetic/agent",
          workspaceDir: "/synthetic/workspace",
        };
        const loading = harness.loadModelCatalog!(params);
        if (phase === "loaded") {
          await loading;
        }
        let settled = false;
        const disposing = Promise.all(disposers.map((dispose) => Promise.resolve(dispose()))).then(
          () => {
            settled = true;
          },
        );
        await Promise.resolve();
        if (phase === "loaded") {
          expect(settled).toBe(false);
          expect(owner.dispose).toHaveBeenCalledOnce();
        }
        closing.resolve();
        await disposing;
        await loading;
        expect(await harness.loadModelCatalog!(params)).toEqual({ entries: [] });
        expect(factory).toHaveBeenCalledTimes(phase === "loaded" ? 1 : 0);
      } finally {
        closing.resolve();
        factory.mockRestore();
      }
    },
  );

  it.each(["catalog", "shared", "both"])(
    "preserves %s cleanup failures while draining both owners",
    async (failing) => {
      const catalogFailure = new Error("synthetic catalog close failure");
      const sharedFailure = new Error("synthetic shared close failure");
      const disposeCatalog = vi.fn(async () => {
        if (failing !== "shared") {
          throw catalogFailure;
        }
      });
      const factory = vi
        .spyOn(modelCatalogModule, "createCodexAppServerModelCatalog")
        .mockReturnValue({
          load: async () => [],
          read: () => undefined,
          dispose: disposeCatalog,
        });
      const slot = codexBuildSymbol("openclaw.codexAppServerClientDisposer");
      const globals = globalThis as Record<symbol, unknown>;
      const previous = globals[slot];
      const disposeShared = vi.fn(async () => {
        if (failing !== "catalog") {
          throw sharedFailure;
        }
      });
      globals[slot] = disposeShared;
      try {
        const harness = createCodexAppServerAgentHarness({
          bindingStore: createCodexTestBindingStore(),
        });
        await harness.loadModelCatalog!({
          config: {},
          agentId: "main",
          agentDir: "/synthetic/agent",
          workspaceDir: "/synthetic/workspace",
        });
        const disposal = harness.dispose!();
        if (failing === "both") {
          await expect(disposal).rejects.toMatchObject({
            name: "AggregateError",
            errors: [catalogFailure, sharedFailure],
          });
        } else {
          await expect(disposal).rejects.toBe(
            failing === "catalog" ? catalogFailure : sharedFailure,
          );
        }
        expect(disposeCatalog).toHaveBeenCalledOnce();
        expect(disposeShared).toHaveBeenCalledOnce();
      } finally {
        globals[slot] = previous;
        factory.mockRestore();
      }
    },
  );
});
