import { afterEach, describe, expect, it } from "vitest";
import { acquirePluginRegistryForInspection } from "../plugins/loader.js";
import {
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
} from "../plugins/loader.test-fixtures.js";
import { PluginInstanceUnavailableError } from "../plugins/plugin-instance-error.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createInspectionFixture } from "../plugins/registry-inspection.test-helpers.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { retainPreparedPluginRegistry } from "./prepared-model-runtime.plugin-lifetime.js";
import { PreparedModelRuntimeBuildResources } from "./prepared-model-runtime.resources.js";

afterEach(() => resetPluginRuntimeStateForTest());
afterEach(resetPluginLoaderTestStateForTest);

/**
 * Regression coverage for the `previousRegistry`-retention ownership-transfer fix
 * (`transferPluginInstanceOwner`, see `plugin-instance-scope.ts` and
 * `loader-runtime-core.ts`'s `resolvePluginRecordRetention` call site).
 *
 * Supersedes the removed `prepared-model-runtime.plugin-lifetime.disposal-successor.test.ts`,
 * `.inspection-successor.test.ts`, and `.build-resources-successor.test.ts`: those three tested
 * the now-deleted `recordPreparedPluginRegistrySuccessor`/`registrySuccessors`/
 * `retainInstancesFor` machinery, which only ever suppressed a predecessor's premature disposal
 * (ClawSweeper finding 1) and never transferred the instance into any registry's own eventual
 * disposal set (ClawSweeper finding 2, a leak). The real fix moves `owner.registry` itself
 * forward to the retaining registry the moment retention happens, so the generic
 * `owner.registry === registry` custody check every disposal path already relies on
 * (`getPluginRecordRegistry`, the inspection retire callback, `isPluginRecordActive`) is correct
 * for the whole chain without any extra bookkeeping.
 */
