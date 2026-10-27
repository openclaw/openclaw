import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { observeDiagnosticsTimelinePhases } from "../../infra/diagnostics-timeline.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import type { AdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import type { PreparedGitHubToolEnvironment } from "../github-tool-identity.types.js";
import type { WorkspaceStateGuard } from "../workspace-state-store.worker-contract.js";
import type { SandboxBackendHandle } from "./backend-handle.types.js";
import type {
  CreateSandboxBackendParams,
  RegisteredSandboxBackend,
  SandboxBackendFactory,
  SandboxBackendId,
  SandboxBackendManager,
  SandboxBackendRegistration,
  SandboxBackendWorkdirResolver,
} from "./backend.types.js";
import {
  createDockerSandboxBackend,
  createPodmanSandboxBackend,
  dockerSandboxBackendManager,
  podmanSandboxBackendManager,
} from "./docker-backend.js";
import { SandboxRuntimeRetiredError } from "./provisioning-error.js";
import {
  assertSandboxRegistryEntryCurrent,
  completeSandboxRegistryReservation,
  readRegisteredSandboxRuntimeIds,
  reserveSandboxRegistryEntry,
  updateRegistry,
  withSandboxRegistryEntryLock,
  type SandboxRegistryEntry,
} from "./registry.js";
import {
  createSshSandboxBackend,
  resolveSshRuntimePaths,
  sshSandboxBackendManager,
} from "./ssh-backend.js";

export type {
  CreateSandboxBackendParams,
  CreateReservedSandboxBackendParamsV1,
  ReservedSandboxBackendFactoryV1,
  SandboxBackendFactory,
  SandboxBackendId,
  SandboxBackendManager,
  SandboxBackendRegistration,
  SandboxBackendRuntimeInfo,
  SandboxBackendWorkdirValidation,
  SandboxBackendWorkdirResolver,
} from "./backend.types.js";
export type {
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
  SandboxBackendExecSpec,
  SandboxBackendHandle,
  SandboxBackendPreparedWorkdirDiscarder,
  SandboxBackendWorkdirValidator,
} from "./backend-handle.types.js";

const SANDBOX_BACKEND_FACTORIES_STATE_KEY = Symbol.for("openclaw.sandboxBackendFactories");

type SandboxBackendRegistrationEntry = {
  registration: RegisteredSandboxBackend;
};

// Only explicit overrides need a process-wide stack. Built-in defaults stay
// module-local so repeated imports neither retain old graphs nor replace overrides.
function getSandboxBackendFactories(): Map<SandboxBackendId, SandboxBackendRegistrationEntry[]> {
  return resolveGlobalMap(SANDBOX_BACKEND_FACTORIES_STATE_KEY);
}

function normalizeSandboxBackendId(id: string): SandboxBackendId {
  const normalized = normalizeOptionalLowercaseString(id);
  if (!normalized) {
    throw new Error("Sandbox backend id must not be empty.");
  }
  return normalized;
}

/** Register or replace a sandbox backend and return a restore callback. */
export function registerSandboxBackend(
  id: string,
  registration: SandboxBackendRegistration,
): () => void {
  const normalizedId = normalizeSandboxBackendId(id);
  const resolved = typeof registration === "function" ? { factory: registration } : registration;
  const factories = getSandboxBackendFactories();
  const registrations = factories.get(normalizedId) ?? [];
  const entry = { registration: resolved };
  registrations.push(entry);
  factories.set(normalizedId, registrations);
  return () => {
    const index = registrations.indexOf(entry);
    if (index < 0) {
      return;
    }
    registrations.splice(index, 1);
    if (registrations.length === 0) {
      factories.delete(normalizedId);
    }
  };
}

export function getSandboxBackendFactory(id: string): SandboxBackendFactory | null {
  const registration = resolveSandboxBackendRegistration(id);
  if (!registration) {
    return null;
  }
  if (!registration.reserveRuntimeId) {
    return registration.factory;
  }
  const factory = registration.factory;
  return async (params) => {
    const { runtimeId, assertRuntimeCurrent } = params;
    if (!runtimeId || !assertRuntimeCurrent) {
      throw new Error(
        `Sandbox backend "${id}" requires a registry-reserved runtime and its current owner.`,
      );
    }
    assertRuntimeCurrent();
    return factory({ ...params, runtimeId, assertRuntimeCurrent });
  };
}

