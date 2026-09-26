import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { getAgentWorkspaceAccess } from "openclaw/plugin-sdk/agent-workspace-runtime";
import type {
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { registerNodeWorkspaces } from "./workspace-service.js";
import { createNodeWorkspaceTestTransport } from "./workspace-service.test-support.js";

vi.mock("openclaw/plugin-sdk/agent-workspace-runtime", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("openclaw/plugin-sdk/agent-workspace-runtime")>();
  const { fileURLToPath } = await import("node:url");
  // Source children run outside the checkout. Keep ESM dependencies native and
  // resolve source aliases with the repository tsconfig, as other source fixtures do.
  const register = `import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))}; register({ tsconfig: ${JSON.stringify(fileURLToPath(new URL("../../../tsconfig.json", import.meta.url)))} });`;
  return {
    ...original,
    resolveWorkspaceWorkerArgv(kind: "memory" | "skills") {
      const argv = original.resolveWorkspaceWorkerArgv(kind);
      return argv[0] === "--import"
        ? ["--import", `data:text/javascript,${encodeURIComponent(register)}`, ...argv.slice(2)]
        : argv;
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.unstubAllEnvs();
});

async function createSkillService(options?: { stopAfterChunk?: boolean }) {
  const parent = await fs.realpath(tempDirs.make("node-skill-companion-test-"));
  const local = path.join(parent, "gateway");
  const remote = path.join(parent, "harness");
  await fs.mkdir(local);
  await fs.mkdir(remote);
  await fs.writeFile(path.join(local, "AGENTS.md"), "Gateway decoy");
  await fs.writeFile(path.join(remote, "AGENTS.md"), "Harness instructions");
  const nodePolicy = {
    allowReadPaths: [remote, `${remote}/**`],
    allowWritePaths: [`${remote}/AGENTS.md`],
    followSymlinks: false,
    ask: "off" as const,
  };
  const pluginConfig = {
    policyVersion: 2,
    workspaces: { main: { nodeId: "node-1", remoteRoot: remote } },
    nodes: { "node-1": nodePolicy },
  };
  const invoke = vi.fn<OpenClawPluginApi["runtime"]["nodes"]["invoke"]>();
  let service: OpenClawPluginService;
  const api = createTestPluginApi({
    registrationMode: "full",
    config: { plugins: { entries: { "file-transfer": { config: pluginConfig } } } },
    pluginConfig,
    runtime: {
      agent: { resolveAgentWorkspaceDir: () => local },
      nodes: { invoke },
    } as unknown as OpenClawPluginApi["runtime"],
    registerService: (value) => {
      service = value;
    },
  });
  registerNodeWorkspaces(api);
  const output: Uint8Array[] = [];
  const openNodeDuplex = createNodeWorkspaceTestTransport(
    api,
    remote,
    options?.stopAfterChunk
      ? () => {
          void service.stop?.(context);
        }
      : undefined,
    (bytes) => output.push(bytes),
  );
  const context: OpenClawPluginServiceContext = {
    config: api.config,
    logger: api.logger,
    stateDir: local,
    invokeNode: invoke,
    openNodeDuplex,
  };
  return { context, local, nodePolicy, output, remote, service: service! };
}

it("discovers Harness Skills, reads their source and installs a dependency on the Harness", async ({
  onTestFinished,
}) => {
  const { context, local, nodePolicy, remote, service } = await createSkillService();
  const home = await fs.realpath(tempDirs.make("node-skills-home-"));
  vi.stubEnv("HOME", home);
  // The test runner pins os.homedir separately from process.env.HOME.
  const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(home);
  onTestFinished(() => homeSpy.mockRestore());
  const skillDir = path.join(remote, "skills", "local-tool");
  await fs.mkdir(skillDir, { recursive: true });
  const instructions =
    "---\nname: local-tool\ndescription: Test the workspace tool\n---\nRun local-tool.\n";
  await fs.writeFile(path.join(skillDir, "SKILL.md"), instructions);
  await fs.mkdir(path.join(skillDir, "refs"));
  await fs.writeFile(path.join(skillDir, "refs/support.txt"), "Harness companion");
  const packageDir = path.join(remote, "package");
  await fs.mkdir(packageDir);
  await fs.writeFile(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: "workspace-node-test-tool",
      version: "1.0.0",
      bin: { "local-tool": "cli.cjs" },
    }),
  );
  await fs.writeFile(
    path.join(packageDir, "cli.cjs"),
    '#!/usr/bin/env node\nconsole.log("Harness dependency works");\n',
    { mode: 0o755 },
  );
  const tarball = execFileSync("tar", ["-czf", "-", "-C", remote, "package"]);
  let registry = "";
  const registryRequests: string[] = [];
  const server = createServer((request, response) => {
    registryRequests.push(request.url ?? "");
    if (request.url === "/workspace-node-test-tool") {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          name: "workspace-node-test-tool",
          "dist-tags": { latest: "1.0.0" },
          versions: {
            "1.0.0": {
              name: "workspace-node-test-tool",
              version: "1.0.0",
              bin: { "local-tool": "cli.cjs" },
              dist: { tarball: `${registry}/fixture.tgz` },
            },
          },
        }),
      );
    } else if (request.url === "/fixture.tgz") {
      response.end(tarball);
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing fixture registry port");
  }
  registry = `http://127.0.0.1:${address.port}`;
  await fs.writeFile(
    path.join(home, ".npmrc"),
    `registry=${registry}\naudit=false\nfund=false\nupdate-notifier=false\nfetch-retries=0\n`,
  );
  nodePolicy.allowWritePaths.push(`${remote}/skills`);
  await service.start(context);
  try {
    const access = getAgentWorkspaceAccess(local)!;
    const sources = await access.loadSkills!({
      sourcePlan: {
        workspaceDir: local,
        stateDir: local,
        managedSkillsDir: path.join(local, "managed"),
        pluginSkillsDir: path.join(local, "plugins"),
        roots: [
          { dir: path.join(local, "skills"), source: "openclaw-workspace", tier: "workspace" },
        ],
        pluginSkillRoots: [],
      },
      limits: {
        maxCandidatesPerRoot: 100,
        maxSkillsLoadedPerSource: 100,
        maxSkillFileBytes: 65536,
      },
      additionalBins: [],
    });
    const skill = sources.entries.find((entry) => entry.skill.name === "local-tool")!.skill;
    expect(skill.filePath).toBe(path.join(skillDir, "SKILL.md"));
    expect(await access.skillResources!.readInstructions(skill.filePath, {})).toBe(instructions);
    expect(
      await access.skillResources!.readCompanion!(
        skill.filePath,
        "refs/support.txt",
        skill.sourceRootIdentity!,
        {},
      ),
    ).toBe("Harness companion");
    const result = await access.installSkillDependencies!({
      skillKey: "local-tool",
      spec: { kind: "node", package: "workspace-node-test-tool" },
      preferences: { nodeManager: "npm", preferBrew: false },
      timeoutMs: 30_000,
    });
    expect(result, JSON.stringify({ result, registryRequests })).toMatchObject({ ok: true });
    const executable = path.join(home, ".openclaw/tools/node/npm/bin/local-tool");
    expect(execFileSync(process.execPath, [executable], { encoding: "utf8" }).trim()).toBe(
      "Harness dependency works",
    );
    expect(await fs.readdir(local)).toEqual(["AGENTS.md"]);
  } finally {
    await service.stop?.(context);
  }
}, 60_000);

