import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { DOCKER_SANDBOX_ENGINE, execContainer } from "./container-engine.js";
import { resolveDockerSourceNamespace } from "./docker-mount-source.js";
import { prepareSandboxMountPlan, compareSandboxMountPlan } from "./mount-plan.js";

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

async function matchesContainer(
  plan: Awaited<ReturnType<typeof prepareSandboxMountPlan>>,
  mounts: { Type: string; Source: string; Destination: string; RW: boolean }[],
  tmpfs: Record<string, string> | null = null,
) {
  vi.mocked(execContainer).mockResolvedValue({
    stdout: JSON.stringify({ Mounts: mounts, Tmpfs: tmpfs }),
    stderr: "",
    code: 0,
  });
  return (
    (await compareSandboxMountPlan({
      engine: DOCKER_SANDBOX_ENGINE,
      containerName: "retained",
      plan,
    })) === "match"
  );
}

describe("managed mount plan", () => {
  it("pins writable ancestors of nested protected skill mounts so they cannot be renamed", async () => {
    const workspace = path.join(root, "agent");
    const plan = await prepareSandboxMountPlan({ ...params("rw"), workdir: "/srv/work/" });
    // Ancestors exist on the host before create, owned by the workspace owner.
    for (const ancestor of [".agents", ".openclaw", ".openclaw/sandbox-skills"]) {
      const stat = fs.lstatSync(path.join(workspace, ancestor));
      expect(stat.isDirectory()).toBe(true);
      expect(stat.uid).toBe(fs.statSync(workspace).uid);
    }
    // Each ancestor is a writable self-bind ordered before the protected mount it pins.
    const index = (spec: string) => plan.binds.indexOf(spec);
    expect(index("/host/agent/.agents:/srv/work/.agents:z")).toBeGreaterThan(-1);
    expect(index("/host/agent/.agents:/srv/work/.agents:z")).toBeLessThan(
      index("/host/agent/.agents/skills:/srv/work/.agents/skills:ro,z"),
    );
    expect(index("/host/agent/.openclaw:/srv/work/.openclaw:z")).toBeLessThan(
      index("/host/agent/.openclaw/sandbox-skills:/srv/work/.openclaw/sandbox-skills:z"),
    );
    expect(
      index("/host/agent/.openclaw/sandbox-skills:/srv/work/.openclaw/sandbox-skills:z"),
    ).toBeLessThan(
      index("/host/materialized skills/skills:/srv/work/.openclaw/sandbox-skills/skills:ro,z"),
    );
    // Direct children of the workdir are already mountpoints; no extra bind.
    expect(plan.binds.filter((spec) => spec.endsWith(":/srv/work:z"))).toHaveLength(1);
  });

  it("keeps a read-only Gateway ancestor bind read-only instead of failing startup", async () => {
    const namespace = await resolveDockerSourceNamespace(DOCKER_SANDBOX_ENGINE);
    vi.mocked(resolveDockerSourceNamespace).mockResolvedValue([
      ...namespace!,
      {
        type: "bind",
        source: "/host/agents-ro",
        destination: path.join(root, "agent/.agents"),
        writable: false,
      },
    ]);
    const plan = await prepareSandboxMountPlan(params("rw"));
    expect(plan.binds).toContain("/host/agents-ro:/workspace/.agents:ro,z");
    expect(plan.binds).toContain("/host/agents-ro/skills:/workspace/.agents/skills:ro,z");
  });

  it("keeps a writable Gateway child under a read-only Gateway ancestor writable", async () => {
    fs.mkdirSync(path.join(root, "agent/.agents/output"));
    const namespace = await resolveDockerSourceNamespace(DOCKER_SANDBOX_ENGINE);
    vi.mocked(resolveDockerSourceNamespace).mockResolvedValue([
      ...namespace!,
      {
        type: "bind",
        source: "/host/agents-ro",
        destination: path.join(root, "agent/.agents"),
        writable: false,
      },
      {
        type: "bind",
        source: "/host/agents-output",
        destination: path.join(root, "agent/.agents/output"),
        writable: true,
      },
    ]);
    const plan = await prepareSandboxMountPlan(params("rw"));
    expect(plan.binds).toContain("/host/agents-ro:/workspace/.agents:ro,z");
    expect(plan.binds).toContain("/host/agents-output:/workspace/.agents/output:z");
    expect(plan.binds).toContain("/host/agents-ro/skills:/workspace/.agents/skills:ro,z");
  });

  it("refuses a symlinked protected-mount ancestor without creating outside the workspace", async () => {
    const outside = path.join(root, "outside-ancestor");
    fs.mkdirSync(outside);
    fs.symlinkSync(
      outside,
      path.join(root, "agent/.openclaw"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(prepareSandboxMountPlan(params("rw"))).rejects.toThrow();
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("does not pin ancestors below a read-only workspace", async () => {
    const plan = await prepareSandboxMountPlan({
      ...params("ro"),
      workspaceDir: path.join(root, "agent"),
    });
    expect(plan.binds.some((spec) => spec.includes(":/workspace/.agents:"))).toBe(false);
  });

  it("allocates managed skill mount targets as the workspace host owner before engine create", async () => {
    const workspace = path.join(root, "agent");
    fs.mkdirSync(path.join(workspace, ".openclaw"), { mode: 0o750 });
    fs.writeFileSync(path.join(workspace, ".openclaw/project.json"), "preserved");
    const plan = await prepareSandboxMountPlan({
      ...params("rw"),
      workspaceSource: "managed-worktree",
    });
    const target = path.join(workspace, ".openclaw/sandbox-skills/skills");
    expect(fs.statSync(target).uid).toBe(fs.statSync(workspace).uid);
    if (process.platform !== "win32") {
      expect(fs.statSync(path.join(workspace, ".openclaw")).mode & 0o777).toBe(0o750);
    }
    expect(fs.readFileSync(path.join(workspace, ".openclaw/project.json"), "utf8")).toBe(
      "preserved",
    );
    expect(plan.binds).toContain(
      "/host/materialized skills/skills:/workspace/.openclaw/sandbox-skills/skills:ro,z",
    );
  });

  it("rechecks the workspace owner after namespace lookup before creating scaffold directories", async () => {
    let current = true;
    vi.mocked(resolveDockerSourceNamespace).mockImplementationOnce(async () => {
      current = false;
      return undefined;
    });
    await expect(
      prepareSandboxMountPlan({
        ...params("rw"),
        workspaceSource: "managed-worktree",
        assertCurrent: () => {
          if (!current) {
            throw new Error("workspace retired");
          }
        },
      }),
    ).rejects.toThrow("workspace retired");
    expect(fs.existsSync(path.join(root, "agent/.openclaw"))).toBe(false);
  });

  it("refuses an aliased managed mount target without creating outside the workspace", async () => {
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(
      outside,
      path.join(root, "agent/.openclaw"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      prepareSandboxMountPlan({ ...params("rw"), workspaceSource: "managed-worktree" }),
    ).rejects.toThrow();
    expect(fs.readdirSync(outside)).toEqual([]);
  });

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
          "/host/agent/.agents:/workspace/.agents:z",
          "/host/agent/.agents/skills:/workspace/.agents/skills:ro,z",
          "/host/agent/.openclaw:/workspace/.openclaw:z",
          "/host/agent/.openclaw/sandbox-skills:/workspace/.openclaw/sandbox-skills:z",
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
      "/host/state/empty/.openclaw:/workspace/.openclaw:z",
      "/host/state/empty/.openclaw/sandbox-skills:/workspace/.openclaw/sandbox-skills:z",
      "/host/materialized skills/skills:/workspace/.openclaw/sandbox-skills/skills:ro,z",
      "/daemon/A:/data:ro",
      "/daemon/B :/data :rw",
    ]);
    await expect(
      matchesContainer(plan, [
        { Type: "bind", Source: "/host/state/empty", Destination: "/workspace", RW: true },
        {
          Type: "bind",
          Source: "/host/state/empty/.openclaw",
          Destination: "/workspace/.openclaw",
          RW: true,
        },
        {
          Type: "bind",
          Source: "/host/state/empty/.openclaw/sandbox-skills",
          Destination: "/workspace/.openclaw/sandbox-skills",
          RW: true,
        },
        {
          Type: "bind",
          Source: "/host/materialized skills/skills",
          Destination: "/workspace/.openclaw/sandbox-skills/skills",
          RW: false,
        },
        { Type: "bind", Source: "/daemon/A", Destination: "/data", RW: false },
        { Type: "bind", Source: "/daemon/B ", Destination: "/data ", RW: true },
      ]),
    ).resolves.toBe(true);
  });

  it("honors a normalized custom override without translating the replaced source", async () => {
    vi.mocked(resolveDockerSourceNamespace).mockResolvedValue([]);
    const plan = await prepareSandboxMountPlan({
      ...params("ro"),
      workspaceDir: path.join(root, "agent"),
      binds: ["/custom/project:/workspace/:ro"],
    });
    expect(plan.binds).toEqual(["/custom/project:/workspace/:ro"]);
  });

  it.each(["ro", "rw"] as const)(
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

  it("rejects visible nested non-bind storage but respects a custom subtree override", async () => {
    const namespace = await resolveDockerSourceNamespace(DOCKER_SANDBOX_ENGINE);
    vi.mocked(resolveDockerSourceNamespace).mockResolvedValue([
      ...namespace!,
      {
        type: "volume",
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
      "unsupported nested volume mount",
    );
    const plan = await prepareSandboxMountPlan({
      ...params("none"),
      binds: ["/custom/data:/workspace/data/:ro"],
    });
    expect(plan.binds).toContain("/custom/data:/workspace/data/:ro");
    expect(plan.binds.some((bind) => bind.startsWith("/host/hidden:"))).toBe(false);
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
      expect(
        await matchesContainer(plan, [
          { Type: "bind", Source: "/host/state/empty", Destination: "/workspace", RW: true },
          { Type: "bind", Source: source, Destination: "/data", RW: false },
        ]),
      ).toBe(source === "/host/a\\b");
    },
  );

  it.each(["tmpfs", "volume"])(
    "distinguishes configured tmpfs removal from implicit %s below a bind",
    async (type) => {
      const plan = await prepareSandboxMountPlan({
        ...params("none"),
        workspaceDir: path.join(root, "empty"),
      });
      expect(
        await matchesContainer(
          plan,
          [
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
          type === "tmpfs" ? { "/workspace/cache": "rw" } : null,
        ),
      ).toBe(type !== "tmpfs");
    },
  );

  it.each([
    { configured: "ro,size=64m", actual: "nosuid,nodev,ro,size=65536k", matches: true },
    { configured: "", actual: "rw", matches: true },
    { configured: "ro,rw", actual: "rw", matches: true },
    { configured: "rw,ro", actual: "ro", matches: true },
    { configured: "ro", actual: "rw", matches: false },
  ])(
    "compares tmpfs visibility/access without reinterpreting engine options: $configured / $actual",
    async ({ configured, actual, matches }) => {
      const plan = await prepareSandboxMountPlan({
        ...params("none"),
        workspaceDir: path.join(root, "empty"),
        tmpfs: [`/workspace/cache:${configured}`],
      });
      expect(
        await matchesContainer(
          plan,
          [{ Type: "bind", Source: "/host/state/empty", Destination: "/workspace", RW: true }],
          { "/workspace/cache": actual, "/run": "rw,nosuid,nodev" },
        ),
      ).toBe(matches);
    },
  );

  it("rejects a removed bind even on a pre-fix container", async () => {
    const plan = await prepareSandboxMountPlan({
      ...params("none"),
      workspaceDir: path.join(root, "empty"),
    });
    expect(
      await matchesContainer(plan, [
        { Type: "bind", Source: "/host/state/empty", Destination: "/workspace", RW: true },
        {
          Type: "bind",
          Source: "/old/source",
          Destination: "/agent",
          RW: false,
        },
      ]),
    ).toBe(false);
  });

  it("accepts an unchanged mount with a trailing-slash workdir and ignores unrelated image volumes", async () => {
    const plan = await prepareSandboxMountPlan({
      ...params("none"),
      workspaceDir: path.join(root, "empty"),
      workdir: "/workspace/",
    });
    expect(plan.binds).toEqual(["/host/state/empty:/workspace:z"]);
    expect(
      await matchesContainer(
        plan,
        [
          { Type: "bind", Source: "/host/state/empty", Destination: "/workspace/", RW: true },
          { Type: "volume", Source: "/engine/volume", Destination: "/image-data", RW: true },
        ],
        { "/tmp": "rw" },
      ),
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
      expect(
        await matchesContainer(
          plan,
          [
            { Type: "bind", Source: "/host/state/empty", Destination: "/workspace", RW: true },
            {
              Type: change === "type" ? "volume" : "bind",
              Source: change === "source" ? "/old/data" : "/host/data",
              Destination: "/workspace/data",
              RW: change === "permission",
            },
          ],
          change === "tmpfs" ? { "/workspace/data": "rw" } : null,
        ),
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
    expect(
      await matchesContainer(plan, [
        {
          Type: "bind",
          Source: "c:\\users\\example\\project",
          Destination: "/workspace",
          RW: false,
        },
        { Type: "bind", Source: "d:\\skills", Destination: "/workspace/skills", RW: false },
      ]),
    ).toBe(true);
  });
});
