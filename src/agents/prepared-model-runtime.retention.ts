import type { PluginRegistry } from "../plugins/registry-types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { normalizeAgentDirRegistryPath } from "./agent-dir-registry.js";
import { retirePreparedModelRuntimeGeneration } from "./prepared-model-runtime.lifecycle.js";
import {
  releasePreparedPluginPublication,
  retainPreparedPluginGeneration,
} from "./prepared-model-runtime.plugin-lifetime.js";
import type { PreparedModelRuntimeOwner } from "./prepared-model-runtime.types.js";
import type { PreparedReplyDispatchPublicationOwner } from "./prepared-reply-dispatch-runtime.js";

export type AgentRuntimeRetirement = { agentId: string; agentDirs: readonly string[] };

export async function retirePreparedModelRuntimeAgentOwners(
  target: AgentRuntimeRetirement,
  context: {
    owners: Map<string, PreparedModelRuntimeOwner>;
    agentBuildCompletions: ReadonlyMap<string, Promise<void>>;
    replyDispatchPublication: PreparedReplyDispatchPublicationOwner;
  },
): Promise<void> {
  const targetId = normalizeAgentId(target.agentId);
  const targetDirs = new Set(
    target.agentDirs.map((agentDir) => normalizeAgentDirRegistryPath(agentDir)),
  );
  const retiredAgentDirs = new Set<string>();
  const configuredAgentIds = new Set<string>();
  for (const [key, owner] of context.owners) {
    if (
      !owner.input.agentId ||
      normalizeAgentId(owner.input.agentId) !== targetId ||
      !targetDirs.has(normalizeAgentDirRegistryPath(owner.input.agentDir, owner.input.env))
    ) {
      continue;
    }
    context.owners.delete(key);
    owner.generation += 1;
    retirePreparedModelRuntimeGeneration(owner);
    releasePreparedPluginPublication(owner);
    retiredAgentDirs.add(owner.input.agentDir);
    if (owner.provenance === "configured") {
      configuredAgentIds.add(targetId);
    }
  }
  context.replyDispatchPublication.remove(configuredAgentIds);
  const pendingBuilds = [...retiredAgentDirs]
    .map((agentDir) => context.agentBuildCompletions.get(agentDir))
    .filter((completion) => completion !== undefined);
  await Promise.all(pendingBuilds);
}

export function retirePreparedModelRuntimeOwnerIfUnused(
  owners: Map<string, PreparedModelRuntimeOwner>,
  key: string,
  owner: PreparedModelRuntimeOwner,
  retained = false,
): void {
  if (
    (owner.provenance === "run" || owner.provenance === "ephemeral") &&
    (owner.admissionCount ?? 0) === 0 &&
    (owner.leaseCount ?? 0) === 0 &&
    !retained
  ) {
    if (owners.get(key) === owner) {
      owners.delete(key);
    }
    retirePreparedModelRuntimeGeneration(owner);
    releasePreparedPluginPublication(owner);
  }
}

export class PreparedModelRuntimeOwnerRetention {
  readonly #retained = new Map<string, PreparedModelRuntimeOwner>();
  constructor(private readonly maxSize: number) {}

  clear(owners: Map<string, PreparedModelRuntimeOwner>): void {
    // Released run owners retire here; active leases retire on release.
    for (const [key, owner] of this.#retained) {
      retirePreparedModelRuntimeOwnerIfUnused(owners, key, owner);
    }
    this.#retained.clear();
  }

  has(key: string, owner: PreparedModelRuntimeOwner): boolean {
    return this.#retained.get(key) === owner;
  }

  retain(
    key: string,
    owner: PreparedModelRuntimeOwner,
    owners: Map<string, PreparedModelRuntimeOwner>,
  ): void {
    if (owner.provenance !== "run") {
      return;
    }
    this.#retained.delete(key);
    this.#retained.set(key, owner);
    while (this.#retained.size > this.maxSize) {
      const oldest = this.#retained.entries().next().value;
      if (!oldest) {
        return;
      }
      const [oldestKey, oldestOwner] = oldest;
      this.#retained.delete(oldestKey);
      retirePreparedModelRuntimeOwnerIfUnused(owners, oldestKey, oldestOwner);
    }
  }
}

export type AgentRuntimeCleanupRegistries = {
  registries: readonly PluginRegistry[];
  [Symbol.asyncDispose](): Promise<void>;
};

export async function acquireRetainedAgentRuntimeCleanupRegistries(
  agentDir: string | undefined,
  context: {
    owners: ReadonlyMap<string, PreparedModelRuntimeOwner>;
    retainedGatewayRunOwners: PreparedModelRuntimeOwnerRetention;
    retainedDirectRunOwners: PreparedModelRuntimeOwnerRetention;
  },
): Promise<AgentRuntimeCleanupRegistries> {
  const registries = new Set<PluginRegistry>();
  const releases: Array<() => Promise<void>> = [];
  try {
    for (const [key, owner] of context.owners) {
      const generation = owner.pluginGeneration;
      const registry = generation?.pluginRegistry;
      if (
        owner.input.agentDir !== agentDir ||
        owner.input.readOnly ||
        owner.provenance === "ephemeral" ||
        !generation ||
        !registry ||
        registries.has(registry) ||
        (owner.provenance === "run" &&
          !owner.leaseCount &&
          !context.retainedGatewayRunOwners.has(key, owner) &&
          !context.retainedDirectRunOwners.has(key, owner))
      ) {
        continue;
      }
      releases.push(retainPreparedPluginGeneration(generation));
      registries.add(registry);
    }
  } catch (error) {
    await Promise.allSettled(releases.map((release) => release()));
    throw error;
  }
  return {
    registries: [...registries],
    async [Symbol.asyncDispose]() {
      await Promise.all(releases.map((release) => release()));
    },
  };
}
