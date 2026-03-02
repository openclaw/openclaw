import { describe, expect, it } from "vitest";
import {
  mapContainerPathToDockerHostPath,
  resolveAllowedBindSourceRoots,
} from "./docker-bind-source-map.js";

describe("sandbox docker bind source mapping", () => {
  it("maps a container path under a bind mount to its host source", () => {
    const mapped = mapContainerPathToDockerHostPath({
      containerPath: "/home/node/.openclaw/workspace/project-a",
      mounts: [
        {
          Source: "/DATA/openclaw/workspace",
          Destination: "/home/node/.openclaw/workspace",
        },
      ],
    });
    expect(mapped).toBe("/DATA/openclaw/workspace/project-a");
  });

  it("prefers the most specific mount destination", () => {
    const mapped = mapContainerPathToDockerHostPath({
      containerPath: "/home/node/.openclaw/sandboxes/shared",
      mounts: [
        { Source: "/var/lib/docker/volumes/openclaw_home/_data", Destination: "/home/node" },
        {
          Source: "/var/lib/docker/volumes/openclaw_state/_data",
          Destination: "/home/node/.openclaw",
        },
      ],
    });
    expect(mapped).toBe("/var/lib/docker/volumes/openclaw_state/_data/sandboxes/shared");
  });

  it("returns the original path when no mount matches", () => {
    const mapped = mapContainerPathToDockerHostPath({
      containerPath: "/opt/openclaw/sandboxes",
      mounts: [
        { Source: "/DATA/openclaw/workspace", Destination: "/home/node/.openclaw/workspace" },
      ],
    });
    expect(mapped).toBe("/opt/openclaw/sandboxes");
  });

  it("returns both container and mapped roots for validation", () => {
    const roots = resolveAllowedBindSourceRoots({
      containerRoots: ["/home/node/.openclaw/sandboxes"],
      mounts: [
        { Source: "/var/lib/docker/volumes/openclaw_home/_data", Destination: "/home/node" },
      ],
    });
    expect(roots).toContain("/home/node/.openclaw/sandboxes");
    expect(roots).toContain("/var/lib/docker/volumes/openclaw_home/_data/.openclaw/sandboxes");
  });
});
