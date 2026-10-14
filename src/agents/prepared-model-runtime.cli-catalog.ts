import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { readCliRuntimeGeneration } from "./cli-runner/runtime-maintenance.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import {
  prepareCliModelCatalog,
  type PreparedCliModelCatalogReason,
} from "./prepared-cli-model-catalog.js";
import {
  getPreparedModelFullCatalogAuth,
  type PreparedModelCatalogAuth,
} from "./prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeCatalogAccessParams } from "./prepared-model-runtime.catalog-contract.js";
import { retainPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";
import type {
  PreparedModelCatalogInventory,
  PreparedModelCatalogRefreshOptions,
} from "./prepared-model-runtime.types.js";

/** Own compatibility observations and request-driven renewal for one prepared generation. */
export function createPreparedCliModelCatalogAccess(
  params: PreparedModelRuntimeCatalogAccessParams,
  initialAuth: PreparedModelCatalogAuth,
) {
  let compatibility = params.catalogFacts.modelCatalog.cliRuntimeCompatibility;
  let pending: Promise<boolean> | undefined;
  const prepare = async (
    catalog: ModelCatalogSnapshot,
    reason: PreparedCliModelCatalogReason,
    assertCurrent: () => void,
    requestSignal?: AbortSignal,
  ) => {
    const backends =
      params.pluginGeneration.pluginRegistry?.cliBackends.map(({ backend }) => backend) ?? [];
    const generations = backends.map((backend) => readCliRuntimeGeneration(backend.id));
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
      backends,
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
    return backends.some(
      (backend, index) => readCliRuntimeGeneration(backend.id) !== generations[index],
    );
  };
  // Request-bound maintenance must finish before its caller releases authority.
  const isManualRefresh = (options?: PreparedModelCatalogRefreshOptions) =>
    Boolean(
      options?.cliCompatibilityRefresh ||
      (options?.refresh && params.inventoryOwner.provenance === "standalone"),
    );
  const prepareForRequest = (
    catalog: ModelCatalogSnapshot,
    options: PreparedModelCatalogRefreshOptions,
    assertCurrent: () => void,
    reason: PreparedCliModelCatalogReason,
  ) => {
    const request = options.cliCompatibilityRefresh;
    return prepare(
      catalog,
      reason,
      () => {
        assertCurrent();
        request?.assertCurrent();
      },
      request?.signal,
    );
  };
  return {
    prepare,
    isManualRefresh,
    async loadCatalog<T extends { modelCatalog: ModelCatalogSnapshot }>({
      catalog,
      options,
      assertCurrent,
      refresh,
      load,
    }: {
      catalog: ModelCatalogSnapshot;
      options: PreparedModelCatalogRefreshOptions;
      assertCurrent: () => void;
      refresh: boolean;
      load: (refreshResponses: boolean) => Promise<T>;
    }): Promise<{ catalog: T; runtimeChanged: boolean }> {
      const request = options.cliCompatibilityRefresh;
      // Cancelling this reader must not cancel the shared renewal it was waiting for.
      await racePromiseWithAbortSignal(pending ?? Promise.resolve(false), request?.signal);
      const generations = isManualRefresh(options)
        ? new Map(
            (params.pluginGeneration.pluginRegistry?.cliBackends ?? []).map(({ backend }) => [
              backend.id,
              readCliRuntimeGeneration(backend.id),
            ]),
          )
        : undefined;
      // Keep manual intent until this backend attempts maintenance. Newly discovered
      // requirements can bypass an earlier cooldown without repeating a failed repair.
      const reason: PreparedCliModelCatalogReason = (backendId) =>
        generations?.get(backendId) === readCliRuntimeGeneration(backendId)
          ? "manual"
          : "discovery";
      // The native CLI menu describes the installed binary. Finish known repairs before
      // discovery so a successful manual retry publishes the upgraded menu in this response.
      let runtimeChanged = await prepareForRequest(catalog, options, assertCurrent, reason);
      let discovered = await load(refresh || runtimeChanged);
      assertCurrent();
      // Newly discovered rows can introduce another requirement. Never publish a menu
      // captured before that repair; each backend retains cooldowns after its first attempt.
      while (await prepareForRequest(discovered.modelCatalog, options, assertCurrent, reason)) {
        runtimeChanged = true;
        discovered = await load(true);
        assertCurrent();
      }
      return { catalog: discovered, runtimeChanged };
    },
    attach(catalog: ModelCatalogSnapshot) {
      if (compatibility) {
        catalog.cliRuntimeCompatibility = compatibility;
      }
      // Preserve snapshot identity: full-catalog and auth observations use WeakMaps.
      return catalog;
    },
    createExpiryRefresh(options: {
      assertCurrent: () => void;
      recheckNativeLogin: () => void;
      readInventory: () => PreparedModelCatalogInventory | undefined;
      readCatalog: () => ModelCatalogSnapshot;
      acquire: (providerIds?: readonly string[], runtimeChanged?: boolean) => Promise<unknown>;
      publish: () => void | Promise<void>;
      failed: (error: unknown) => void;
    }) {
      return () => {
        options.assertCurrent();
        options.recheckNativeLogin();
        const inventory = options.readInventory();
        if (!inventory) {
          return;
        }
        const now = Date.now();
        const providers = [...inventory.providers]
          .filter(([, { expiresAt }]) => expiresAt !== undefined && expiresAt <= now)
          .map(([provider]) => provider);
        if (providers.length) {
          void options.acquire(providers).catch(() => undefined);
          return;
        }
        if (
          pending ||
          !Object.values(compatibility ?? {}).some(
            (result) => result.nextCheckAt !== undefined && result.nextCheckAt <= now,
          )
        ) {
          return;
        }
        const release = retainPreparedPluginGeneration(params.pluginGeneration);
        const preparation = prepare(options.readCatalog(), "routine", options.assertCurrent);
        pending = preparation;
        void (async () => {
          await using _ = { [Symbol.asyncDispose]: release };
          try {
            const runtimeChanged = await preparation;
            options.assertCurrent();
            // Acquisition may already be waiting for this preparation. It must not
            // wait for publication too, because publication can join that acquisition.
            if (pending === preparation) {
              pending = undefined;
            }
            if (runtimeChanged) {
              await options.acquire(undefined, true);
            } else {
              await options.publish();
            }
          } finally {
            if (pending === preparation) {
              pending = undefined;
            }
          }
        })().catch(options.failed);
      };
    },
  };
}