it("revokes a native Skill companion read before result delivery", async () => {
  const { context, local, output, remote, service } = await createSkillService({
    stopAfterChunk: true,
  });
  const skillDir = path.join(remote, "skills/local-tool");
  await fs.mkdir(path.join(skillDir, "refs"), { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: local-tool\ndescription: Test companion reads\n---\n",
  );
  await fs.writeFile(path.join(skillDir, "refs/support.txt"), "must not be returned");
  const selectedRoot = await fs.stat(skillDir, { bigint: true });
  const sourceRootIdentity = {
    realPath: await fs.realpath(skillDir),
    dev: selectedRoot.dev.toString(10),
    ino: selectedRoot.ino.toString(10),
  };
  await service.start(context);
  try {
    const reader = getAgentWorkspaceAccess(local)!.skillResources!;
    await expect(
      reader.readCompanion!(
        path.join(skillDir, "SKILL.md"),
        "refs/support.txt",
        sourceRootIdentity,
        {},
      ),
    ).rejects.toThrow();
    expect(output).toEqual([]);
  } finally {
    await service.stop?.(context);
  }
});

it("rejects a replaced selected Skill root before production transport delivery", async () => {
  const { context, local, output, remote, service } = await createSkillService();
  const skillDir = path.join(remote, "skills/local-tool");
  await fs.mkdir(path.join(skillDir, "refs"), { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: local-tool\ndescription: Test companion identity\n---\n",
  );
  await fs.writeFile(path.join(skillDir, "refs/support.txt"), "selected companion");
  await service.start(context);
  try {
    const access = getAgentWorkspaceAccess(local)!;
    const sources = await access.loadSkills!({
      sourcePlan: {
        workspaceDir: local,
        managedSkillsDir: path.join(local, "managed"),
        roots: [
          { dir: path.join(local, "skills"), source: "openclaw-workspace", tier: "workspace" },
        ],
        pluginSkillRoots: [],
      },
      limits: {
        maxCandidatesPerRoot: 100,
        maxSkillsLoadedPerSource: 100,
        maxSkillFileBytes: 65536,
      },
      additionalBins: [],
    });
    const skill = sources.entries.find((entry) => entry.skill.name === "local-tool")!.skill;
    expect(skill.sourceRootIdentity).toMatchObject({
      realPath: skillDir,
      dev: expect.any(String),
      ino: expect.any(String),
    });
    await expect(
      access.skillResources!.readCompanion!(
        skill.filePath,
        "refs/support.txt",
        skill.sourceRootIdentity!,
        {},
      ),
    ).resolves.toBe("selected companion");

    await fs.rename(skillDir, `${skillDir}-selected`);
    await fs.mkdir(path.join(skillDir, "refs"), { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: local-tool\ndescription: Replacement\n---\n",
    );
    await fs.writeFile(path.join(skillDir, "refs/support.txt"), "replacement companion");
    output.length = 0;
    await expect(
      access.skillResources!.readCompanion!(
        skill.filePath,
        "refs/support.txt",
        skill.sourceRootIdentity!,
        {},
      ),
    ).rejects.toThrow();
    expect(output).toEqual([]);
  } finally {
    await service.stop?.(context);
  }
});
