/**
 * Sandbox backend registry.
 *
 * Stores process-wide backend factories so core and plugins can register local container, SSH, or custom sandbox providers.
 */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
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

type SandboxBackendRegistrationGeneration = {
  registration: RegisteredSandboxBackend;
  previous: SandboxBackendRegistrationGeneration | undefined;
  retired: boolean;
};

// Only explicit overrides need process-wide generations. Built-in defaults stay
// module-local so repeated imports neither retain old graphs nor replace overrides.
function getSandboxBackendFactories(): Map<SandboxBackendId, SandboxBackendRegistrationGeneration> {
  const globalStore = globalThis as typeof globalThis & {
    [SANDBOX_BACKEND_FACTORIES_STATE_KEY]?: Map<
      SandboxBackendId,
      SandboxBackendRegistrationGeneration
    >;
  };
  globalStore[SANDBOX_BACKEND_FACTORIES_STATE_KEY] ??= new Map();
  return globalStore[SANDBOX_BACKEND_FACTORIES_STATE_KEY];
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
  const generation: SandboxBackendRegistrationGeneration = {
    registration: resolved,
    previous: factories.get(normalizedId),
    retired: false,
  };
  factories.set(normalizedId, generation);
  return () => {
    if (generation.retired) {
      return;
    }
    generation.retired = true;
    if (factories.get(normalizedId) !== generation) {
      return;
    }
    // Older disposers can run before newer plugin generations retire. Skip
    // every retired predecessor so stale sandbox authority never returns.
    let previous = generation.previous;
    while (previous?.retired) {
      previous = previous.previous;
    }
    if (previous) {
      factories.set(normalizedId, previous);
      return;
    }
    factories.delete(normalizedId);
  };
}

/** Look up a sandbox backend factory by normalized backend id. */
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

/** Look up optional lifecycle management hooks for a registered backend. */
export function getSandboxBackendManager(id: string): SandboxBackendManager | null {
  return resolveSandboxBackendRegistration(id)?.manager ?? null;
}

/** Include legacy rows in the lifecycle selected by the currently registered backend. */
export function usesSandboxRuntimeReservations(id: string): boolean {
  return resolveSandboxBackendRegistration(id)?.reserveRuntimeId !== undefined;
}

/** Look up optional backend workdir resolution that does not start the runtime. */
export function getSandboxBackendWorkdirResolver(id: string): SandboxBackendWorkdirResolver | null {
  return resolveSandboxBackendRegistration(id)?.resolveWorkdir ?? null;
}

/** Resolve a backend factory or throw the user-facing configuration error. */
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
): Promise<SandboxBackendHandle> {
  const factory = requireSandboxBackendFactory(params.cfg.backend);
  const reserveRuntimeId = resolveSandboxBackendRegistration(params.cfg.backend)?.reserveRuntimeId;
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
    const backend = await factory(params);
    await updateRegistry(toEntry(backend));
    return backend;
  }
  for (let attempt = 0; ; attempt++) {
    const reservation = reserveSandboxRegistryEntry({
      containerName: reserveRuntimeId(params),
      backendId: params.cfg.backend,
      sessionKey: params.scopeKey,
      createdAtMs: Date.now(),
      lastUsedAtMs: Date.now(),
      image: params.cfg.docker.image,
      workspaceDir: params.workspaceDir,
    });
    try {
      return await withSandboxRegistryEntryLock(reservation, async () => {
        assertSandboxRegistryEntryCurrent(reservation);
        try {
          const backend = await factory({
            ...params,
            workspaceDir: reservation.workspaceDir ?? params.workspaceDir,
            runtimeId: reservation.containerName,
            assertRuntimeCurrent: () => assertSandboxRegistryEntryCurrent(reservation),
          });
          if (
            backend.runtimeId !== reservation.containerName ||
            backend.id !== reservation.backendId
          ) {
            throw new Error("Sandbox backend returned a runtime outside its reserved generation.");
          }
          completeSandboxRegistryReservation(toEntry(backend));
          return backend;
        } catch (error) {
          if (
            error instanceof SandboxRuntimeRetiredError &&
            error.runtimeId === reservation.containerName
          ) {
            completeSandboxRegistryReservation(reservation, true);
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
});
builtinSandboxBackends.set("podman", {
  factory: createPodmanSandboxBackend,
  manager: podmanSandboxBackendManager,
  resolveWorkdir: ({ cfg }) => cfg.docker.workdir,
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
    getSandboxBackendFactories().get(normalizedId)?.registration ??
    builtinSandboxBackends.get(normalizedId)
  );
}
