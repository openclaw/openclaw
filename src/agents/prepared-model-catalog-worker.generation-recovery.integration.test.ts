import { beforeEach, describe, it, vi } from "vitest";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import { expectPublishedOwnerRecoveryAfterGenerationMismatch } from "./prepared-model-catalog-worker.generation-recovery.test-support.js";
import { createStaticCatalogSnapshotFixture } from "./test-helpers/prepared-model-catalog-static-fixture.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest } = usePreparedCatalogWorkerFixtures();
const createStaticSnapshot = createStaticCatalogSnapshotFixture({ makeTempDir, retireAfterTest });

describe("prepared model catalog generation recovery", () => {
  beforeEach(() => {
    vi.stubEnv("CODEX_HOME", makeTempDir("openclaw-worker-empty-codex-"));
  });

  const verifyRecovery = async (options: {
    activeHealthyBorrower?: boolean;
    sharedAgentDir?: boolean;
  }) => {
    const fixture = await createStaticSnapshot(0);
    const run = Reflect.get(
      WorkerTaskPool.prototype,
      "run",
    ) as (typeof WorkerTaskPool)["prototype"]["run"];
    let injectMismatch = false;
    const runSpy = vi.spyOn(WorkerTaskPool.prototype, "run").mockImplementation(function (
      this: (typeof WorkerTaskPool)["prototype"],
      input,
      runOptions,
    ) {
      if (typeof input !== "function") {
        return run.call(this, input, runOptions);
      }
      return run.call(
        this,
        async () => {
          const task = await input();
          if (
            !injectMismatch ||
            typeof task !== "object" ||
            task === null ||
            !("value" in task) ||
            !("request" in task) ||
            typeof task.value !== "object" ||
            task.value === null ||
            !("input" in task.value) ||
            typeof task.value.input !== "object" ||
            task.value.input === null ||
            !("agentDir" in task.value.input) ||
            task.value.input.agentDir !== fixture.agentDir ||
            typeof task.request !== "object" ||
            task.request === null ||
            !("kind" in task.request) ||
            task.request.kind !== "catalog"
          ) {
            return task;
          }
          injectMismatch = false;
          return {
            ...task,
            value: {
              ...task.value,
              generationFingerprint: "configured-owner-generation-drifted",
            },
          };
        },
        runOptions,
      );
    });
    try {
      await expectPublishedOwnerRecoveryAfterGenerationMismatch(
        fixture,
        () => {
          injectMismatch = true;
        },
        options,
      );
    } finally {
      runSpy.mockRestore();
    }
  };

  it("keeps a distinct warmed owner with the same agent directory usable", async () => {
    await verifyRecovery({ sharedAgentDir: true });
  });

  it("keeps an active healthy borrower reusable after collateral pool closure", async () => {
    await verifyRecovery({ activeHealthyBorrower: true });
  });
});