export function getSandboxBackendManager(id: string): SandboxBackendManager | null {
  return resolveSandboxBackendRegistration(id)?.manager ?? null;
}

/** Include legacy rows in the lifecycle selected by the currently registered backend. */
export function usesSandboxRuntimeReservations(id: string): boolean {
  return resolveSandboxBackendRegistration(id)?.reserveRuntimeId !== undefined;
}

export function getSandboxBackendWorkdirResolver(id: string): SandboxBackendWorkdirResolver | null {
  return resolveSandboxBackendRegistration(id)?.resolveWorkdir ?? null;
}

/** Read static backend capabilities without provisioning a sandbox runtime. */
export function getSandboxBackendCapabilities(
  id: string,
): RegisteredSandboxBackend["capabilities"] | undefined {
  return resolveSandboxBackendRegistration(id)?.capabilities;
}

export function requireSandboxBackendFactory(id: string): SandboxBackendFactory {
  const factory = getSandboxBackendFactory(id);
  if (factory) {
    return factory;
  }
  throw new Error(
    [
      `Sandbox backend "${id}" is not registered.`,
      "Load the plugin that provides it, or set agents.defaults.sandbox.backend=docker.",
    ].join("\n"),
  );
}

/** Create and publish a backend, reserving provider IDs only for opted-in factories. */
export async function createSandboxBackend(
  params: CreateSandboxBackendParams,
  operatorAuthority?: AdmittedRunOperatorAuthority,
  githubIdentity?: PreparedGitHubToolEnvironment,
  guard?: WorkspaceStateGuard,
): Promise<SandboxBackendHandle> {
  params.assertRuntimeCurrent?.();
  let factory = requireSandboxBackendFactory(params.cfg.backend);
  if (
    githubIdentity &&
    factory !== createDockerSandboxBackend &&
    factory !== createPodmanSandboxBackend
  ) {
    throw new Error("Sandbox GitHub identity requires the built-in Docker or Podman backend.");
  }
  let preparedParams = params;
  if (
    factory !== createDockerSandboxBackend &&
    factory !== createPodmanSandboxBackend &&
    params.registeredRuntimeIds === undefined
  ) {
    using _ = observeDiagnosticsTimelinePhases("attempt.setup.sandbox.backend.runtime_ids");
    const registeredRuntimeIds = await readRegisteredSandboxRuntimeIds({
      backendId: params.cfg.backend,
      scopeKey: params.scopeKey,
    });
    params.assertRuntimeCurrent?.();
    if (registeredRuntimeIds.length > 0) {
      preparedParams = { ...params, registeredRuntimeIds };
    }
    // Discovery can outlive a plugin registration; dispatch only its current factory.
    factory = requireSandboxBackendFactory(params.cfg.backend);
  }
  // Built-in containers publish their complete allocation under the lifecycle lock.
  if (factory === createDockerSandboxBackend) {
    return await createDockerSandboxBackend(preparedParams, operatorAuthority, githubIdentity);
  }
  if (factory === createPodmanSandboxBackend) {
    return await createPodmanSandboxBackend(preparedParams, operatorAuthority, githubIdentity);
  }
  const reserveRuntimeId = resolveSandboxBackendRegistration(params.cfg.backend)?.reserveRuntimeId;
  using phases = observeDiagnosticsTimelinePhases("attempt.setup.sandbox.backend.factory");
  const toEntry = (backend: SandboxBackendHandle): SandboxRegistryEntry => ({
    containerName: backend.runtimeId,
    backendId: backend.id,
    runtimeLabel: backend.runtimeLabel,
    sessionKey: params.scopeKey,
    createdAtMs: Date.now(),
    lastUsedAtMs: Date.now(),
    image: backend.configLabel ?? params.cfg.docker.image,
    configLabelKind: backend.configLabelKind ?? "Image",
  });
  if (!reserveRuntimeId) {
    const backend = await factory(preparedParams);
    phases.mark("attempt.setup.sandbox.backend.registry_publish");
    await updateRegistry(toEntry(backend), {
      ...guard,
      beforeLegacyApply: params.assertRuntimeCurrent,
    });
    return backend;
  }
  for (let attempt = 0; ; attempt++) {
    params.assertRuntimeCurrent?.();
    phases.mark("attempt.setup.sandbox.backend.reservation");
    const reservation = await reserveSandboxRegistryEntry(
      {
        containerName: reserveRuntimeId(preparedParams),
        backendId: params.cfg.backend,
        sessionKey: params.scopeKey,
        createdAtMs: Date.now(),
        lastUsedAtMs: Date.now(),
        image: params.cfg.docker.image,
        workspaceDir: params.workspaceDir,
      },
      { ...guard, beforeLegacyApply: params.assertRuntimeCurrent },
    );
    try {
      phases.mark("attempt.setup.sandbox.backend.registry_lock_wait");
      return await withSandboxRegistryEntryLock(reservation, async () => {
        phases.mark("attempt.setup.sandbox.backend.factory");
        const assertCurrent = () => {
          params.assertRuntimeCurrent?.();
          assertSandboxRegistryEntryCurrent(reservation);
        };
        try {
          const backend = await factory({
            ...preparedParams,
            workspaceDir: reservation.workspaceDir ?? params.workspaceDir,
            runtimeId: reservation.containerName,
            assertRuntimeCurrent: assertCurrent,
          });
          if (
            backend.runtimeId !== reservation.containerName ||
            backend.id !== reservation.backendId
          ) {
            throw new Error("Sandbox backend returned a runtime outside its reserved generation.");
          }
          phases.mark("attempt.setup.sandbox.backend.reservation_complete");
          await completeSandboxRegistryReservation(
            { ...reservation, ...toEntry(backend), createdAtMs: reservation.createdAtMs },
            false,
            { ...guard, beforeLegacyApply: params.assertRuntimeCurrent },
          );
          return backend;
        } catch (error) {
          if (
            error instanceof SandboxRuntimeRetiredError &&
            error.runtimeId === reservation.containerName
          ) {
            phases.mark("attempt.setup.sandbox.backend.reservation_retire");
            await completeSandboxRegistryReservation(reservation, true, {
              ...guard,
              beforeLegacyApply: params.assertRuntimeCurrent,
            });
          }
          throw error;
        }
      });
    } catch (error) {
      if (
        !(error instanceof SandboxRuntimeRetiredError) ||
        error.runtimeId !== reservation.containerName ||
        attempt > 0
      ) {
        throw error;
      }
    }
  }
}

