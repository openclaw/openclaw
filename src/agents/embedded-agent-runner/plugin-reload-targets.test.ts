import assert from "node:assert/strict";
import { afterEach, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshot } from "../../config/plugin-auto-enable.test-helpers.js";
import { PluginInstance } from "../../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { testing as replyTesting } from "../../sessions/session-controller.test-support.js";
import {
  registerPluginReloadRunOwner,
  capturePluginReloadRunTargets,
} from "../plugin-reload-runs.js";
import {
  isAgentRunPluginReloadAbortReason,
  isAgentRunRestartAbortReason,
} from "../run-termination.js";
import { createEmbeddedRunHandle, registerTestEmbeddedRun, testing } from "./runs.test-support.js";

afterEach(() => {
  testing.resetActiveEmbeddedRuns();
  replyTesting.resetSessionControllerForTest();
});

it("captures only physical generation owners and never interrupts an abort listener's successor", () => {
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({ id: "reloadable", name: "reloadable" });
  registry.plugins.push(record);
  const instance = new PluginInstance(record.id, { record, registry });
  const generation = {
    remoteCatalog: null,
    inlineProviderModels: [],
    configuredCatalogEntries: [],
    pluginMetadataSnapshot: createPluginMetadataSnapshot({
      config: {},
      manifestRegistry: { plugins: [], diagnostics: [] },
    }),
    pluginRegistry: registry,
  };
  const successorAbort = vi.fn();
  const unrelatedAbort = vi.fn();
  let successor: ReturnType<typeof registerTestEmbeddedRun> | undefined;
  const source = registerTestEmbeddedRun(
    "source-session",
    createEmbeddedRunHandle({
      runId: "source-run",
      abort: () => {
        successor = registerTestEmbeddedRun(
          "source-session",
          createEmbeddedRunHandle({ runId: "successor-run", abort: successorAbort }),
          "agent:test:source",
        );
      },
    }),
    "agent:test:source",
  );
  const release = registerPluginReloadRunOwner(
    {
      replyOperation: source,
      runId: "source-run",
      sessionId: "source-session",
      sessionKey: "agent:test:source",
    },
    "test",
    generation,
  );
  assert(release, "expected the prepared generation binding");
  registerTestEmbeddedRun(
    "unrelated-session",
    createEmbeddedRunHandle({ runId: "unrelated-run", abort: unrelatedAbort }),
    "agent:test:unrelated",
  );
  const targets = capturePluginReloadRunTargets(new Set([instance]));
  expect(targets).toHaveLength(1);
  const selected = targets[0];
  assert(selected, "expected one physical generation owner");
  expect(selected.runId).toBe("source-run");
  expect(selected.interrupt()).toBe(true);
  expect(isAgentRunPluginReloadAbortReason(source.abortSignal.reason)).toBe(true);
  expect(isAgentRunRestartAbortReason(source.abortSignal.reason)).toBe(false);
  expect(successor).toBeDefined();
  expect(successor?.abortSignal.aborted).toBe(false);
  expect(successorAbort).not.toHaveBeenCalled();
  expect(unrelatedAbort).not.toHaveBeenCalled();
  release();
});
