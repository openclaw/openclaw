import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveExecWorkdir } from "./bash-tools.exec-workdir.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let workspaceDir: string;
beforeEach(() => {
  workspaceDir = tempDirs.make("openclaw-exec-workdir-");
});
afterEach(() => vi.restoreAllMocks());

function sandbox(overrides: Partial<BashSandboxConfig> = {}): BashSandboxConfig {
  return {
    containerName: "sandbox-workdir-test",
    workspaceDir,
    containerWorkdir: "/workspace",
    ...overrides,
  };
}
function backend(overrides: Partial<BashSandboxConfig> = {}): BashSandboxConfig {
  return sandbox({
    containerWorkdir: "/remote/workspace/",
    workdirValidation: "backend",
    validateWorkdir: async (workdir) => workdir,
    ...overrides,
  });
}
const resolveSandbox = (workdir: string | undefined, config = sandbox()) =>
  resolveExecWorkdir({ host: "sandbox", workdir, sandbox: config });
const local = (options: { workdir?: string; defaultCwd?: string } = {}) =>
  resolveExecWorkdir({ host: "gateway", ...options });
const resolved = (
  hostCwd: string,
  containerCwd: string,
  scriptPreflightCwd: string | null = hostCwd,
) => ({ kind: "sandbox", hostCwd, containerCwd, scriptPreflightCwd });
const unavailable = (requestedCwd: string) => ({ kind: "unavailable", requestedCwd });
const expectUnavailable = (workdir: string, config = sandbox()) =>
  expect(resolveSandbox(workdir, config)).resolves.toEqual(unavailable(workdir));
const mount = (containerPath: string, hostPath: string) => ({ containerPath, hostPath });
async function skillMount() {
  const root = tempDirs.make("openclaw-skills-mount-");
  const demo = path.join(root, "demo");
  await mkdir(demo);
  return { root, demo };
}

it("canonicalizes local workdirs before approval and execution", async () => {
  const target = path.join(workspaceDir, "target"),
    link = path.join(workspaceDir, "link");
  await mkdir(target);
  await symlink(target, link, "dir");
  await expect(local({ workdir: ` ${link} ` })).resolves.toEqual({
    kind: "local",
    hostCwd: target,
  });
});
it("fails omitted local workdir when current cwd is unavailable", async () => {
  vi.spyOn(process, "cwd").mockImplementation(() => {
    throw new Error("cwd unavailable");
  });
  await expect(local()).resolves.toEqual(unavailable("current working directory"));
});
it("rejects missing configured local cwd without falling back to current cwd", async () => {
  const missing = path.join(workspaceDir, "missing");
  vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);
  await expect(local({ defaultCwd: missing })).resolves.toEqual(unavailable(missing));
});
it.each([
  [undefined, undefined, { kind: "node" }],
  ["/node/explicit", "/node/default", { kind: "node", remoteCwd: "/node/explicit" }],
  ["/node/trailing ", "/node/default", { kind: "node", remoteCwd: "/node/trailing " }],
  [" /node/leading", undefined, { kind: "node", remoteCwd: " /node/leading" }],
] as const)(
  "selects remote cwd for %s / %s without local validation",
  async (workdir, nodeCwd, expected) => {
    await expect(
      resolveExecWorkdir({ host: "node", workdir, nodeCwd, defaultCwd: "/gateway/default" }),
    ).resolves.toEqual(expected);
  },
);
it("uses the sandbox workspace when sandbox workdir is omitted", async () => {
  await expect(resolveSandbox(undefined)).resolves.toEqual(resolved(workspaceDir, "/workspace"));
});
it("rejects file sandbox workdirs", async () => {
  await writeFile(path.join(workspaceDir, "not-dir"), "not a directory");
  await expect(
    resolveExecWorkdir({ host: "sandbox", defaultCwd: "/workspace/not-dir", sandbox: sandbox() }),
  ).resolves.toEqual(unavailable("/workspace/not-dir"));
});
it.each<[string, () => string, () => BashSandboxConfig]>([
  ["outside workspace", () => tempDirs.make("openclaw-outside-"), () => sandbox()],
  ["parent segments", () => "missing/..", () => sandbox()],
  ["outside backend roots", () => "/other/remote/workspace", () => backend()],
  [
    "backend refusal",
    () => "/remote/workspace/missing",
    () => backend({ validateWorkdir: async () => null }),
  ],
])("rejects sandbox workdir: %s", async (_kind, workdir, config) =>
  expectUnavailable(workdir(), config()),
);
it.each(["host", "backend"] as const)(
  "rejects workspace symlink escape with %s validation",
  async (validation) => {
    const escape = path.join(workspaceDir, "escape");
    await symlink(tempDirs.make("openclaw-outside-"), escape, "dir");
    await expectUnavailable(
      validation === "backend" ? escape : "escape",
      validation === "backend" ? backend() : sandbox(),
    );
  },
);
it("uses the most specific approved mount regardless of input order", async () => {
  const broad = tempDirs.make("openclaw-broad-mount-");
  const { root, demo } = await skillMount();
  await mkdir(path.join(broad, "skills", "demo"), { recursive: true });
  const config = sandbox({
    readOnlyWorkspaceSkillMounts: [
      mount("/workspace/.openclaw", broad),
      mount("/workspace/.openclaw/skills", root),
    ],
  });
  await expect(resolveSandbox("/workspace/.openclaw/skills/demo", config)).resolves.toEqual(
    resolved(demo, "/workspace/.openclaw/skills/demo"),
  );
});
it.each(["sibling prefix", "symlink escape"])("rejects approved-mount %s", async (kind) => {
  const { root } = await skillMount();
  if (kind === "symlink escape") {
    await symlink(tempDirs.make("openclaw-outside-"), path.join(root, "escape"), "dir");
  }
  const config = sandbox({ readOnlyWorkspaceSkillMounts: [mount("/workspace/skills", root)] });
  await expectUnavailable(
    kind === "sibling prefix" ? "/workspace/skills-shadow/demo" : "/workspace/skills/escape",
    config,
  );
});
it.each([
  ["/agent/project", "/agent/project", { workdirRoots: ["/agent"] }],
  ["build", "/remote/workspace/build", {}],
  ["/generated", "/generated", { containerWorkdir: "/" }],
] satisfies Array<[string, string, Partial<BashSandboxConfig>]>)(
  "validates backend workdir %s as %s",
  async (workdir, expected, overrides) => {
    if (workdir === "build") {
      await writeFile(path.join(workspaceDir, "build"), "stale local mirror file");
    }
    const validateWorkdir = vi.fn(async (cwd: string) => cwd);
    await expect(
      resolveSandbox(workdir, backend({ ...overrides, validateWorkdir })),
    ).resolves.toEqual(resolved(workspaceDir, expected, null));
    expect(validateWorkdir).toHaveBeenCalledWith(expected);
  },
);
it("prefers backend skill mounts over an overlapping host workspace path", async () => {
  const { root, demo } = await skillMount();
  const containerRoot = path.join(workspaceDir, ".openclaw", "skills");
  await mkdir(path.join(containerRoot, "demo"), { recursive: true });
  const validateWorkdir = vi.fn(async (cwd: string) => cwd);
  const config = backend({
    validateWorkdir,
    readOnlyWorkspaceSkillMounts: [mount(containerRoot, root)],
  });
  await expect(resolveSandbox(`${containerRoot}/demo`, config)).resolves.toEqual(
    resolved(demo, `${containerRoot}/demo`),
  );
  expect(validateWorkdir).toHaveBeenCalledWith(`${containerRoot}/demo`);
});