const builtinSandboxBackends = new Map<SandboxBackendId, RegisteredSandboxBackend>();
builtinSandboxBackends.set("docker", {
  factory: createDockerSandboxBackend,
  manager: dockerSandboxBackendManager,
  resolveWorkdir: ({ cfg }) => cfg.docker.workdir,
  capabilities: { readOnlyResourceMounts: true },
});
builtinSandboxBackends.set("podman", {
  factory: createPodmanSandboxBackend,
  manager: podmanSandboxBackendManager,
  resolveWorkdir: ({ cfg }) => cfg.docker.workdir,
  capabilities: { readOnlyResourceMounts: true },
});
builtinSandboxBackends.set("ssh", {
  factory: createSshSandboxBackend,
  manager: sshSandboxBackendManager,
  resolveWorkdir: ({ cfg, scopeKey }) =>
    resolveSshRuntimePaths(cfg.ssh.workspaceRoot, scopeKey).remoteWorkspaceDir,
});

function resolveSandboxBackendRegistration(id: string): RegisteredSandboxBackend | undefined {
  const normalizedId = normalizeSandboxBackendId(id);
  return (
    getSandboxBackendFactories().get(normalizedId)?.at(-1)?.registration ??
    builtinSandboxBackends.get(normalizedId)
  );
}
