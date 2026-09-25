import type {
  DelegatedParameterUnsupported,
  DelegatedSandboxRestriction,
} from "../inherited-tool-parameters.types.js";
import type { SandboxConfig } from "./types.js";

/** Resource identities cannot serve as portable sandbox predicates. */
export function captureDelegatedSandboxRestriction(config: SandboxConfig): {
  restriction?: DelegatedSandboxRestriction;
  unsupported?: DelegatedParameterUnsupported;
} {
  if (config.backend !== "docker" && config.backend !== "podman") {
    return { unsupported: { scope: "sandbox", reason: "sandbox-backend" } };
  }
  const docker = config.docker;
  if (
    !["none", "bridge"].includes(docker.network) ||
    docker.binds?.length ||
    config.browser.binds?.length ||
    config.browser.enabled ||
    docker.user ||
    docker.setupCommand ||
    docker.seccompProfile ||
    docker.apparmorProfile ||
    docker.dns?.length ||
    docker.extraHosts?.length ||
    docker.gpus ||
    docker.ulimits ||
    docker.pidsLimit !== undefined ||
    docker.memory !== undefined ||
    docker.memorySwap !== undefined ||
    docker.cpus !== undefined ||
    docker.dangerouslyAllowContainerNamespaceJoin ||
    docker.dangerouslyAllowExternalBindSources ||
    docker.dangerouslyAllowReservedContainerTargets
  ) {
    return { unsupported: { scope: "sandbox", reason: "sandbox-resource-binding" } };
  }
  return {
    restriction: {
      backend: config.backend,
      workspaceAccess: config.workspaceAccess,
      network: docker.network === "none" ? "none" : "bridge",
      readOnlyRoot: docker.readOnlyRoot,
      capDrop: [...new Set(docker.capDrop.map((entry) => entry.toUpperCase()))].toSorted(),
      tmpfs: [...docker.tmpfs],
      browserAllowHostControl: config.browser.allowHostControl,
    },
  };
}

export function isDelegatedSandboxRestrictionSatisfied(
  source: DelegatedSandboxRestriction,
  target: DelegatedSandboxRestriction,
): boolean {
  return (
    source.backend === target.backend &&
    source.workspaceAccess === target.workspaceAccess &&
    (source.network === "bridge" || target.network === "none") &&
    (!source.readOnlyRoot || target.readOnlyRoot) &&
    source.capDrop.every((cap) => target.capDrop.includes(cap) || target.capDrop.includes("ALL")) &&
    JSON.stringify(source.tmpfs) === JSON.stringify(target.tmpfs) &&
    (source.browserAllowHostControl || !target.browserAllowHostControl)
  );
}

/** Validate the receiver placement before acceptance and again against runtime preparation. */
export function assertDelegatedSandboxRestrictions(
  restrictions: readonly DelegatedSandboxRestriction[],
  target: SandboxConfig | undefined,
): void {
  if (!restrictions.length) {
    return;
  }
  const prepared = target && captureDelegatedSandboxRestriction(target);
  const restriction = prepared?.restriction;
  if (
    !restriction ||
    !restrictions.every((entry) => isDelegatedSandboxRestrictionSatisfied(entry, restriction))
  ) {
    throw new Error("Delegated sandbox requirements are unsupported by the receiver placement.");
  }
}
