// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import * as agentDatabase from "../state/openclaw-agent-execution.js";
import { startSerializedSnapshotBuildBatch } from "./prepared-model-runtime.build.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";
import {
  getPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import {
  capturePreparedModelRuntimeGeneration,
  retirePreparedModelRuntimeGeneration,
} from "./prepared-model-runtime.lifecycle.js";
import { prepareModelRuntimeOwner } from "./prepared-model-runtime.owner.js";

const fixture = usePreparedModelRuntimeHarness({ label: "model-database-retirement" });

it.each(["retirement", "unrelated"] as const)(
  "handles %s database cancellation during startup replacement",
  async (failureSource) => {
    fixture.mocks.configuredAgentIds = ["default"];
    const cfg = {};
    const entered = createDeferred<AbortSignal>();
    const unrelated = new DOMException("unrelated database cancellation", "AbortError");
    using preparation = vi
      .spyOn(agentDatabase, "prepareOpenClawAgentDatabaseExecution")
      .mockImplementationOnce(async (_options, _assertCurrent, signal) => {
        expect(signal).toBeDefined();
        entered.resolve(signal!);
        await new Promise<never>((_resolve, reject) => {
          signal!.addEventListener(
            "abort",
            () => {
              const reason = failureSource === "retirement" ? signal!.reason : unrelated;
              assert(reason instanceof Error);
              reject(reason);
            },
            { once: true },
          );
        });
      });
    const startup = refreshPreparedModelRuntimeSnapshots(cfg, {
      gatewayLifecycle: true,
      startup: true,
      catalogMode: "static",
      joinSupersedingPublication: true,
    });
    const outcome = startup.catch((error: unknown) => error);
    let replacement: Promise<void> | undefined;
    try {
      const retired = await awaitGateBeforeSettlement(
        entered.promise,
        startup,
        "Startup settled before database preparation",
      );
      replacement = refreshPreparedModelRuntimeSnapshots(cfg, {
        agentIds: new Set(["default"]),
        catalogMode: "static",
      });
      expect(retired.aborted).toBe(true);
      await replacement;
      if (failureSource === "retirement") {
        expect(await outcome).toBeUndefined();
      } else {
        expect(await outcome).toBe(unrelated);
      }
      expect(preparation).toHaveBeenCalledTimes(2);
      expect(
        getPreparedModelRuntimeSnapshot({
          config: cfg,
          agentId: "default",
          agentDir: fixture.state.agentDir("default"),
        })?.isCurrent(),
      ).toBe(true);
    } finally {
      await Promise.allSettled([startup, replacement]);
    }
  },
);

it.each(["retirement", "unrelated"] as const)(
  "handles %s cancellation when the config build outlives its owner generation",
  async (failureSource) => {
    const owner = prepareModelRuntimeOwner(fixture.agentInput("default", {}), "configured");
    const generation = owner.generation;
    const retirementSignal = capturePreparedModelRuntimeGeneration(owner);
    const unrelated = new DOMException("unrelated database cancellation", "AbortError");
    const isBuildCurrent = () => true;
    const isGenerationCurrent = () => owner.generation === generation;
    using preparation = vi
      .spyOn(agentDatabase, "prepareOpenClawAgentDatabaseExecution")
      .mockImplementationOnce(async () => {
        owner.generation += 1;
        retirePreparedModelRuntimeGeneration(owner);
        throw failureSource === "retirement" ? retirementSignal.reason : unrelated;
      });
    const build = startSerializedSnapshotBuildBatch(
      [
        {
          input: owner.input,
          catalogOwner: owner.catalogOwner,
          inventoryOwner: owner,
          retirementSignal,
          isBuildCurrent,
          isGenerationCurrent,
        },
      ],
      new Map(),
      undefined,
      "static",
    );
    try {
      if (failureSource === "retirement") {
        await expect(build.pending).rejects.toBeInstanceOf(
          PreparedModelRuntimePublicationSupersededError,
        );
      } else {
        await expect(build.pending).rejects.toBe(unrelated);
      }
      expect(preparation).toHaveBeenCalledOnce();
      expect(isBuildCurrent()).toBe(true);
      expect(isGenerationCurrent()).toBe(false);
    } finally {
      await build.completion;
    }
  },
);
