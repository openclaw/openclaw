import { describe, expect, it, vi } from "vitest";
import { patchSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { createHookRunnerWithRegistry } from "../../../plugins/hooks.test-fixtures.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  closeAdmittedRunDelegatedAuthority,
  prepareSystemAgentRunAdmission,
} from "../../admitted-run-context.js";
import { ensureSelectedAgentHarnessPlugin } from "../../harness/runtime-plugin.js";
import { runWithModelFallback } from "../../model-fallback-runner.js";
import { createModelOwnershipFixture as createFixture } from "./model-setup.ownership.test-support.js";

// mock-isolation: Installation is outside this boundary; routing, admission, and fallback stay real.
vi.mock("../../harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
}));

describe("routing result lifetime", () => {
  it.each([
    "cancel source",
    "revoke source",
    "close before admission",
    "admit and close during hook",
    "admit and release during hook",
    "close current owner",
    "replace current owner",
    "close admitted owner",
    "replace admitted owner",
    "foreign owner arrives",
    "previous owner stays",
    "previous owner cancels",
    "previous owner finishes",
    "current owner arrives",
    "active source",
    "ordinary hook failure",
  ] as const)("accepts routing only for the current source: %s", async (transition) => {
    const fixture = await createFixture();
    fixture.runParams.modelSelectionLocked = false;
    await patchSessionEntryCore(fixture.target, () => ({ modelSelectionLocked: false }));
    const runId = `routing-${transition}`;
    fixture.runParams.runId = runId;
    const abort = new AbortController();
    fixture.runParams.abortSignal = abort.signal;
    let previousActive = true;
    const previous = prepareSystemAgentRunAdmission({}, runId, "main", "routing-previous", () => {
      if (!previousActive) {
        throw new Error("previous source canceled");
      }
    });
    let incomingActive = true;
    const incoming = prepareSystemAgentRunAdmission({}, runId, "main", "routing-incoming", () => {
      if (!incomingActive) {
        throw new Error("incoming source canceled");
      }
    });
    const replacement = prepareSystemAgentRunAdmission({}, runId, "main", "routing-replacement");
    fixture.runParams.preparedRunAdmission = incoming;
    if (transition.startsWith("previous owner")) {
      await previous.admit("embedded");
    } else if (transition === "close current owner" || transition === "replace current owner") {
      await incoming.admit("embedded");
    } else if (transition === "close admitted owner" || transition === "replace admitted owner") {
      fixture.runParams.preparedRunAdmission = undefined;
      fixture.runParams.admittedRunContext = await incoming.admit("embedded");
    }
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const { runner } = createHookRunnerWithRegistry([
      {
        hookName: "before_model_resolve",
        handler: async () => {
          entered.resolve();
          await release.promise;
          if (transition === "ordinary hook failure") {
            throw new Error("synthetic routing failure");
          }
          return { modelOverride: "routed-model" };
        },
      },
    ]);
    fixture.generation.resolveDynamicModel.mockClear();
    const pluginPreparation = vi.mocked(ensureSelectedAgentHarnessPlugin).mockClear();
    const attempt = vi.fn(() => fixture.resolve(undefined, undefined, undefined, runner));
    const loading = runWithModelFallback({
      cfg: undefined,
      provider: "fixture-provider",
      model: "fixture-model",
      manifestPlugins: [],
      fallbacksOverride: ["fixture-next/fixture-model"],
      abortSignal: abort.signal,
      run: attempt,
    });
    try {
      await Promise.race([
        entered.promise,
        loading.then(() => {
          throw new Error("model setup settled before routing started");
        }),
      ]);
      if (transition === "cancel source") {
        abort.abort();
      } else if (transition === "revoke source") {
        incomingActive = false;
      } else if (transition === "close before admission") {
        incoming.close();
      } else if (transition === "admit and close during hook") {
        await incoming.admit("embedded");
        incoming.close();
      } else if (transition === "admit and release during hook") {
        closeAdmittedRunDelegatedAuthority(await incoming.admit("embedded"));
      } else if (transition === "close current owner" || transition === "close admitted owner") {
        incoming.close();
      } else if (
        transition === "replace current owner" ||
        transition === "replace admitted owner" ||
        transition === "foreign owner arrives"
      ) {
        await replacement.admit("embedded");
      } else if (transition === "previous owner cancels") {
        previousActive = false;
      } else if (transition === "previous owner finishes") {
        previous.close();
      } else if (transition === "current owner arrives") {
        await incoming.admit("embedded");
      }
      release.resolve();
      const rejected = [
        "cancel source",
        "revoke source",
        "close before admission",
        "admit and close during hook",
        "admit and release during hook",
        "close current owner",
        "replace current owner",
        "close admitted owner",
        "replace admitted owner",
        "foreign owner arrives",
      ].includes(transition);
      if (rejected) {
        await expect(loading).rejects.toThrow();
        expect(pluginPreparation).not.toHaveBeenCalled();
        expect(fixture.generation.resolveDynamicModel).not.toHaveBeenCalled();
      } else {
        const { result: setup } = await loading;
        expect(setup.requestedModelId).toBe(
          transition === "ordinary hook failure" ? "fixture-model" : "routed-model",
        );
        expect(fixture.generation.resolveDynamicModel).toHaveBeenCalledOnce();
        await incoming.admit("embedded");
      }
      expect(attempt).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await Promise.allSettled([loading]);
      previous.close();
      incoming.close();
      replacement.close();
    }
  });
});
