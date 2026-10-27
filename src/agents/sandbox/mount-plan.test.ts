import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { DOCKER_SANDBOX_ENGINE as engine, execContainer } from "./container-engine.js";
import { resolveDockerSourceNamespace } from "./docker-mount-source.js";
import {
  prepareSandboxMountPlan,
  compareSandboxMountPlan,
  sandboxContainerShowsWorkspacePaths,
} from "./mount-plan.js";

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
type MountInput = Parameters<typeof prepareSandboxMountPlan>[0];
const skillsTarget = "/workspace/.openclaw/sandbox-skills/skills";
const skillsBind = `/host/materialized skills/skills:${skillsTarget}:ro,z`;
let root: string;
function bind(Source: string, Destination: string, RW = true) {
  return { Type: "bind", Source, Destination, RW };
}
function namespaceBind(source: string, destination: string, writable = true) {
  return { type: "bind", source, destination, writable };
}
beforeEach(() => {
  vi.resetAllMocks();
  root = fs.realpathSync(tempDirs.make("openclaw-mount-plan-"));
  for (const subdir of [
    "empty",
    "private/skills/nested",
    "private/data/nested",
    "agent/skills/nested",
    "agent/data/nested",
    "agent/.agents/skills",
    "materialized/skills/nested",
  ]) {
    fs.mkdirSync(path.join(root, subdir), { recursive: true });
  }
  vi.mocked(resolveDockerSourceNamespace).mockResolvedValue([
    namespaceBind("/host/state", root),
    namespaceBind("/host/agent", path.join(root, "agent")),
    namespaceBind("/host/materialized skills", path.join(root, "materialized")),
  ]);
});

function prepare(access: "none" | "ro" | "rw", overrides: Partial<MountInput> = {}) {
  return prepareSandboxMountPlan({
    engine,
    workspaceDir: path.join(root, access === "rw" ? "agent" : "private"),
    agentWorkspaceDir: path.join(root, "agent"),
    skillsWorkspaceDir: path.join(root, "materialized"),
    workdir: "/workspace",
    workspaceAccess: access,
    ...overrides,
  });
}
const prepareEmpty = (overrides: Partial<MountInput> = {}) =>
  prepare("none", { workspaceDir: path.join(root, "empty"), ...overrides });

async function expectMounts(
  plan: Awaited<ReturnType<typeof prepareSandboxMountPlan>>,
  mounts: { Type: string; Source: string; Destination: string; RW: boolean }[],
  tmpfs: Record<string, string> | null = null,
  matches = true,
) {
  vi.mocked(execContainer).mockResolvedValue({
    stdout: JSON.stringify({ Mounts: mounts, Tmpfs: tmpfs }),
    stderr: "",
    code: 0,
  });
  expect(
    (await compareSandboxMountPlan({ engine, containerName: "retained", plan })) === "match",
  ).toBe(matches);
}