describe("previousRegistry-retained plugin instance ownership transfer", () => {
  it(
    "survives predecessor release, serves a real successor-side call, and disposes exactly " +
      "once once both generations retire (real PreparedModelRuntimeBuildResources worker path)",
    async () => {
      const fixture = createInspectionFixture();
      const predecessorResources = new PreparedModelRuntimeBuildResources(
        retainPreparedPluginRegistry,
      );
      const successorResources = new PreparedModelRuntimeBuildResources(
        retainPreparedPluginRegistry,
      );
      try {
        // Predecessor generation: scope = [fixture plugin] only, mirroring the worker's first
        // model-catalog generation.
        const predecessorRegistry = await predecessorResources.load(
          { config: fixture.config, basePluginIds: [fixture.plugin.id], purpose: "model-catalog" },
          () => {},
        );
        const predecessorRecord = predecessorRegistry.plugins.find(
          (record) => record.id === fixture.plugin.id,
        );
        expect(predecessorRecord).toBeDefined();
        const instance = getPluginInstance(predecessorRecord!);
        expect(instance).toBeDefined();

        // Successor generation: scope-growth promotion over the SAME plugin id, threading the
        // predecessor through as `reusableRegistry` -- exactly what `prepareWorkerGeneration`
        // does on a fingerprint/pluginIds miss.
        const successorRegistry = await successorResources.load(
          {
            config: fixture.config,
            basePluginIds: [fixture.plugin.id],
            reusableRegistry: predecessorRegistry,
            purpose: "model-catalog",
          },
          () => {},
        );
        const successorRecord = successorRegistry.plugins.find(
          (record) => record.id === fixture.plugin.id,
        );
        expect(successorRecord).toBeDefined();
        // The successor really carried the predecessor's instance forward (incremental reuse),
        // not a freshly loaded one -- otherwise this test proves nothing.
        expect(getPluginInstance(successorRecord!)).toBe(instance);

        // Release the predecessor through the SAME path the worker actually uses: dropping the
        // `PreparedModelRuntimeBuildResources` that holds its only physical claim.
        await predecessorResources[Symbol.asyncDispose]();

        // The shared instance must not have been disposed or revoked by the predecessor's
        // release, which this fix achieves by moving `owner.registry` to the successor at
        // retention time (so the predecessor's retire filter no longer matches it at all).
        expect(instance!.disposing).toBe(false);

        // Prove an ACTUAL successor-side call succeeds, not just `disposing === false`: run a
        // real call through the instance scoped to the successor registry, the same
        // `runInRegistry` call shape `createRegistryView`/provider hook routing use internally.
        const result = instance!.runInRegistry(successorRegistry, () => "successor-call-ok");
        expect(result).toBe("successor-call-ok");

        // Now retire the successor too (terminal generation, no further successor). The shared
        // instance must be disposed exactly once -- not zero times (the leak ClawSweeper flagged
        // when disposal custody was never transferred anywhere) and not more than once.
        await successorResources[Symbol.asyncDispose]();
        expect(instance!.disposing).toBe(true);
        expect(fixture.connection(0).instanceDisposals).toBe(1);
      } finally {
        await successorResources[Symbol.asyncDispose]().catch(() => undefined);
        await predecessorResources[Symbol.asyncDispose]().catch(() => undefined);
      }
    },
  );

  it("transfers ownership through the plain acquirePluginRegistryForInspection previousRegistry path", async () => {
    const fixture = createInspectionFixture();
    let predecessor: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
    let successor: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
    try {
      predecessor = await acquirePluginRegistryForInspection({ config: fixture.config });
      const predecessorRecord = predecessor.registry.plugins.find(
        (record) => record.id === fixture.plugin.id,
      );
      const instance = getPluginInstance(predecessorRecord!);
      expect(instance).toBeDefined();

      successor = await acquirePluginRegistryForInspection({
        config: fixture.config,
        previousRegistry: predecessor.registry,
        transferInstanceOwnership: true,
      });
      const successorRecord = successor.registry.plugins.find(
        (record) => record.id === fixture.plugin.id,
      );
      expect(getPluginInstance(successorRecord!)).toBe(instance);

      // Release the predecessor's only physical claim, then the inspection itself.
      const releasePredecessor = retainPreparedPluginRegistry(predecessor.registry);
      await releasePredecessor?.();
      await predecessor.release();
      predecessor = undefined;

      expect(instance!.disposing).toBe(false);
      expect(fixture.connection(0).instanceDisposals).toBe(0);
      // A real call through the successor still works.
      expect(instance!.runInRegistry(successor.registry, () => "successor-call-ok")).toBe(
        "successor-call-ok",
      );

      await successor.release();
      successor = undefined;
      expect(fixture.connection(0).instanceDisposals).toBe(1);
    } finally {
      await fixture.cleanup(successor);
      await fixture.cleanup(predecessor);
    }
  });

  it("rejects a stale predecessor-only instance's call before any I/O once it is retired without a successor", async () => {
    useNoBundledPlugins();
    const fixture = createInspectionFixture();
    let inspection: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
    try {
      inspection = await acquirePluginRegistryForInspection({ config: fixture.config });
      const record = inspection.registry.plugins.find((entry) => entry.id === fixture.plugin.id);
      const instance = getPluginInstance(record!);
      expect(instance).toBeDefined();

      // Retire this generation with no successor at all (not disabled/replaced by a newer
      // generation): disposal must proceed normally, and the stale instance must then reject a
      // later call attempt before touching the database again -- the liveness fencing this fix
      // must not weaken for the ordinary, no-handoff retirement case.
      const release = retainPreparedPluginRegistry(inspection.registry);
      await release?.();
      await inspection.release();
      const released = inspection;
      inspection = undefined;

      expect(fixture.connection(0).instanceDisposals).toBe(1);
      expect(() =>
        instance!.runInRegistry(released.registry, () => {
          throw new Error("must not reach real I/O on a retired instance");
        }),
      ).toThrow(PluginInstanceUnavailableError);
    } finally {
      await fixture.cleanup(inspection);
    }
  });

  it("rejects the old generation's authority before I/O once a plugin is disabled in the next generation", async () => {
    useNoBundledPlugins();
    const fixture = createInspectionFixture();
    let predecessor: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
    let successor: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
    try {
      predecessor = await acquirePluginRegistryForInspection({ config: fixture.config });
      const predecessorRecord = predecessor.registry.plugins.find(
        (record) => record.id === fixture.plugin.id,
      );
      const instance = getPluginInstance(predecessorRecord!);
      expect(instance).toBeDefined();

      // Next generation disables the plugin entirely (not a scope-growth promotion): the record
      // is NOT retained, so `transferPluginInstanceOwner` is never called for it, and this old
      // instance must correctly reject a later call before touching real I/O once its own
      // generation retires -- liveness fencing must still hold for a replaced/disabled plugin,
      // not just for the ordinary no-handoff case the previous test covers.
      successor = await acquirePluginRegistryForInspection({
        config: { plugins: { allow: [], load: { paths: [] }, slots: { memory: "none" } } },
        previousRegistry: predecessor.registry,
        transferInstanceOwnership: true,
      });
      expect(
        successor.registry.plugins.find((record) => record.id === fixture.plugin.id),
      ).toBeUndefined();

      const release = retainPreparedPluginRegistry(predecessor.registry);
      await release?.();
      await predecessor.release();
      const released = predecessor;
      predecessor = undefined;

      expect(fixture.connection(0).instanceDisposals).toBe(1);
      expect(() =>
        instance!.runInRegistry(released.registry, () => {
          throw new Error("must not reach real I/O on a disabled/retired instance");
        }),
      ).toThrow(PluginInstanceUnavailableError);
    } finally {
      await fixture.cleanup(successor);
      await fixture.cleanup(predecessor);
    }
  });

  it("rejects stale transferred authority before real I/O after transfer-then-disable sequence with resource-backed proof", async () => {
    useNoBundledPlugins();
    // Track whether real database operations were executed
    let realQueryExecutedCount = 0;
    let realQueryResultValue: number | undefined;

    const fixture = createInspectionFixture();
    let predecessor: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
    let successor: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
    let thirdGen: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
    try {
      // 1. Load predecessor generation
      predecessor = await acquirePluginRegistryForInspection({ config: fixture.config });
      const predecessorRecord = predecessor.registry.plugins.find(
        (record) => record.id === fixture.plugin.id,
      );
      const predecessorInstance = getPluginInstance(predecessorRecord!);
      expect(predecessorInstance).toBeDefined();

      // 2. Transfer to successor via retention (transferPluginInstanceOwner called)
      successor = await acquirePluginRegistryForInspection({
        config: fixture.config,
        previousRegistry: predecessor.registry,
        transferInstanceOwnership: true,
      });
      const successorRecord = successor.registry.plugins.find(
        (record) => record.id === fixture.plugin.id,
      );
      expect(successorRecord).toBeDefined();

      const successorInstance = getPluginInstance(successorRecord!);
      expect(successorInstance).toBeDefined();
      expect(successorInstance).toBe(predecessorInstance);

      // Release the predecessor's only physical claim
      const releasePredecessor = retainPreparedPluginRegistry(predecessor.registry);
      await releasePredecessor?.();
      await predecessor.release();
      predecessor = undefined;

      // 3. Perform an ACTUAL resource-backed operation through the successor's instance
      // Execute a REAL SQL query against the fixture's actual SQLite database
      const firstOperationResult = successorInstance!.runInRegistry(successor.registry, () => {
        // Access the real database connection and execute a real query
        const connection = fixture.connection(0);
        const result = connection.database.prepare("SELECT 42 AS value").get() as { value: number };
        realQueryExecutedCount++;
        realQueryResultValue = result.value;
        return `real-operation-success-${result.value}`;
      });
      expect(firstOperationResult).toBe(`real-operation-success-42`);
      expect(realQueryExecutedCount).toBe(1);
      expect(realQueryResultValue).toBe(42);
      expect(successorInstance!.disposing).toBe(false);

      // 4. Disable the plugin in a third generation
      thirdGen = await acquirePluginRegistryForInspection({
        config: { plugins: { allow: [], load: { paths: [] }, slots: { memory: "none" } } },
        previousRegistry: successor.registry,
        transferInstanceOwnership: true,
      });
      expect(
        thirdGen.registry.plugins.find((record) => record.id === fixture.plugin.id),
      ).toBeUndefined();

      // Release successor retention
      const successorRelease = retainPreparedPluginRegistry(successor.registry);
      await successorRelease?.();
      await successor.release();
      const releasedSuccessorRegistry = successor.registry;
      successor = undefined;

      // 5. Track real query execution count before attempting the operation again
      const queryExecutedBeforeSecondAttempt = realQueryExecutedCount;

      // Attempt the SAME resource-backed operation again
      // This should be rejected BEFORE touching the real resource again
      expect(() =>
        successorInstance!.runInRegistry(releasedSuccessorRegistry, () => {
          // This real database operation should NEVER be reached
          // If the authority check passes (which it shouldn't), we would execute a real query
          const connection = fixture.connection(0);
          const result = connection.database.prepare("SELECT 99 AS value").get() as {
            value: number;
          };
          realQueryExecutedCount++;
          // We should never reach this point, so we throw an error if we do
          throw new Error("must not reach real I/O on a transferred-then-disabled instance");
        }),
      ).toThrow(PluginInstanceUnavailableError);

      // Verify the real database query was NOT executed again
      expect(realQueryExecutedCount).toBe(queryExecutedBeforeSecondAttempt);
      expect(realQueryExecutedCount).toBe(1); // Only the first query should have executed

      // Verify the instance is now marked as disposing
      expect(successorInstance!.disposing).toBe(true);
      expect(fixture.connection(0).instanceDisposals).toBe(1);
    } finally {
      await fixture.cleanup(thirdGen);
      await fixture.cleanup(successor);
      await fixture.cleanup(predecessor);
    }
  });

  it("transferred-then-disabled plugin correctly rejects stale authority via actual worker machinery (real PreparedModelRuntimeBuildResources path)", async () => {
    const fixture = createInspectionFixture();
    const predecessorResources = new PreparedModelRuntimeBuildResources(
      retainPreparedPluginRegistry,
    );
    const successorResources = new PreparedModelRuntimeBuildResources(retainPreparedPluginRegistry);
    const thirdGenResources = new PreparedModelRuntimeBuildResources(retainPreparedPluginRegistry);
    try {
      // 1. Load predecessor generation (first worker generation)
      const predecessorRegistry = await predecessorResources.load(
        { config: fixture.config, basePluginIds: [fixture.plugin.id], purpose: "model-catalog" },
        () => {},
      );
      const predecessorRecord = predecessorRegistry.plugins.find(
        (record) => record.id === fixture.plugin.id,
      );
      expect(predecessorRecord).toBeDefined();
      const instance = getPluginInstance(predecessorRecord!);
      expect(instance).toBeDefined();

      // 2. Transfer to successor generation via real worker path (scope-growth promotion)
      const successorRegistry = await successorResources.load(
        {
          config: fixture.config,
          basePluginIds: [fixture.plugin.id],
          reusableRegistry: predecessorRegistry,
          purpose: "model-catalog",
        },
        () => {},
      );
      const successorRecord = successorRegistry.plugins.find(
        (record) => record.id === fixture.plugin.id,
      );
      expect(successorRecord).toBeDefined();
      // Verify the instance was transferred, not freshly loaded
      expect(getPluginInstance(successorRecord!)).toBe(instance);

      // 3. Release predecessor through actual worker disposal path
      await predecessorResources[Symbol.asyncDispose]();

      // 4. Perform an actual worker-callback-like operation through successor
      // This simulates provider callback / transport boundary in real worker
      const firstCallResult = instance!.runInRegistry(successorRegistry, () => {
        return "first-real-worker-call-ok";
      });
      expect(firstCallResult).toBe("first-real-worker-call-ok");
      expect(instance!.disposing).toBe(false);

      // 5. Build third generation that DISABLES the plugin via same real worker machinery
      const thirdGenRegistry = await thirdGenResources.load(
        {
          config: { plugins: { allow: [], load: { paths: [] }, slots: { memory: "none" } } },
          basePluginIds: [fixture.plugin.id],
          reusableRegistry: successorRegistry,
          purpose: "model-catalog",
        },
        () => {},
      );
      // Plugin should NOT appear in third generation
      expect(
        thirdGenRegistry.plugins.find((record) => record.id === fixture.plugin.id),
      ).toBeUndefined();

      // 6. Release successor (plugin disabled, no further transfer)
      await successorResources[Symbol.asyncDispose]();

      // 7. Attempt to call through now-stale transferred authority
      // This must be rejected BEFORE any I/O would happen
      expect(() => {
        instance!.runInRegistry(successorRegistry, () => {
          // This would be the real worker I/O that should never be reached
          throw new Error(
            "must not reach real I/O on a transferred-then-disabled instance via worker path",
          );
        });
      }).toThrow(PluginInstanceUnavailableError);

      // 8. Verify disposal count
      expect(fixture.connection(0).instanceDisposals).toBe(1);
    } finally {
      await thirdGenResources[Symbol.asyncDispose]().catch(() => undefined);
      await successorResources[Symbol.asyncDispose]().catch(() => undefined);
      await predecessorResources[Symbol.asyncDispose]().catch(() => undefined);
    }
  });

  it("dispatches retained provider catalog callbacks after successful handoff and revokes stale callbacks before I/O", async () => {
    const fixture = createInspectionFixture({ providerCatalog: true });
    const predecessorResources = new PreparedModelRuntimeBuildResources(
      retainPreparedPluginRegistry,
    );
    const successorResources = new PreparedModelRuntimeBuildResources(retainPreparedPluginRegistry);
    const disabledResources = new PreparedModelRuntimeBuildResources(retainPreparedPluginRegistry);
    try {
      const predecessorRegistry = await predecessorResources.load(
        { config: fixture.config, basePluginIds: [fixture.plugin.id], purpose: "model-catalog" },
        () => {},
      );
      const predecessorRecord = predecessorRegistry.plugins.find(
        (record) => record.id === fixture.plugin.id,
      );
      const instance = getPluginInstance(predecessorRecord!);
      expect(instance).toBeDefined();

      const successorRegistry = await successorResources.load(
        {
          config: fixture.config,
          basePluginIds: [fixture.plugin.id],
          reusableRegistry: predecessorRegistry,
          purpose: "model-catalog",
        },
        () => {},
      );
      expect(
        getPluginInstance(
          successorRegistry.plugins.find((record) => record.id === fixture.plugin.id)!,
        ),
      ).toBe(instance);

      await predecessorResources[Symbol.asyncDispose]();

      const successorProvider = successorRegistry.providers.find(
        (entry) => entry.provider.id === `${fixture.plugin.id}-provider`,
      )?.provider;
      expect(successorProvider?.catalog?.run).toBeTypeOf("function");
      await expect(successorProvider!.catalog!.run({} as never)).resolves.toMatchObject({
        provider: { models: [{ id: "fixture-model-42" }] },
      });
      expect(fixture.connection(0).catalogRuns).toBe(1);

      const staleRun = successorProvider!.catalog!.run;
      const disabledRegistry = await disabledResources.load(
        {
          config: { plugins: { allow: [], load: { paths: [] }, slots: { memory: "none" } } },
          basePluginIds: [fixture.plugin.id],
          reusableRegistry: successorRegistry,
          purpose: "model-catalog",
        },
        () => {},
      );
      expect(
        disabledRegistry.providers.find(
          (entry) => entry.provider.id === `${fixture.plugin.id}-provider`,
        ),
      ).toBeUndefined();

      await successorResources[Symbol.asyncDispose]();
      const runsBeforeStaleAttempt = fixture.connection(0).catalogRuns;
      await expect(Promise.resolve().then(() => staleRun({} as never))).rejects.toThrow(
        PluginInstanceUnavailableError,
      );
      expect(fixture.connection(0).catalogRuns).toBe(runsBeforeStaleAttempt);
      expect(fixture.connection(0).instanceDisposals).toBe(1);
    } finally {
      await disabledResources[Symbol.asyncDispose]().catch(() => undefined);
      await successorResources[Symbol.asyncDispose]().catch(() => undefined);
      await predecessorResources[Symbol.asyncDispose]().catch(() => undefined);
    }
  });

  it("failed worker handoff restores predecessor registered provider callbacks via real worker path", async () => {
    const fixture = createInspectionFixture({ providerCatalog: true });
    const predecessorResources = new PreparedModelRuntimeBuildResources(
      retainPreparedPluginRegistry,
    );
    let successorResources: PreparedModelRuntimeBuildResources | undefined =
      new PreparedModelRuntimeBuildResources(retainPreparedPluginRegistry);
    try {
      const predecessorRegistry = await predecessorResources.load(
        { config: fixture.config, basePluginIds: [fixture.plugin.id], purpose: "model-catalog" },
        () => {},
      );
      const predecessorProvider = predecessorRegistry.providers.find(
        (entry) => entry.provider.id === `${fixture.plugin.id}-provider`,
      )?.provider;
      expect(predecessorProvider?.catalog?.run).toBeTypeOf("function");

      const buildError = new Error("Simulated provider callback handoff failure");
      await expect(
        successorResources.load(
          {
            config: fixture.config,
            basePluginIds: [fixture.plugin.id],
            reusableRegistry: predecessorRegistry,
            purpose: "model-catalog",
          },
          () => {
            throw buildError;
          },
        ),
      ).rejects.toThrow(buildError);
      await successorResources[Symbol.asyncDispose]().catch(() => undefined);
      successorResources = undefined;

      await expect(predecessorProvider!.catalog!.run({} as never)).resolves.toMatchObject({
        provider: { models: [{ id: "fixture-model-42" }] },
      });
      expect(fixture.connection(0).catalogRuns).toBe(1);
      expect(fixture.connection(0).instanceDisposals).toBe(0);
    } finally {
      await successorResources?.[Symbol.asyncDispose]().catch(() => undefined);
      await predecessorResources[Symbol.asyncDispose]().catch(() => undefined);
    }
  });

  it("failed worker handoff (generation build throws after transfer) restores predecessor custody via real worker path", async () => {
    const fixture = createInspectionFixture();
    const predecessorResources = new PreparedModelRuntimeBuildResources(
      retainPreparedPluginRegistry,
    );
    let successorResources: PreparedModelRuntimeBuildResources | undefined =
      new PreparedModelRuntimeBuildResources(retainPreparedPluginRegistry);
    try {
      // 1. Load predecessor generation
      const predecessorRegistry = await predecessorResources.load(
        { config: fixture.config, basePluginIds: [fixture.plugin.id], purpose: "model-catalog" },
        () => {},
      );
      const predecessorRecord = predecessorRegistry.plugins.find(
        (record) => record.id === fixture.plugin.id,
      );
      expect(predecessorRecord).toBeDefined();
      const instance = getPluginInstance(predecessorRecord!);
      expect(instance).toBeDefined();

      // 2. Record disposal count before attempting successor build
      const initialDisposals = fixture.connection(0).instanceDisposals;

      // 3. Start successor generation build that will throw partway through
      // Simulate a worker generation build that throws during the build process
      const buildError = new Error("Simulated worker generation build failure");
      const successorPromise = successorResources.load(
        {
          config: fixture.config,
          basePluginIds: [fixture.plugin.id],
          reusableRegistry: predecessorRegistry,
          purpose: "model-catalog",
        },
        () => {
          // This callback simulates something happening during the build
          // The system should handle rollback if transfer happened before this throw
          throw buildError;
        },
      );

      // 4. Attempt build - should reject
      await expect(successorPromise).rejects.toThrow(buildError);

      // 5. Clean up the failed successor resources FIRST
      await successorResources[Symbol.asyncDispose]().catch(() => undefined);
      successorResources = undefined;

      // 6. IMMEDIATELY AFTER failed successor disposal, verify predecessor still has custody:
      // - Instance is NOT disposing
      // - A real registry operation through the predecessor still works
      // - Disposal count is still 0 at this specific point
      expect(instance!.disposing).toBe(false);
      expect(fixture.connection(0).instanceDisposals).toBe(initialDisposals);

      // Real registry operation through the predecessor
      const predecessorCallResult = instance!.runInRegistry(predecessorRegistry, () => {
        return "predecessor-call-after-failed-handoff-disposal-ok";
      });
      expect(predecessorCallResult).toBe("predecessor-call-after-failed-handoff-disposal-ok");

      // 7. Now release predecessor normally
      await predecessorResources[Symbol.asyncDispose]();
      expect(instance!.disposing).toBe(true);
      expect(fixture.connection(0).instanceDisposals).toBe(initialDisposals + 1);
    } finally {
      await successorResources?.[Symbol.asyncDispose]().catch(() => undefined);
      await predecessorResources[Symbol.asyncDispose]().catch(() => undefined);
    }
  });
});
