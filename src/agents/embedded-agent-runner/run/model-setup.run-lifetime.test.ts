import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getActiveAgentRunDelegatedAuthority,
  getAgentRunContext,
} from "../../../infra/agent-run-registry.js";
import type { PluginHookBeforeModelResolveEvent } from "../../../plugins/hook-before-agent-start.types.js";
import { createHookRunnerWithRegistry } from "../../../plugins/hooks.test-fixtures.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import type { OpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { resetModelGenerationFixtureState } from "../model.generation-scope.test-support.js";
import { createModelSetupLifetimeFixture } from "./model-setup.run-lifetime.test-support.js";

vi.mock("../../harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: async () => undefined,
}));

const states: OpenClawTestState[] = [];
afterEach(async () => {
  resetModelGenerationFixtureState();
  for (const state of states.splice(0).toReversed()) {
    await state.cleanup();
  }
});

function createHeldModelResolveHook() {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  let receivedEvent: PluginHookBeforeModelResolveEvent | undefined;
  const { runner } = createHookRunnerWithRegistry([
    {
      hookName: "before_model_resolve",
      handler: async (...args: unknown[]) => {
        receivedEvent = args[0] as PluginHookBeforeModelResolveEvent;
        entered.resolve();
        await release.promise;
        return { modelOverride: "synthetic-routed-model" };
      },
    },
  ]);
  return {
    entered,
    release,
    runner,
    get receivedEvent() {
      return receivedEvent;
    },
  };
}

async function createFixture(modelSelectionLocked = false) {
  const fixture = await createModelSetupLifetimeFixture({ modelSelectionLocked });
  states.push(fixture.state);
  return fixture;
}

