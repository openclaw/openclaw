// Proves the shared-directory topology on the Docker sandbox backend: each agent keeps a
// private workspace no peer can reach, while one shared host directory is read-write for all
// of them. The shared root is admitted by `docker.allowedBindSources` alone, so the
// all-or-nothing external-source override stays unnecessary for this shape. The non-Docker
// allowlist boundary cases live in src/agents/sandbox-create-args.test.ts.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { captureEnv, setTestEnvValue } from "../../test-utils/env.js";
import { DEFAULT_SANDBOX_IMAGE } from "./constants.js";
import { DOCKER_SANDBOX_ENGINE } from "./container-engine.js";
import { resolveSandboxDockerUser } from "./docker-user.js";
import { ensureSandboxContainer } from "./docker.js";
import type { SandboxConfig } from "./types.js";

const CONTAINER_PREFIX = "openclaw-bindproof-";
// The default sandbox image carries the helpers the sandbox write/edit bridge needs, so this
// runs on the same image real agents get (build: scripts/sandbox-setup.sh).
const IMAGE = DEFAULT_SANDBOX_IMAGE;
const SHARED_MOUNT = "/team";
const tempDirs = useAutoCleanupTempDirTracker(afterAll);

function execFileAsync(
  file: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code =
        error && typeof (error as { code?: unknown }).code === "number"
          ? (error as { code: number }).code
          : error
            ? 1
            : 0;
      resolve({ stdout, stderr, code });
    });
  });
}

async function dockerReady(): Promise<boolean> {
  const probe = await execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"]);
  if (probe.code !== 0) {
    return false;
  }
  // ensureDockerImage never pulls on demand, so a missing local image is an environment gap
  // rather than a topology failure.
  const image = await execFileAsync("docker", ["image", "inspect", IMAGE]);
  return image.code === 0;
}

let root = "";
let stateDir = "";
let envSnapshot: { restore: () => void } | undefined;
const containerNames: string[] = [];

type Member = {
  id: string;
  workspaceDir: string;
  privateFile: string;
};

const members: Record<"one" | "two", Member> = {
  one: { id: "member-one", workspaceDir: "", privateFile: "ONE.md" },
  two: { id: "member-two", workspaceDir: "", privateFile: "TWO.md" },
};

let sharedDir = "";

function buildSandboxConfig(): SandboxConfig {
  return {
    mode: "all",
    backend: "docker",
    scope: "agent",
    workspaceAccess: "rw",
    workspaceRoot: root,
    dockerTmpfsSource: "configured",
    docker: {
      image: IMAGE,
      containerPrefix: CONTAINER_PREFIX,
      workdir: "/workspace",
      readOnlyRoot: false,
      tmpfs: [],
      network: "none",
      capDrop: [],
      binds: [`${sharedDir}:${SHARED_MOUNT}:rw`],
      allowedBindSources: [sharedDir],
    },
    ssh: {
      command: "ssh",
      workspaceRoot: "/tmp/openclaw-sandboxes",
      strictHostKeyChecking: true,
      updateHostKeys: true,
    },
    browser: {
      enabled: false,
      image: "unused",
      containerPrefix: CONTAINER_PREFIX,
      network: "none",
      cdpPort: 0,
      vncPort: 0,
      noVncPort: 0,
      headless: true,
      noVncEnabled: false,
      allowHostControl: false,
      autoStart: false,
      autoStartTimeoutMs: 1,
    },
    tools: {},
    prune: { idleHours: 0, maxAgeDays: 0 },
  };
}

// Resolves docker.user from workspace ownership as resolveProvisionedSandboxContext does. Without
// it the container runs as the image's uid 1000 and cannot write a runner-owned shared directory
// on a Linux host.
async function memberSandboxConfig(member: Member): Promise<SandboxConfig> {
  const cfg = buildSandboxConfig();
  const docker = await resolveSandboxDockerUser({
    backend: cfg.backend,
    docker: cfg.docker,
    workspaceDir: member.workspaceDir,
  });
  return { ...cfg, docker };
}

function memberParams(member: Member) {
  // Agent scope keys start with `agent:<id>`, so the refusal's recreate hint names the agent.
  // With workspaceAccess "rw" the mounted workspace is the agent workspace, as in production.
  return {
    engine: DOCKER_SANDBOX_ENGINE,
    scopeKey: `agent:${member.id}`,
    workspaceDir: member.workspaceDir,
    agentWorkspaceDir: member.workspaceDir,
  };
}

async function startMember(member: Member) {
  const runtime = await ensureSandboxContainer({
    ...memberParams(member),
    cfg: await memberSandboxConfig(member),
  });
  containerNames.push(runtime.containerName);
  return runtime;
}

let started: Record<"one" | "two", { containerName: string; containerId: string }> | undefined;

async function containerShell(name: string, script: string) {
  return await execFileAsync("docker", ["exec", "-i", name, "/bin/sh", "-lc", script]);
}