describe("managed mount plan", () => {
  it("allocates managed skill mount targets as the workspace host owner before engine create", async () => {
    const workspace = path.join(root, "agent");
    fs.mkdirSync(path.join(workspace, ".openclaw"), { mode: 0o750 });
    if (process.platform !== "win32") {
      // mkdir's mode is filtered by the runner's umask.
      fs.chmodSync(path.join(workspace, ".openclaw"), 0o750);
    }
    fs.writeFileSync(path.join(workspace, ".openclaw/project.json"), "preserved");
    const plan = await prepare("rw", { workspaceSource: "managed-worktree" });
    const target = path.join(workspace, ".openclaw/sandbox-skills/skills");
    expect(fs.statSync(target).uid).toBe(fs.statSync(workspace).uid);
    if (process.platform !== "win32") {
      expect(fs.statSync(path.join(workspace, ".openclaw")).mode & 0o777).toBe(0o750);
    }
    expect(fs.readFileSync(path.join(workspace, ".openclaw/project.json"), "utf8")).toBe(
      "preserved",
    );
    expect(plan.binds).toContain(skillsBind);
  });

  it("rechecks the workspace owner after namespace lookup before creating scaffold directories", async () => {
    const authority = new AbortController();
    vi.mocked(resolveDockerSourceNamespace).mockImplementationOnce(async () => {
      authority.abort(new Error("workspace retired"));
      return undefined;
    });
    await expect(
      prepare("rw", {
        workspaceSource: "managed-worktree",
        assertCurrent: () => authority.signal.throwIfAborted(),
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
    await expect(prepare("rw", { workspaceSource: "managed-worktree" })).rejects.toThrow();
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("pins writable ancestors of nested protected skill mounts so they cannot be renamed", async () => {
    const workspace = path.join(root, "agent");
    const plan = await prepare("rw", { workdir: "/srv/work/" });
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
    const namespace = await resolveDockerSourceNamespace(engine);
    vi.mocked(resolveDockerSourceNamespace).mockResolvedValue([
      ...namespace!,
      namespaceBind("/host/agents-ro", path.join(root, "agent/.agents"), false),
    ]);
    const plan = await prepare("rw");
    expect(plan.binds).toContain("/host/agents-ro:/workspace/.agents:ro,z");
    expect(plan.binds).toContain("/host/agents-ro/skills:/workspace/.agents/skills:ro,z");
  });

  it("keeps a writable Gateway child under a read-only Gateway ancestor writable", async () => {
    fs.mkdirSync(path.join(root, "agent/.agents/output"));
    const namespace = await resolveDockerSourceNamespace(engine);
    vi.mocked(resolveDockerSourceNamespace).mockResolvedValue([
      ...namespace!,
      namespaceBind("/host/agents-ro", path.join(root, "agent/.agents"), false),
      namespaceBind("/host/agents-output", path.join(root, "agent/.agents/output")),
    ]);
    const plan = await prepare("rw");
    expect(plan.binds).toContain("/host/agents-ro:/workspace/.agents:ro,z");
    expect(plan.binds).toContain("/host/agents-output:/workspace/.agents/output:z");
    expect(plan.binds).toContain("/host/agents-ro/skills:/workspace/.agents/skills:ro,z");
  });

  it("detects a retained container created before ancestor pinning as a mount change", async () => {
    const plan = await prepare("rw");
    await expectMounts(
      plan,
      [
        bind("/host/agent", "/workspace"),
        bind("/host/agent/skills", "/workspace/skills", false),
        bind("/host/agent/.agents/skills", "/workspace/.agents/skills", false),
        bind("/host/materialized skills/skills", skillsTarget, false),
      ],
      null,
      false,
    );
  });

  it("refuses a symlinked protected-mount ancestor without creating outside the workspace", async () => {
    const outside = path.join(root, "outside-ancestor");
    fs.mkdirSync(outside);
    fs.symlinkSync(
      outside,
      path.join(root, "agent/.openclaw"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(prepare("rw")).rejects.toThrow();
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("does not pin ancestors below a read-only workspace", async () => {
    const plan = await prepare("ro", { workspaceDir: path.join(root, "agent") });
    expect(plan.binds.some((spec) => spec.includes(":/workspace/.agents:"))).toBe(false);
  });

  it("keeps meaningful source and target whitespace through create and retained comparison", async () => {
    const plan = await prepare("rw", {
      workspaceDir: path.join(root, "empty"),
      agentWorkspaceDir: path.join(root, "empty"),
      binds: ["/daemon/A:/data:ro", "/daemon/B :/data :rw"],
    });
    expect(plan.binds).toEqual([
      "/host/state/empty:/workspace:z",
      "/host/state/empty/.openclaw:/workspace/.openclaw:z",
      "/host/state/empty/.openclaw/sandbox-skills:/workspace/.openclaw/sandbox-skills:z",
      skillsBind,
      "/daemon/A:/data:ro",
      "/daemon/B :/data :rw",
    ]);
    await expectMounts(plan, [
      bind("/host/state/empty", "/workspace"),
      bind("/host/state/empty/.openclaw", "/workspace/.openclaw"),
      bind("/host/state/empty/.openclaw/sandbox-skills", "/workspace/.openclaw/sandbox-skills"),
      bind("/host/materialized skills/skills", skillsTarget, false),
      bind("/daemon/A", "/data", false),
      bind("/daemon/B ", "/data "),
    ]);
  });

  it("honors a normalized custom override without translating the replaced source", async () => {
    vi.mocked(resolveDockerSourceNamespace).mockResolvedValue([]);
    const plan = await prepare("ro", {
      workspaceDir: path.join(root, "agent"),
      binds: ["/custom/project:/workspace/:ro"],
    });
    expect(plan.binds).toEqual(["/custom/project:/workspace/:ro"]);
  });

  it.each(["ro", "rw"] as const)(
    "projects nested binds and protected skill descendants with %s permissions",
    async (access) => {
      const namespace = await resolveDockerSourceNamespace(engine);
      vi.mocked(resolveDockerSourceNamespace).mockResolvedValue([
        ...namespace!,
        ...["private", "agent"].flatMap((workspace) => [
          namespaceBind(`/host/${workspace}-data`, path.join(root, workspace, "data"), false),
          namespaceBind(`/host/${workspace}-nested`, path.join(root, workspace, "data/nested")),
          namespaceBind(`/host/${workspace}-skill`, path.join(root, workspace, "skills/nested")),
        ]),
        namespaceBind("/host/materialized-skill", path.join(root, "materialized/skills/nested")),
      ]);
      const plan = await prepare(access);
      const workspace = access === "rw" ? "agent" : "private";
      expect(plan.binds).toContain(`/host/${workspace}-data:/workspace/data:ro,z`);
      expect(plan.binds).toContain(
        `/host/${workspace}-nested:/workspace/data/nested:${access === "ro" ? "ro,z" : "z"}`,
      );
      expect(plan.binds).toContain(`/host/${workspace}-skill:/workspace/skills/nested:ro,z`);
      if (access === "rw") {
        expect(plan.binds).toContain(`/host/materialized-skill:${skillsTarget}/nested:ro,z`);
      }
    },
  );

  it("rejects visible nested non-bind storage but respects a custom subtree override", async () => {
    const namespace = await resolveDockerSourceNamespace(engine);
    vi.mocked(resolveDockerSourceNamespace).mockResolvedValue([
      ...namespace!,
      { ...namespaceBind("/private/storage", path.join(root, "private/data")), type: "volume" },
      namespaceBind("/host/hidden", path.join(root, "private/data/nested")),
    ]);
    await expect(prepare("none")).rejects.toThrow("unsupported nested volume mount");
    const plan = await prepare("none", {
      binds: ["/custom/data:/workspace/data/:ro"],
    });
    expect(plan.binds).toContain("/custom/data:/workspace/data/:ro");
    expect(plan.binds.some((mount) => mount.startsWith("/host/hidden:"))).toBe(false);
  });
});

describe("retained mount identity", () => {
  it.runIf(process.platform !== "win32").each(["/host/a\\b", "/host/a/b"])(
    "compares literal POSIX source bytes for retained %s",
    async (source) => {
      const plan = await prepareEmpty({
        binds: ["/host/a\\b:/data:ro"],
      });
      await expectMounts(
        plan,
        [bind("/host/state/empty", "/workspace"), bind(source, "/data", false)],
        null,
        source === "/host/a\\b",
      );
    },
  );

  it.each(["tmpfs", "volume"])(
    "distinguishes configured tmpfs removal from implicit %s below a bind",
    async (type) => {
      const plan = await prepareEmpty();
      await expectMounts(
        plan,
        [
          bind("/host/state/empty", "/workspace"),
          ...(type === "tmpfs"
            ? []
            : [{ ...bind("/engine/storage", "/workspace/cache"), Type: type }]),
        ],
        type === "tmpfs" ? { "/workspace/cache": "rw" } : null,
        type !== "tmpfs",
      );
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
      const plan = await prepareEmpty({
        tmpfs: [`/workspace/cache:${configured}`],
      });
      await expectMounts(
        plan,
        [bind("/host/state/empty", "/workspace")],
        {
          "/workspace/cache": actual,
          "/run": "rw,nosuid,nodev",
        },
        matches,
      );
    },
  );

  it("accepts an unchanged mount with a trailing-slash workdir and ignores unrelated image volumes", async () => {
    const plan = await prepareEmpty({ workdir: "/workspace/" });
    expect(plan.binds).toEqual(["/host/state/empty:/workspace:z"]);
    await expectMounts(
      plan,
      [
        bind("/host/state/empty", "/workspace/"),
        { Type: "volume", Source: "/engine/volume", Destination: "/image-data", RW: true },
      ],
      { "/tmp": "rw" },
    );
  });

  it.each([
    ["removed", bind("/old/source", "/agent", false), null],
    ["source", bind("/old/data", "/workspace/data", false), null],
    ["permission", bind("/host/data", "/workspace/data"), null],
    ["type", { ...bind("/host/data", "/workspace/data", false), Type: "volume" }, null],
    ["tmpfs", bind("/host/data", "/workspace/data", false), { "/workspace/data": "rw" }],
  ] as const)("rejects a stale custom bind %s", async (change, mount, tmpfs) => {
    const plan = await prepareEmpty({
      binds: change === "removed" ? [] : ["/host/data:/workspace/data:ro"],
    });
    await expectMounts(plan, [bind("/host/state/empty", "/workspace"), mount], tmpfs, false);
  });

  it("accepts intentional custom binds and case-insensitive Windows sources at managed destinations", async () => {
    vi.mocked(resolveDockerSourceNamespace).mockResolvedValue(undefined);
    const plan = await prepare("ro", {
      workspaceDir: "C:/Users/Example/project",
      agentWorkspaceDir: "C:/Users/Example/project",
      binds: ["D:\\Skills:/workspace/skills:ro"],
    });
    await expectMounts(plan, [
      bind("c:\\users\\example\\project", "/workspace", false),
      bind("d:\\skills", "/workspace/skills", false),
    ]);
  });
});

it.each([false, true])(
  "checks visible workspace backing for a running=%s container",
  async (running) => {
    const workspaceDir = path.join(root, "private");
    let source = "/host/state/private";
    let nested: { Type: string; Source?: string; Destination: string; RW: boolean }[] = [];
    vi.mocked(execContainer).mockImplementation(async (_engine, args) => {
      const stdout = args.includes("{{.Id}} {{.State.Running}} {{.State.Paused}}")
        ? `${"a".repeat(64)} ${running} false`
        : args[0] === "inspect"
          ? JSON.stringify({
              Mounts: [bind(source, "/workspace"), ...nested],
              Tmpfs: {},
            })
          : "1 1 0:1 / / rw - overlay overlay rw\n2 1 0:2 /private /workspace rw - ext4 /dev/root rw\n";
      return { stdout, stderr: "", code: 0 };
    });
    const read = () =>
      sandboxContainerShowsWorkspacePaths({
        engine,
        containerName: "owned",
        workspaceDir,
        containerRoot: "/workspace/",
        targets: ["/workspace/cache/screenshot.png"],
        assertCurrent() {},
      });
    await expect(read()).resolves.toBe(true);
    vi.mocked(resolveDockerSourceNamespace).mockResolvedValue(undefined);
    source = workspaceDir;
    await expect(read()).resolves.toBe(true);
    for (const Type of ["tmpfs", "volume", "bind"]) {
      nested = [{ Type, Source: "/different/source", Destination: "/workspace/cache", RW: true }];
      await expect(read()).resolves.toBe(false);
    }
  },
);

it("accepts an ancestor self-bind backing the same workspace bytes for image reads", async () => {
  const workspaceDir = path.join(root, "private");
  let agentsSource = "/host/state/private/.agents";
  vi.mocked(execContainer).mockImplementation(async (_engine, args) => {
    const stdout = args.includes("{{.Id}} {{.State.Running}} {{.State.Paused}}")
      ? `${"a".repeat(64)} false false`
      : JSON.stringify({
          Mounts: [
            bind("/host/state/private", "/workspace"),
            bind(agentsSource, "/workspace/.agents"),
            bind("/host/state/private/.agents/skills", "/workspace/.agents/skills", false),
          ],
          Tmpfs: {},
        });
    return { stdout, stderr: "", code: 0 };
  });
  const read = () =>
    sandboxContainerShowsWorkspacePaths({
      engine,
      containerName: "owned",
      workspaceDir,
      containerRoot: "/workspace",
      targets: ["/workspace/.agents/preview.png"],
      assertCurrent() {},
    });
  await expect(read()).resolves.toBe(true);
  agentsSource = "/different/source";
  await expect(read()).resolves.toBe(false);
});
