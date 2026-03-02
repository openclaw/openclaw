import { posix as pathPosix } from "node:path";

export type DockerMountLike = {
  Source?: string;
  Destination?: string;
};

function normalizeAbsolutePosixPath(value: string): string {
  const normalized = pathPosix.normalize(value);
  if (normalized.length > 1 && normalized.endsWith("/")) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

export function mapContainerPathToDockerHostPath(params: {
  containerPath: string;
  mounts: readonly DockerMountLike[];
}): string {
  const rawContainerPath = params.containerPath.trim();
  if (!rawContainerPath.startsWith("/")) {
    return params.containerPath;
  }

  const containerPath = normalizeAbsolutePosixPath(rawContainerPath);
  const mounts = [...params.mounts]
    .filter((mount): mount is Required<DockerMountLike> =>
      Boolean(mount.Source && mount.Destination),
    )
    .map((mount) => ({
      Source: normalizeAbsolutePosixPath(mount.Source),
      Destination: normalizeAbsolutePosixPath(mount.Destination),
    }))
    .toSorted((a, b) => b.Destination.length - a.Destination.length);

  for (const mount of mounts) {
    if (containerPath === mount.Destination) {
      return mount.Source;
    }
    const prefix = mount.Destination === "/" ? "/" : `${mount.Destination}/`;
    if (containerPath.startsWith(prefix)) {
      const remainder = containerPath.slice(mount.Destination.length);
      return `${mount.Source}${remainder}`;
    }
  }

  return params.containerPath;
}

export function resolveAllowedBindSourceRoots(params: {
  containerRoots: readonly string[];
  mounts: readonly DockerMountLike[];
}): string[] {
  const roots = new Set<string>();
  for (const root of params.containerRoots) {
    if (!root.trim()) {
      continue;
    }
    roots.add(root);
    roots.add(
      mapContainerPathToDockerHostPath({
        containerPath: root,
        mounts: params.mounts,
      }),
    );
  }
  return [...roots];
}
