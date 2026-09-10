import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isPathInside } from "../../infra/path-guards.js";
import type { SandboxBackendInternalMount } from "./backend.types.js";
import { splitSandboxBindSpec } from "./bind-spec.js";
import { execContainer, type SandboxContainerEngine } from "./container-engine.js";
import {
  parseInspectedSandboxMounts,
  resolveDockerSourceNamespace,
  translateSandboxMountSources,
} from "./docker-mount-source.js";
import { getSandboxHostPathPolicyKey } from "./host-paths.js";
import type { SandboxWorkspaceAccess } from "./types.js";
import {
  filterBindsConflictingWithProtectedMounts,
  normalizeMountContainerPath,
  resolveMaterializedSandboxSkillsWorkspaceDir,
  resolveProtectedSkillMountContainerPaths,
  resolveReadOnlyWorkspaceSkillMounts,
  resolveWorkspaceMounts,
} from "./workspace-mounts.js";

export type SandboxMountPlan = {
  binds: string[];
  skippedBinds: string[];
  readOnlyWorkspaceSkillMounts: ReturnType<typeof resolveReadOnlyWorkspaceSkillMounts>;
};

export async function prepareSandboxMountPlan(params: {
  engine: SandboxContainerEngine;
  workspaceDir: string;
  agentWorkspaceDir: string;
  skillsWorkspaceDir?: string;
  workdir: string;
  workspaceAccess: SandboxWorkspaceAccess;
  binds?: readonly string[];
  internalMounts?: readonly SandboxBackendInternalMount[];
}): Promise<SandboxMountPlan> {
  const readOnlyWorkspaceSkillMounts = resolveReadOnlyWorkspaceSkillMounts(params);
  const managed = resolveWorkspaceMounts({ ...params, readOnlyWorkspaceSkillMounts });
  const namespace = await resolveDockerSourceNamespace(params.engine);
  const allowedRoots = [
    params.workspaceDir,
    params.agentWorkspaceDir,
    params.skillsWorkspaceDir ??
      resolveMaterializedSandboxSkillsWorkspaceDir(params.agentWorkspaceDir),
    ...(params.internalMounts ?? []).map((mount) => mount.hostPath),
  ];
  const protectedTargets = resolveProtectedSkillMountContainerPaths(readOnlyWorkspaceSkillMounts);
  for (const mount of params.internalMounts ?? []) {
    protectedTargets.add(normalizeMountContainerPath(mount.containerPath));
  }
  const custom = filterBindsConflictingWithProtectedMounts(params.binds, protectedTargets);
  const overriddenTargets = new Set(
    custom.flatMap((bind) => {
      const parsed = splitSandboxBindSpec(bind);
      return parsed ? [normalizeMountContainerPath(parsed.container)] : [];
    }),
  );
  const targets = [
    ...overriddenTargets,
    ...managed.map((mount) => normalizeMountContainerPath(mount.containerPath)),
    ...(params.internalMounts ?? []).map((mount) =>
      normalizeMountContainerPath(mount.containerPath),
    ),
  ];
  const binds = new Map<string, string>();
  for (const mount of managed) {
    const target = normalizeMountContainerPath(mount.containerPath);
    if (overriddenTargets.has(target)) {
      continue;
    }
    const translated = namespace
      ? translateSandboxMountSources({
          source: mount.hostPath,
          containerPath: target,
          allowedRoots,
          mounts: namespace,
          readOnly: mount.readOnly,
          shadowedTargets: targets.filter(
            (other) => other !== target && isPathInside(target, other),
          ),
        })
      : [{ ...mount, containerPath: target }];
    for (const projected of translated) {
      binds.set(
        projected.containerPath,
        `${projected.hostPath}:${projected.containerPath}:${projected.readOnly ? "ro,z" : "z"}`,
      );
    }
  }
  for (const mount of params.internalMounts ?? []) {
    const target = normalizeMountContainerPath(mount.containerPath);
    const translated = namespace
      ? translateSandboxMountSources({
          source: mount.hostPath,
          containerPath: target,
          allowedRoots,
          mounts: namespace,
          readOnly: mount.readOnly,
          shadowedTargets: targets.filter(
            (other) => other !== target && isPathInside(target, other),
          ),
        })
      : [{ ...mount, containerPath: target }];
    for (const projected of translated) {
      binds.set(
        projected.containerPath,
        `${projected.hostPath}:${projected.containerPath}:${projected.readOnly ? "ro,z" : "z"}`,
      );
    }
  }
  // Custom mounts retain their daemon-host contract. Protected instruction mounts
  // win exact collisions; other explicit overrides match filesystem bridge policy.
  for (const bind of custom) {
    const parsed = splitSandboxBindSpec(bind);
    binds.set(parsed ? normalizeMountContainerPath(parsed.container) : bind, bind);
  }
  return {
    binds: [...binds.values()],
    skippedBinds: (params.binds ?? []).filter((bind) => !custom.includes(bind)),
    readOnlyWorkspaceSkillMounts,
  };
}

export async function sandboxMountPlanMatchesContainer(params: {
  engine: SandboxContainerEngine;
  containerName: string;
  plan: SandboxMountPlan;
}): Promise<boolean> {
  const inspected = await execContainer(
    params.engine,
    [
      "inspect",
      "--format",
      '{"Mounts":{{json .Mounts}},"Tmpfs":{{json .HostConfig.Tmpfs}}}',
      params.containerName,
    ],
    { signal: AbortSignal.timeout(5_000) },
  );
  const data: unknown = JSON.parse(inspected.stdout);
  if (!isRecord(data)) {
    throw new Error("Container inspect did not return mount metadata.");
  }
  const actual = parseInspectedSandboxMounts(data.Mounts, data.Tmpfs);
  const expected = new Map(
    params.plan.binds.flatMap((bind) => {
      const parsed = splitSandboxBindSpec(bind);
      if (!parsed) {
        return [];
      }
      return [[normalizeMountContainerPath(parsed.container), parsed]] as const;
    }),
  );
  // Compare the whole effective bind set, including removed custom/subtree mounts.
  // Image-created volumes are unrelated unless they occupy an expected bind target.
  const managed = actual.filter(
    (mount) => mount.type === "bind" || expected.has(mount.destination),
  );
  return (
    managed.length === expected.size &&
    managed.every((mount) => {
      const bind = expected.get(mount.destination);
      return (
        bind !== undefined &&
        mount.type === "bind" &&
        getSandboxHostPathPolicyKey(mount.source) === getSandboxHostPathPolicyKey(bind.host) &&
        mount.writable === !bind.options.split(",").includes("ro")
      );
    })
  );
}