beforeAll(async () => {
  // macOS os.tmpdir() is a /var -> /private/var symlink; sandbox mount policy compares
  // canonical paths, so the fixture root must already be canonical.
  root = await fs.realpath(tempDirs.make("openclaw-bindproof-"));
  // The sandbox registry writes to the shared state DB. Own that path explicitly so the run
  // cannot reach a real state directory.
  stateDir = path.join(root, "state-root");
  envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  sharedDir = path.join(root, "shared");
  await fs.mkdir(sharedDir, { recursive: true });
  await fs.writeFile(path.join(sharedDir, "SHARED.md"), "shared notes\n");
  for (const member of Object.values(members)) {
    member.workspaceDir = path.join(root, "private", member.id);
    await fs.mkdir(member.workspaceDir, { recursive: true });
    await fs.writeFile(path.join(member.workspaceDir, member.privateFile), `${member.id}\n`);
  }
  if (await dockerReady()) {
    // Both cases share these two containers so the suite boots each agent runtime once.
    started = { one: await startMember(members.one), two: await startMember(members.two) };
  }
}, 300_000);

afterAll(async () => {
  for (const name of containerNames) {
    await execFileAsync("docker", ["rm", "-f", name]);
  }
  envSnapshot?.restore();
}, 120_000);

describe("sandbox allowed bind sources", () => {
  it("gives each agent a private workspace and one shared directory", async (ctx) => {
    if (!started) {
      ctx.skip(`docker daemon or ${IMAGE} unavailable`);
      return;
    }
    const nameOne = started.one.containerName;
    const nameTwo = started.two.containerName;
    expect(nameOne).not.toBe(nameTwo);

    // Private: each agent sees only its own file at /workspace.
    const own = await containerShell(nameOne, "cat /workspace/ONE.md");
    expect(own.code).toBe(0);
    expect(own.stdout).toContain(members.one.id);

    const cross = await containerShell(nameOne, "cat /workspace/TWO.md");
    expect(cross.code).not.toBe(0);

    // The peer's host path does not exist in this mount namespace at all.
    const hostPathProbe = await containerShell(
      nameOne,
      `test -e ${JSON.stringify(members.two.workspaceDir)} && echo VISIBLE || echo ABSENT`,
    );
    expect(hostPathProbe.stdout.trim()).toBe("ABSENT");

    // Shared: both agents mount the same host directory read-write.
    const readShared = await containerShell(nameTwo, `cat ${SHARED_MOUNT}/SHARED.md`);
    expect(readShared.code).toBe(0);
    expect(readShared.stdout).toContain("shared notes");

    const write = await containerShell(
      nameOne,
      `printf 'from-one\\n' > ${SHARED_MOUNT}/handoff.md`,
    );
    expect(write.code).toBe(0);
    const readBack = await containerShell(nameTwo, `cat ${SHARED_MOUNT}/handoff.md`);
    expect(readBack.code).toBe(0);
    expect(readBack.stdout).toContain("from-one");

    // The host sees the same file, so the shared directory is one artifact, not a copy.
    await expect(fs.readFile(path.join(sharedDir, "handoff.md"), "utf8")).resolves.toContain(
      "from-one",
    );

    // Mount set is the enforcement boundary: the peer workspace is never a source.
    const inspect = await execFileAsync("docker", ["inspect", "-f", "{{json .Mounts}}", nameOne]);
    expect(inspect.code).toBe(0);
    const sources = (JSON.parse(inspect.stdout) as Array<{ Source: string }>).map(
      (mount) => mount.Source,
    );
    expect(sources).toContain(members.one.workspaceDir);
    expect(sources).toContain(sharedDir);
    expect(sources).not.toContain(members.two.workspaceDir);
    expect(sources.some((source) => source.includes(members.two.id))).toBe(false);

    // Registry rows landed in the test-owned state DB.
    const statePath = resolveOpenClawStateSqlitePath();
    expect(statePath.startsWith(stateDir)).toBe(true);
    await expect(fs.stat(statePath)).resolves.toBeDefined();
  }, 300_000);

  it("refuses a hot container once its root is revoked, keeps it, and reuses it when the root returns", async (ctx) => {
    if (!started) {
      ctx.skip(`docker daemon or ${IMAGE} unavailable`);
      return;
    }
    const params = memberParams(members.one);
    const granted = started.one;
    const grantedCfg = await memberSandboxConfig(members.one);
    const revoked = { ...grantedCfg, docker: { ...grantedCfg.docker, allowedBindSources: [] } };

    await expect(ensureSandboxContainer({ ...params, cfg: revoked })).rejects.toThrow(
      /^Sandbox config changed for .+; the existing container was preserved .* is outside allowed roots/,
    );
    const kept = await execFileAsync("docker", [
      "inspect",
      "-f",
      "{{.Id}} {{.State.Running}}",
      granted.containerName,
    ]);
    expect(kept.stdout.trim()).toBe(`${granted.containerId} true`);
    const retained = await containerShell(granted.containerName, `cat ${SHARED_MOUNT}/SHARED.md`);
    expect(retained.stdout).toContain("shared notes");

    await expect(ensureSandboxContainer({ ...params, cfg: grantedCfg })).resolves.toEqual(granted);
  }, 300_000);
});
