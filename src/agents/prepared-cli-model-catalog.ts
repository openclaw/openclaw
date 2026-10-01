import type { ModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sanitizeHostExecEnv } from "../infra/host-env-security.js";
import type {
  CliBackendModelCatalogContext,
  CliBackendModelCatalogResult,
  CliBackendPlugin,
} from "../plugins/cli-backend.types.js";
import type { PreparedAgentCredentialModes } from "./agent-auth-credential-modes.js";
import { resolveCliBackendLaunchConfig } from "./cli-backends.js";
import {
  readCliRuntimeGeneration,
  withCliBackendMaintenance,
} from "./cli-runner/runtime-maintenance.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { resolveModelRuntimePolicy } from "./model-runtime-policy.js";

const CLI_MODEL_CATALOG_FAILURE_RETRY_MS = 60_000;

/** The prepared catalog owner, not a picker request, selects the executable and environment. */
export async function prepareCliModelCatalog(params: {
  catalog: ModelCatalogSnapshot;
  backends: readonly CliBackendPlugin[];
  config: OpenClawConfig;
  agentId?: string;
  authModes: PreparedAgentCredentialModes;
  configuredModelRefs: readonly ModelCatalogRef[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  reason: CliBackendModelCatalogContext["reason"];
  signal: AbortSignal;
  assertCurrent: () => void;
}): Promise<Readonly<Record<string, CliBackendModelCatalogResult>>> {
  const prepared = { ...params.catalog.cliRuntimeCompatibility };
  const entries = [
    ...params.catalog.entries,
    ...params.catalog.routeVariants,
    ...(params.catalog.staticEntries ?? []),
  ];
  for (const backend of params.backends) {
    if (!backend.prepareModelCatalog) {
      continue;
    }
    const runtime = normalizeProviderId(backend.id);
    const providers = new Set([runtime, normalizeProviderId(backend.modelProvider ?? runtime)]);
    const configured = params.configuredModelRefs.some(
      (ref) => normalizeProviderId(ref.provider) === runtime,
    );
    const authenticated = Object.keys(params.authModes).some(
      (provider) => normalizeProviderId(provider) === runtime,
    );
    const explicitlyRouted = entries.some(
      (entry) =>
        providers.has(normalizeProviderId(entry.provider)) &&
        normalizeProviderId(
          resolveModelRuntimePolicy({
            config: params.config,
            ...(params.agentId
              ? { agentScope: { kind: "prepared", agentId: params.agentId } }
              : {}),
            provider: entry.provider,
            modelId: entry.id,
          }).policy?.id ?? "",
        ) === runtime,
    );
    // Bundled API rows alone do not authorize maintenance of an unrelated local CLI.
    if (!authenticated && !configured && !explicitlyRouted) {
      continue;
    }
    const modelIds = [
      ...new Set(
        entries
          .filter((entry) => providers.has(normalizeProviderId(entry.provider)))
          .map((entry) => entry.id),
      ),
    ].toSorted();
    if (!modelIds.length) {
      continue;
    }
    params.signal.throwIfAborted();
    params.assertCurrent();
    try {
      const config = resolveCliBackendLaunchConfig(backend, params.config, {
        agentId: params.agentId,
      });
      params.assertCurrent();
      if (!config) {
        prepared[runtime] = {
          models: Object.fromEntries(
            modelIds.map((id) => [
              id,
              {
                available: false,
                reason:
                  "The CLI backend has no launch command. Fix its plugin configuration and refresh Models.",
              },
            ]),
          ),
        };
        continue;
      }
      const env = sanitizeHostExecEnv({
        baseEnv: params.env,
        overrides: config.env,
        blockPathOverrides: true,
      });
      for (const key of config.clearEnv ?? []) {
        delete env[key];
      }
      const result = await backend.prepareModelCatalog({
        command: config.command,
        env,
        cwd: params.cwd,
        modelIds,
        reason: params.reason,
        signal: params.signal,
        assertCurrent: params.assertCurrent,
        withMaintenance: (update) =>
          withCliBackendMaintenance(backend.id, params.signal, params.assertCurrent, update),
        runtimeGeneration: readCliRuntimeGeneration(backend.id),
      });
      params.signal.throwIfAborted();
      params.assertCurrent();
      // A plugin must establish each advertised model, including newly shipped static rows.
      prepared[runtime] = {
        ...result,
        models: {
          ...prepared[runtime]?.models,
          ...Object.fromEntries(
            modelIds.map((id) => [
              id,
              result.models[id] ?? {
                available: false,
                reason: "CLI compatibility has not been verified. Refresh Models to retry.",
              },
            ]),
          ),
        },
      };
    } catch (error) {
      params.signal.throwIfAborted();
      params.assertCurrent();
      const reason =
        error instanceof Error
          ? error.message
          : "CLI compatibility could not be verified. Refresh Models to retry.";
      prepared[runtime] = {
        models: Object.fromEntries(modelIds.map((id) => [id, { available: false, reason }])),
        // Operational failures remain unavailable, but a later inventory read can recover them.
        nextCheckAt: Date.now() + CLI_MODEL_CATALOG_FAILURE_RETRY_MS,
      };
    }
  }
  return prepared;
}
