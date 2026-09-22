import { decodeMountInfoPath } from "@openclaw/normalization-core/mountinfo-path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isPathInside } from "../../infra/path-guards.js";
import { splitSandboxBindSpec } from "./bind-spec.js";
import { execContainer, type SandboxContainerEngine } from "./container-engine.js";
import {
  parseInspectedSandboxMounts,
  resolveDockerSourceNamespace,
  translateSandboxMountSources,
} from "./docker-mount-source.js";
import { getSandboxHostPathPolicyKey } from "./host-paths.js";
import { isPathInsideContainerRoot } from "./path-utils.js";
import type { SandboxWorkspaceAccess } from "./types.js";
import {
  normalizeMountContainerPath,
  resolveMaterializedSandboxSkillsWorkspaceDir,
  resolveSandboxMountSelection,
  resolveSandboxTmpfsMounts,
} from "./workspace-mounts.js";

export type SandboxMountPlan = {
  binds: string[];
  skippedBinds: string[];
  readOnlyWorkspaceSkillMounts: ReturnType<
    typeof resolveSandboxMountSelection
  >["readOnlyWorkspaceSkillMounts"];
  tmpfs: ReturnType<typeof resolveSandboxTmpfsMounts>;
};

export async function prepareSandboxMountPlan(params: {
  engine: SandboxContainerEngine;
  workspaceDir: string;
  agentWorkspaceDir: string;
  skillsWorkspaceDir?: string;
  workdir: string;
  workspaceAccess: SandboxWorkspaceAccess;
  binds?: readonly string[];
  tmpfs?: readonly string[];
  readOnlyResourceMounts?: readonly { hostPath: string; containerPath: string }[];
}): Promise<SandboxMountPlan> {
  const selection = resolveSandboxMountSelection(params);
  const namespace = await resolveDockerSourceNamespace(params.engine);
  const allowedRoots = [
    params.workspaceDir,
    params.agentWorkspaceDir,
    params.skillsWorkspaceDir ??
      resolveMaterializedSandboxSkillsWorkspaceDir(params.agentWorkspaceDir),
    ...(params.readOnlyResourceMounts ?? []).map((mount) => mount.hostPath),
  ];
  const targets = selection.mounts.map((mount) => mount.containerPath);
  const binds = new Map<string, string>();
  for (const mount of selection.mounts) {
    const target = normalizeMountContainerPath(mount.containerPath);
    if (mount.source === "bind") {
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
  // Custom mounts retain their daemon-host contract. Protected instruction mounts
  // win exact collisions; other explicit overrides match filesystem bridge policy.
  for (const bind of selection.custom) {
    const parsed = splitSandboxBindSpec(bind);
    binds.set(parsed ? normalizeMountContainerPath(parsed.container) : bind, bind);
  }
  return {
    binds: [...binds.values()],
    skippedBinds: selection.skippedBinds,
    readOnlyWorkspaceSkillMounts: selection.readOnlyWorkspaceSkillMounts,
    tmpfs: resolveSandboxTmpfsMounts(params.tmpfs),
  };
}

async function inspectSandboxMounts(params: {
  engine: SandboxContainerEngine;
  containerName: string;
}) {
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
  return parseInspectedSandboxMounts(data.Mounts, data.Tmpfs);
}

type ContainerMountInfo = {
  id: string;
  parent: string;
  destination: string;
  backing: string;
  writable: boolean;
};

export async function resolveSandboxContainerOnlyMounts(params: {
  engine: SandboxContainerEngine;
  containerName: string;
}): Promise<string[]> {
  const inspected = await inspectSandboxMounts(params);
  const { stdout } = await execContainer(
    params.engine,
    ["exec", params.containerName, "cat", "/proc/self/mountinfo"],
    { signal: AbortSignal.timeout(5_000) },
  );
  const entries = new Map<string, ContainerMountInfo>();
  for (const line of stdout.split("\n")) {
    if (!line) {
      continue;
    }
    const separator = line.indexOf(" - ");
    const [id, parent, device, root, destination, options] = line.slice(0, separator).split(" ");
    if (separator < 0 || !id || !parent || !device || !root || !destination || !options) {
      throw new Error("Container mountinfo returned an invalid mount entry.");
    }
    entries.set(id, {
      id,
      parent,
      destination: decodeMountInfoPath(destination),
      backing: `${device}\0${decodeMountInfoPath(root)}`,
      writable: options.split(",").includes("rw"),
    });
  }
  if (entries.size === 0) {
    throw new Error("Container mountinfo did not return a mount table.");
  }
  const byDestination = new Map<string, ContainerMountInfo[]>();
  const byParent = new Map<string, ContainerMountInfo[]>();
  const covered = new Set<string>();
  for (const entry of entries.values()) {
    const group = byDestination.get(entry.destination) ?? [];
    group.push(entry);
    byDestination.set(entry.destination, group);
    const siblings = byParent.get(entry.parent) ?? [];
    siblings.push(entry);
    byParent.set(entry.parent, siblings);
    if (entries.get(entry.parent)?.destination === entry.destination && entry.parent !== entry.id) {
      covered.add(entry.parent);
    }
  }
  const visible = (entry: ContainerMountInfo) => {
    const visited = new Set<string>();
    for (let current = entry; !visited.has(current.id);) {
      visited.add(current.id);
      const parent = entries.get(current.parent);
      if (!parent || parent.id === current.id) {
        return true;
      }
      if (parent.destination !== current.destination && covered.has(parent.id)) {
        return false;
      }
      // A later mount on an intervening directory hides an older child even
      // when both retain the same parent ID. A visible child attaches below
      // that covering mount instead, so genuine nested binds still recover.
      if (
        byParent
          .get(current.parent)
          ?.some(
            (sibling) =>
              sibling.id !== parent.id &&
              sibling.destination !== current.destination &&
              isPathInsideContainerRoot(sibling.destination, current.destination),
          )
      ) {
        return false;
      }
      current = parent;
    }
    return false;
  };
  const masks = new Set(byDestination.keys());
  // Inspect retains configured destinations; runc may resolve them through an
  // old symlink. Only a visible, proven bind can expose local bytes. Identical
  // recursive-bind stacks are valid; hidden entries still carry the inspected
  // bind's backing identity, so different backing remains container-only.
  for (const mount of inspected) {
    const group = byDestination.get(mount.destination) ?? [];
    const tops = group.filter((entry) => !covered.has(entry.id) && visible(entry));
    const top = tops[0];
    if (
      mount.type === "bind" &&
      tops.length === 1 &&
      top &&
      top.writable === mount.writable &&
      group.every((entry) => entry.backing === top.backing)
    ) {
      masks.delete(mount.destination);
    } else {
      masks.add(mount.destination);
    }
  }
  return [...masks];
}

export async function sandboxMountPlanMatchesContainer(params: {
  engine: SandboxContainerEngine;
  containerName: string;
  plan: SandboxMountPlan;
}): Promise<boolean> {
  const actual = await inspectSandboxMounts(params);
  const expected = new Map(
    params.plan.binds.flatMap((bind) => {
      const parsed = splitSandboxBindSpec(bind);
      if (!parsed) {
        return [];
      }
      return [[normalizeMountContainerPath(parsed.container), parsed]] as const;
    }),
  );
  const coversBind = (destination: string) =>
    [...expected.keys()].some((root) => isPathInside(root, destination));
  const expectedTmpfs = new Map(
    params.plan.tmpfs
      .filter((mount) => coversBind(mount.containerPath))
      .map((mount) => [mount.containerPath, mount]),
  );
  // Compare configured tmpfs visibility/access below binds. Implicit image
  // volumes remain reusable: the prepared fs snapshot masks their host paths.
  // Other tmpfs options retain the full-config hot advisory policy.
  const managed = actual.filter(
    (mount) =>
      mount.type === "bind" ||
      expected.has(mount.destination) ||
      (mount.type === "tmpfs" && coversBind(mount.destination)),
  );
  return (
    managed.length === expected.size + expectedTmpfs.size &&
    managed.every((mount) => {
      if (mount.type === "tmpfs") {
        const tmpfs = expectedTmpfs.get(mount.destination);
        return tmpfs !== undefined && mount.writable === !tmpfs.readOnly;
      }
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