describe("before_model_resolve run lifetime", () => {
  it("does not invoke a real registered hook for an already-aborted source run", async () => {
    const fixture = await createFixture();
    const abortController = new AbortController();
    abortController.abort();
    const handler = vi.fn(() => ({ modelOverride: "synthetic-routed-model" }));
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "before_model_resolve", handler },
    ]);

    await expect(
      fixture.resolve(undefined, runner, { abortSignal: abortController.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(handler).not.toHaveBeenCalled();
    expect(fixture.generation.resolveDynamicModel).not.toHaveBeenCalled();
  });

  it("passes the source signal to a real hook and rejects its late model after cancellation", async () => {
    const fixture = await createFixture();
    const abortController = new AbortController();
    const hook = createHeldModelResolveHook();
    fixture.generation.resolveDynamicModel.mockClear();
    const loading = fixture.resolve(undefined, hook.runner, {
      abortSignal: abortController.signal,
    });
    try {
      await hook.entered.promise;
      expect(hook.receivedEvent?.signal).toBe(abortController.signal);
      abortController.abort();
      hook.release.resolve();

      await expect(loading).rejects.toMatchObject({ name: "AbortError" });
      expect(fixture.generation.resolveDynamicModel).not.toHaveBeenCalled();
    } finally {
      hook.release.resolve();
      await Promise.allSettled([loading]);
    }
  });

  it.each(["disappears", "is replaced", "foreign owner appears"] as const)(
    "rejects a late hook result after owner change: %s",
    async (ownerChange) => {
      const fixture = await createFixture();
      const runId = `model-lifetime-${randomUUID()}`;
      const initialAdmission = prepareSystemAgentRunAdmission(
        fixture.config,
        runId,
        "main",
        "model-resolution-test",
      );
      const arrivingAdmission =
        ownerChange === "is replaced" || ownerChange === "foreign owner appears"
          ? prepareSystemAgentRunAdmission(
              fixture.config,
              runId,
              "main",
              "model-resolution-arriving-owner-test",
            )
          : undefined;
      const abortController = new AbortController();
      const hook = createHeldModelResolveHook();
      if (ownerChange !== "foreign owner appears") {
        await initialAdmission.admit("embedded");
      }
      fixture.generation.resolveDynamicModel.mockClear();
      const loading = fixture.resolve(undefined, hook.runner, {
        runId,
        preparedRunAdmission: initialAdmission,
        abortSignal: abortController.signal,
      });
      try {
        await hook.entered.promise;
        if (arrivingAdmission) {
          await arrivingAdmission.admit("embedded");
        } else {
          initialAdmission.close();
        }
        expect(abortController.signal.aborted).toBe(false);
        hook.release.resolve();

        await expect(loading).rejects.toThrow(
          ownerChange === "foreign owner appears"
            ? "prepared run authority was replaced"
            : "prepared run authority",
        );
        expect(fixture.generation.resolveDynamicModel).not.toHaveBeenCalled();
      } finally {
        hook.release.resolve();
        await Promise.allSettled([loading]);
        initialAdmission.close();
        arrivingAdmission?.close();
      }
    },
  );

  it.each(["remains active", "is canceled", "finishes during the hook"] as const)(
    "allows pre-admission model selection when the previous same-runId owner %s",
    async (previousOwnerState) => {
      const fixture = await createFixture();
      const runId = `model-lifetime-replacement-${randomUUID()}`;
      let previousSourceActive = true;
      const previousAdmission = prepareSystemAgentRunAdmission(
        fixture.config,
        runId,
        "main",
        "model-resolution-previous-test",
        () => {
          if (!previousSourceActive) {
            throw new Error("previous source has ended");
          }
        },
      );
      const incomingAdmission = prepareSystemAgentRunAdmission(
        fixture.config,
        runId,
        "main",
        "model-resolution-incoming-test",
      );
      const abortController = new AbortController();
      const hook = createHeldModelResolveHook();
      await previousAdmission.admit("embedded");
      const previousAuthority = getAgentRunContext(runId)?.delegatedAuthority;
      expect(previousAuthority).toBeDefined();
      fixture.generation.resolveDynamicModel.mockClear();
      const loading = fixture.resolve(undefined, hook.runner, {
        runId,
        preparedRunAdmission: incomingAdmission,
        abortSignal: abortController.signal,
      });
      try {
        await hook.entered.promise;
        if (previousOwnerState === "is canceled") {
          previousSourceActive = false;
          expect(getAgentRunContext(runId)?.delegatedAuthority).toBe(previousAuthority);
        } else if (previousOwnerState === "finishes during the hook") {
          previousAdmission.close();
          expect(getAgentRunContext(runId)?.delegatedAuthority).toBeUndefined();
        } else {
          expect(getAgentRunContext(runId)?.delegatedAuthority).toBe(previousAuthority);
          expect(
            getActiveAgentRunDelegatedAuthority(previousAdmission.operationalRunInstance),
          ).toBe(previousAuthority);
        }
        hook.release.resolve();

        const setup = await loading;
        expect(setup.modelSelectionChangedByHook).toBe(true);
        expect(setup.requestedModelId).toBe("synthetic-routed-model");
        expect(fixture.generation.resolveDynamicModel).toHaveBeenCalledOnce();

        await incomingAdmission.admit("embedded");
        expect(getAgentRunContext(runId)?.delegatedAuthority).not.toBe(previousAuthority);
      } finally {
        hook.release.resolve();
        await Promise.allSettled([loading]);
        previousAdmission.close();
        incomingAdmission.close();
      }
    },
  );

  it("keeps a registered model-routing hook out of a locked session", async () => {
    const fixture = await createFixture(true);
    const handler = vi.fn(() => ({ modelOverride: "synthetic-routed-model" }));
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "before_model_resolve", handler },
    ]);

    const setup = await fixture.resolve(undefined, runner);

    expect(handler).not.toHaveBeenCalled();
    expect(setup.model.id).toBe("fixture-model");
    expect(fixture.generation.resolveDynamicModel).toHaveBeenCalled();
  });

  it("keeps an ordinary registered hook exception fail-open for the current run", async () => {
    const fixture = await createFixture();
    const handler = vi.fn(() => {
      throw new Error("synthetic hook failure");
    });
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "before_model_resolve", handler },
    ]);

    const setup = await fixture.resolve(undefined, runner);

    expect(handler).toHaveBeenCalledOnce();
    expect(setup.model.id).toBe("fixture-model");
    expect(fixture.generation.resolveDynamicModel).toHaveBeenCalled();
  });
});
