// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { expect, it } from "vitest";
import { PreparedModelCatalogConfigReplacedError } from "./prepared-model-catalog.errors.js";
import { loadPreparedModelCatalogOwnerSnapshot } from "./prepared-model-catalog.js";
import {
  markPreparedModelRuntimeSnapshotsStale,
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const fixture = usePreparedModelRuntimeHarness({ label: "published-model-replacement" });

it.each([false, true])(
  "preserves exact admission while published reads follow replacement (readPublished=%s)",
  async (readPublished) => {
    const initialConfig = {};
    const replacementConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    fixture.mocks.configuredAgentIds = ["default"];
    await refreshPreparedModelRuntimeSnapshots(initialConfig, { gatewayLifecycle: true });
    markPreparedModelRuntimeSnapshotsStale("replace picker catalog", { waitForReplacement: true });

    const input = fixture.agentInput("default", initialConfig);
    const pending = readPublished
      ? prepareModelRuntimeSnapshot(input, { readPublished: true })
      : loadPreparedModelCatalogOwnerSnapshot(input);
    const outcome = pending.then(
      (snapshot) => ({ snapshot, error: undefined }),
      (error: unknown) => ({ snapshot: undefined, error }),
    );
    await refreshPreparedModelRuntimeSnapshots(replacementConfig, { gatewayLifecycle: true });
    const result = await outcome;
    if (readPublished) {
      expect(result.error).toBeUndefined();
      expect(result.snapshot).toMatchObject({ config: replacementConfig });
    } else {
      expect(result.error).toBeInstanceOf(PreparedModelCatalogConfigReplacedError);
    }
  },
);
