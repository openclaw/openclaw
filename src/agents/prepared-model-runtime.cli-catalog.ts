import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { prepareCliModelCatalog } from "./prepared-cli-model-catalog.js";
import {
  getPreparedModelFullCatalogAuth,
  type PreparedModelCatalogAuth,
} from "./prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeCatalogAccessParams } from "./prepared-model-runtime.catalog-contract.js";
import { retainPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";
import type { PreparedModelCatalogRefreshOptions } from "./prepared-model-runtime.types.js";

/** Own compatibility observations and request-driven renewal for one prepared generation. */
export function createPreparedCliModelCatalogAccess(
  params: PreparedModelRuntimeCatalogAccessParams,
  initialAuth: PreparedModelCatalogAuth,
) {
  let compatibility = params.catalogFacts.modelCatalog.cliRuntimeCompatibility;
  let pending: Promise<void> | undefined;
  const prepare = async (
    catalog: ModelCatalogSnapshot,
    reason: "discovery" | "routine" | "manual",
    assertCurrent: () => void,
    requestSignal?: AbortSignal,
  ) => {
    const prepared = await prepareCliModelCatalog({
      catalog: {
        ...catalog,
        cliRuntimeCompatibility: compatibility,
        staticEntries: [
          ...(catalog.staticEntries ?? []),
          ...params.catalogFacts.modelCatalog.entries,
          ...(params.catalogFacts.modelCatalog.staticEntries ?? []),
        ],
      },
      backends:
        params.pluginGeneration.pluginRegistry?.cliBackends.map(({ backend }) => backend) ?? [],
      config: params.agentFacts.input.config,
      agentId: params.agentFacts.input.agentId,
      authModes: getPreparedModelFullCatalogAuth(catalog)?.authModes ?? initialAuth.authModes,
      configuredModelRefs: params.agentFacts.configuredModelRefs,
      env: params.agentFacts.env,
      cwd: params.agentFacts.input.workspaceDir ?? params.agentFacts.input.agentDir,
      reason,
      signal: requestSignal
        ? AbortSignal.any([params.retirementSignal, requestSignal])
        : params.retirementSignal,
      assertCurrent,
    });
    assertCurrent();
    compatibility = Object.keys(prepared).length ? prepared : undefined;
  };
  const isManualRefresh = (options?: PreparedModelCatalogRefreshOptions) =>
    Boolean(
      options?.cliCompatibilityRefresh ||
      (options?.refresh && params.inventoryOwner.provenance === "standalone"),
    );
  return {
    prepare,
    isManualRefresh,
    async prepareRefresh(
      catalog: ModelCatalogSnapshot,
      options: PreparedModelCatalogRefreshOptions,
      assertCurrent: () => void,
    ) {
      const request = options.cliCompatibilityRefresh;
      // Cancelling this reader must not cancel the shared renewal it was waiting for.
      await racePromiseWithAbortSignal(pending ?? Promise.resolve(), request?.signal);
      await prepare(
        catalog,
        isManualRefresh(options) ? "manual" : "discovery",
        () => {
          assertCurrent();
          request?.assertCurrent();
        },
        request?.signal,
      );
    },
    attach(catalog: ModelCatalogSnapshot) {
      if (compatibility) {
        catalog.cliRuntimeCompatibility = compatibility;
      }
      // Preserve snapshot identity: full-catalog and auth observations use WeakMaps.
      return catalog;
    },
    renewIfExpired(options: {
      catalog: ModelCatalogSnapshot;
      now: number;
      assertCurrent: () => void;
      publish: () => void;
      failed: (error: unknown) => void;
    }) {
      if (
        pending ||
        !Object.values(compatibility ?? {}).some(
          (result) => result.nextCheckAt !== undefined && result.nextCheckAt <= options.now,
        )
      ) {
        return;
      }
      const promise = (async () => {
        await using _ = {
          [Symbol.asyncDispose]: retainPreparedPluginGeneration(params.pluginGeneration),
        };
        await prepare(options.catalog, "routine", options.assertCurrent);
        options.assertCurrent();
        options.publish();
      })()
        .catch(options.failed)
        .finally(() => {
          if (pending === promise) {
            pending = undefined;
          }
        });
      pending = promise;
    },
  };
}
