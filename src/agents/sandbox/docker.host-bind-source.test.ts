import { describe, expect, it } from "vitest";
import { resolveSandboxHostBindSourcePath } from "./docker.js";

describe("resolveSandboxHostBindSourcePath", () => {
  it("maps exact workspace destination to host source", async () => {
    const resolved = await resolveSandboxHostBindSourcePath("/home/node/.openclaw/workspace", {
      mounts: [
        {
          Source: "/DATA/openclaw/workspace",
          Destination: "/home/node/.openclaw/workspace",
        },
      ],
    });
    expect(resolved).toBe("/DATA/openclaw/workspace");
  });

  it("maps nested sandbox paths using parent destination", async () => {
    const resolved = await resolveSandboxHostBindSourcePath(
      "/home/node/.openclaw/sandboxes/main/workdir",
      {
        mounts: [
          {
            Source: "/DATA/openclaw/config",
            Destination: "/home/node/.openclaw",
          },
        ],
      },
    );
    expect(resolved).toBe("/DATA/openclaw/config/sandboxes/main/workdir");
  });

  it("prefers the longest matching destination mount", async () => {
    const resolved = await resolveSandboxHostBindSourcePath(
      "/home/node/.openclaw/workspace/subdir/project",
      {
        mounts: [
          {
            Source: "/DATA/openclaw/config",
            Destination: "/home/node/.openclaw",
          },
          {
            Source: "/DATA/openclaw/workspace",
            Destination: "/home/node/.openclaw/workspace",
          },
        ],
      },
    );
    expect(resolved).toBe("/DATA/openclaw/workspace/subdir/project");
  });

  it("keeps the original path when no destination mount matches", async () => {
    const original = "/home/node/.openclaw/workspace";
    const resolved = await resolveSandboxHostBindSourcePath(original, {
      mounts: [
        {
          Source: "/DATA/openclaw/other",
          Destination: "/opt/other",
        },
      ],
    });
    expect(resolved).toBe(original);
  });
});
