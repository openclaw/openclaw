import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { DOCKER_SANDBOX_ENGINE, execContainer } from "./container-engine.js";
import { resolveDockerSourceNamespace } from "./docker-mount-source.js";
import { prepareSandboxMountPlan, sandboxMountPlanMatchesContainer } from "./mount-plan.js";

vi.mock("./container-engine.js", () => ({
  DOCKER_SANDBOX_ENGINE: { id: "docker", command: "docker", displayName: "Docker" },
  execContainer: vi.fn(),
}));
vi.mock("./docker-mount-source.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./docker-mount-source.js")>();
  return {
    parseInspectedSandboxMounts: actual.parseInspectedSandboxMounts,
    translateSandboxMountSources: actual.translateSandboxMountSources,
    resolveDockerSourceNamespace: vi.fn(),
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
beforeEach(() => {
  vi.resetAllMocks();
  root = fs.realpathSync(tempDirs.make("openclaw-mount-plan-"));
  for (const subdir of [
    "empty",
    "private/skills",
    "private/skills/nested",
    "private/data/nested",
    "agent/skills",
    "agent/skills/nested",
    "agent/data/nested",
    "agent/.agents/skills",
    "materialized/skills",
    "materialized/skills/nested",
  ]) {
    fs.mkdirSync(path.join(root, subdir), { recursive: true });
  }
  vi.mocked(resolveDockerSourceNamespace).mockResolvedValue([
    { type: "bind", source: "/host/state", destination: root, writable: true },
    { type: "bind", source: "/host/agent", destination: path.join(root, "agent"), writable: true },
    {
      type: "bind",
      source: "/host/materialized skills",
      destination: path.join(root, "materialized"),
      writable: true,
    },
  ]);
});

function params(access: "none" | "ro" | "rw") {
  return {
    engine: DOCKER_SANDBOX_ENGINE,
    workspaceDir: path.join(root, access === "rw" ? "agent" : "private"),
    agentWorkspaceDir: path.join(root, "agent"),
    skillsWorkspaceDir: path.join(root, "materialized"),
    workdir: "/workspace",
    workspaceAccess: access,
  };
}

describe("managed mount plan", () => {
  it.each(["none", "ro", "rw"] as const)(
    "maps all managed roots with %s permissions",
    async (access) => {
      const plan = await prepareSandboxMountPlan(params(access));
      if (access === "none") {
        expect(plan.binds).toEqual([
          "/host/state/private:/workspace:z",
          "/host/state/private/skills:/workspace/skills:ro,z",
        ]);
      } else if (access === "ro") {
        expect(plan.binds).toEqual([
          "/host/state/private:/workspace:ro,z",
          "/host/agent:/agent:ro,z",
        ]);
      } else {
        expect(plan.binds).toEqual([
          "/host/agent:/workspace:z",
          "/host/agent/skills:/workspace/skills:ro,z",
          "/host/agent/.agents/skills:/workspace/.agents/skills:ro,z",
          "/host/materialized skills/skills:/workspace/.openclaw/sandbox-skills/skills:ro,z",
        ]);
      }
    },
  );

  it("preserves custom daemon sources while keeping protected skill mounts authoritative", async () => {
    const plan = await prepareSandboxMountPlan({
      ...params("rw"),
      binds: ["/custom/host:/data:ro", "/custom/override:/workspace/skills:rw"],
    });
    expect(plan.binds).toContain("/custom/host:/data:ro");
    expect(plan.binds).toContain("/host/agent/skills:/workspace/skills:ro,z");
    expect(plan.skippedBinds).toEqual(["/custom/override:/workspace/skills:rw"]);
  });

  it("selects the last custom destination while preserving its raw daemon bind", async () => {
    const plan = await prepareSandboxMountPlan({
      ...params("rw"),
      binds: ["/daemon/A:/data:ro", "/daemon/B:/data/:rw", "invalid-bind"],
    });
    expect(plan.binds).toContain("/daemon/B:/data/:rw");
    expect(plan.binds).not.toContain("/daemon/A:/data:ro");
    expect(plan.binds).toContain("invalid-bind");
    expect(plan.skippedBinds).toEqual([]);
  });

  it("keeps meaningful source and target whitespace through create and retained comparison", async () => {
    const plan = await prepareSandboxMountPlan({
      ...params("rw"),
      workspaceDir: path.join(root, "empty"),
      agentWorkspaceDir: path.join(root, "empty"),
      binds: ["/daemon/A:/data:ro", "/daemon/B :/data :rw"],
    });
    expect(plan.binds).toEqual([
      "/host/state/empty:/workspace:z",
      "/host/materialized skills/skills:/workspace/.openclaw/sandbox-skills/skills:ro,z",
      "/daemon/A:/data:ro",
      "/daemon/B :/data :rw",
    ]);
    vi.mocked(execContainer).mockResolvedValue({
      stdout: JSON.stringify({
        Mounts: [
          { Type: "bind", Source: "/host/state/empty", Destination: "/workspace", RW: true },
          {
            Type: "bind",
            Source: "/host/materialized skills/skills",
            Destination: "/workspace/.openclaw/sandbox-skills/skills",
            RW: false,
          },
          { Type: "bind", Source: "/daemon/A", Destination: "/data", RW: false },
          { Type: "bind", Source: "/daemon/B ", Destination: "/data ", RW: true },
        ],
        Tmpfs: null,
      }),
      stderr: "",
      code: 0,
    });
    await expect(
      sandboxMountPlanMatchesContainer({
        engine: DOCKER_SANDBOX_ENGINE,
        containerName: "sandbox",
        plan,
      }),
    ).resolves.toBe(true);
  });

  it.each(["/workspace", "/workspace/"])(
    "honors a custom override at %s without translating the replaced source",
    async (target) => {
      vi.mocked(resolveDockerSourceNamespace).mockResolvedValue([]);
      const plan = await prepareSandboxMountPlan({
        ...params("ro"),
        workspaceDir: path.join(root, "agent"),
        binds: [`/custom/project:${target}:ro`],
      });
      expect(plan.binds).toEqual([`/custom/project:${target}:ro`]);
    },
  );

  it.each(["none", "ro", "rw"] as const)(
    "projects nested binds and protected skill descendants with %s permissions",
    async (access) => {
      const namespace = await resolveDockerSourceNamespace(DOCKER_SANDBOX_ENGINE);
      vi.mocked(resolveDockerSourceNamespace).mockResolvedValue([
        ...namespace!,
        ...["private", "agent"].flatMap((workspace) => [
          {
            type: "bind",
            source: `/host/${workspace}-data`,
            destination: path.join(root, workspace, "data"),
            writable: false,
          },
          {
            type: "bind",
            source: `/host/${workspace}-nested`,
            destination: path.join(root, workspace, "data/nested"),
            writable: true,
          },
          {
            type: "bind",
            source: `/host/${workspace}-skill`,
            destination: path.join(root, workspace, "skills/nested"),
            writable: true,
          },
        ]),
        {
          type: "bind",
          source: "/host/materialized-skill",
          destination: path.join(root, "materialized/skills/nested"),
          writable: true,
        },
      ]);
      const plan = await prepareSandboxMountPlan(params(access));
      const workspace = access === "rw" ? "agent" : "private";
      expect(plan.binds).toContain(`/host/${workspace}-data:/workspace/data:ro,z`);
      expect(plan.binds).toContain(
        `/host/${workspace}-nested:/workspace/data/nested:${access === "ro" ? "ro,z" : "z"}`,
      );
      expect(plan.binds).toContain(`/host/${workspace}-skill:/workspace/skills/nested:ro,z`);
      if (access === "rw") {
        expect(plan.binds).toContain(
          "/host/materialized-skill:/workspace/.openclaw/sandbox-skills/skills/nested:ro,z",
        );
      }
    },
  );

  it.each(["volume", "tmpfs", "image"])(
    "rejects visible nested %s storage but respects a custom subtree override",
    async (type) => {
      const namespace = await resolveDockerSourceNamespace(DOCKER_SANDBOX_ENGINE);
      vi.mocked(resolveDockerSourceNamespace).mockResolvedValue([
        ...namespace!,
        {
          type,
          source: "/private/storage",
          destination: path.join(root, "private/data"),
          writable: true,
        },
        {
          type: "bind",
          source: "/host/hidden",
          destination: path.join(root, "private/data/nested"),
          writable: true,
        },
      ]);
      await expect(prepareSandboxMountPlan(params("none"))).rejects.toThrow(
        `unsupported nested ${type} mount`,
      );
      const plan = await prepareSandboxMountPlan({
        ...params("none"),
        binds: ["/custom/data:/workspace/data/:ro"],
      });
      expect(plan.binds).toContain("/custom/data:/workspace/data/:ro");
      expect(plan.binds.some((bind) => bind.startsWith("/host/hidden:"))).toBe(false);
    },
  );

  it("changes the hashed bind plan when the daemon source changes", async () => {
    const first = await prepareSandboxMountPlan(params("ro"));
    vi.mocked(resolveDockerSourceNamespace).mockResolvedValue([
      { type: "bind", source: "/replacement", destination: root, writable: true },
    ]);
    const second = await prepareSandboxMountPlan(params("ro"));
    expect(second.binds).not.toEqual(first.binds);
    expect(second.binds).toContain("/replacement/private:/workspace:ro,z");
  });

  it("keeps protected skills read-only on a read-only Gateway source", async () => {
    vi.mocked(resolveDockerSourceNamespace).mockResolvedValue([
      { type: "bind", source: "/host/state", destination: root, writable: true },
      {
        type: "bind",
        source: "/host/skills",
        destination: path.join(root, "materialized"),
        writable: false,
      },
    ]);
    expect((await prepareSandboxMountPlan(params("rw"))).binds).toContain(
      "/host/skills/skills:/workspace/.openclaw/sandbox-skills/skills:ro,z",
    );
  });
});

describe("retained mount identity", () => {
  it.runIf(process.platform !== "win32").each(["/host/a\\b", "/host/a/b"])(
    "compares literal POSIX source bytes for retained %s",
    async (source) => {
      const plan = await prepareSandboxMountPlan({
        ...params("none"),
        workspaceDir: path.join(root, "empty"),
        binds: ["/host/a\\b:/data:ro"],
      });
      vi.mocked(execContainer).mockResolvedValue({
        stdout: JSON.stringify({
          Mounts: [
            { Type: "bind", Source: "/host/state/empty", Destination: "/workspace", RW: true },
            { Type: "bind", Source: source, Destination: "/data", RW: false },
          ],
          Tmpfs: null,
        }),
        stderr: "",
        code: 0,
      });
      expect(
        await sandboxMountPlanMatchesContainer({
          engine: DOCKER_SANDBOX_ENGINE,
          containerName: "retained",
          plan,
        }),
      ).toBe(source === "/host/a\\b");
    },
  );

  it.each(["tmpfs", "volume", "image"])(
    "distinguishes configured tmpfs removal from implicit %s below a bind",
    async (type) => {
      const plan = await prepareSandboxMountPlan({
        ...params("none"),
        workspaceDir: path.join(root, "empty"),
      });
      vi.mocked(execContainer).mockResolvedValue({
        stdout: JSON.stringify({
          Mounts: [
            { Type: "bind", Source: "/host/state/empty", Destination: "/workspace", RW: true },
            ...(type === "tmpfs"
              ? []
              : [
                  {
                    Type: type,
                    Source: "/engine/storage",
                    Destination: "/workspace/cache",
                    RW: true,
                  },
                ]),
          ],
          Tmpfs: type === "tmpfs" ? { "/workspace/cache": "rw" } : null,
        }),
        stderr: "",
        code: 0,
      });
      expect(
        await sandboxMountPlanMatchesContainer({
          engine: DOCKER_SANDBOX_ENGINE,
          containerName: "retained",
          plan,
        }),
      ).toBe(type !== "tmpfs");
    },
  );

  it.each([
    { configured: "ro,size=64m", actual: "nosuid,nodev,ro,size=65536k", matches: true },
    { configured: "rw", actual: "nosuid,nodev,rw", matches: true },
    { configured: "", actual: "rw", matches: true },
    { configured: "ro,rw", actual: "rw", matches: true },
    { configured: "rw,ro", actual: "ro", matches: true },
    { configured: "ro", actual: "rw", matches: false },
    { configured: "rw", actual: "ro", matches: false },
  ])(
    "compares tmpfs visibility/access without reinterpreting engine options: $configured / $actual",
    async ({ configured, actual, matches }) => {
      const plan = await prepareSandboxMountPlan({
        ...params("none"),
        workspaceDir: path.join(root, "empty"),
        tmpfs: [`/workspace/cache:${configured}`],
      });
      vi.mocked(execContainer).mockResolvedValue({
        stdout: JSON.stringify({
          Mounts: [
            { Type: "bind", Source: "/host/state/empty", Destination: "/workspace", RW: true },
          ],
          Tmpfs: { "/workspace/cache": actual, "/run": "rw,nosuid,nodev" },
        }),
        stderr: "",
        code: 0,
      });
      expect(
        await sandboxMountPlanMatchesContainer({
          engine: DOCKER_SANDBOX_ENGINE,
          containerName: "retained",
          plan,
        }),
      ).toBe(matches);
    },
  );

  it.each([
    "source",
    "writable",
    "removed-agent",
    "removed-skill",
    "removed-custom",
    "removed-nested",
  ])("rejects a stale %s mount even on a pre-fix container", async (change) => {
    const plan = await prepareSandboxMountPlan({
      ...params("none"),
      workspaceDir: path.join(root, "empty"),
    });
    const mounts = [
      { Type: "bind", Source: "/host/state/empty", Destination: "/workspace", RW: true },
    ];
    if (change === "source") {
      mounts[0]!.Source = "/old/source";
    }
    if (change === "writable") {
      mounts[0]!.RW = false;
    }
    if (change.startsWith("removed")) {
      mounts.push({
        Type: "bind",
        Source: "/old/source",
        Destination:
          change === "removed-agent"
            ? "/agent"
            : change === "removed-skill"
              ? "/workspace/skills"
              : change === "removed-custom"
                ? "/data"
                : "/workspace/data",
        RW: false,
      });
    }
    vi.mocked(execContainer).mockResolvedValue({
      stdout: JSON.stringify({ Mounts: mounts, Tmpfs: null }),
      stderr: "",
      code: 0,
    });
    expect(
      await sandboxMountPlanMatchesContainer({
        engine: DOCKER_SANDBOX_ENGINE,
        containerName: "retained",
        plan,
      }),
    ).toBe(false);
  });

  it("accepts an unchanged mount with a trailing-slash workdir and ignores unrelated image volumes", async () => {
    const plan = await prepareSandboxMountPlan({
      ...params("none"),
      workspaceDir: path.join(root, "empty"),
      workdir: "/workspace/",
    });
    expect(plan.binds).toEqual(["/host/state/empty:/workspace:z"]);
    vi.mocked(execContainer).mockResolvedValue({
      stdout: JSON.stringify({
        Mounts: [
          { Type: "bind", Source: "/host/state/empty", Destination: "/workspace/", RW: true },
          { Type: "volume", Source: "/engine/volume", Destination: "/image-data", RW: true },
        ],
        Tmpfs: { "/tmp": "rw" },
      }),
      stderr: "",
      code: 0,
    });
    expect(
      await sandboxMountPlanMatchesContainer({
        engine: DOCKER_SANDBOX_ENGINE,
        containerName: "retained",
        plan,
      }),
    ).toBe(true);
  });

  it.each(["source", "permission", "type", "tmpfs"])(
    "rejects a stale custom bind %s",
    async (change) => {
      const plan = await prepareSandboxMountPlan({
        ...params("none"),
        workspaceDir: path.join(root, "empty"),
        binds: ["/host/data:/workspace/data:ro"],
      });
      vi.mocked(execContainer).mockResolvedValue({
        stdout: JSON.stringify({
          Mounts: [
            { Type: "bind", Source: "/host/state/empty", Destination: "/workspace", RW: true },
            {
              Type: change === "type" ? "volume" : "bind",
              Source: change === "source" ? "/old/data" : "/host/data",
              Destination: "/workspace/data",
              RW: change === "permission",
            },
          ],
          Tmpfs: change === "tmpfs" ? { "/workspace/data": "rw" } : null,
        }),
        stderr: "",
        code: 0,
      });
      expect(
        await sandboxMountPlanMatchesContainer({
          engine: DOCKER_SANDBOX_ENGINE,
          containerName: "retained",
          plan,
        }),
      ).toBe(false);
    },
  );

  it("accepts intentional custom binds and case-insensitive Windows sources at managed destinations", async () => {
    vi.mocked(resolveDockerSourceNamespace).mockResolvedValue(undefined);
    const plan = await prepareSandboxMountPlan({
      ...params("ro"),
      workspaceDir: "C:/Users/Example/project",
      agentWorkspaceDir: "C:/Users/Example/project",
      binds: ["D:\\Skills:/workspace/skills:ro"],
    });
    vi.mocked(execContainer).mockResolvedValue({
      stdout: JSON.stringify({
        Mounts: [
          {
            Type: "bind",
            Source: "c:\\users\\example\\project",
            Destination: "/workspace",
            RW: false,
          },
          { Type: "bind", Source: "d:\\skills", Destination: "/workspace/skills", RW: false },
        ],
        Tmpfs: null,
      }),
      stderr: "",
      code: 0,
    });
    expect(
      await sandboxMountPlanMatchesContainer({
        engine: DOCKER_SANDBOX_ENGINE,
        containerName: "retained",
        plan,
      }),
    ).toBe(true);
  });
});
