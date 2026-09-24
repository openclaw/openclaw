import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import {
  getAgentWorkspaceAccess,
  prepareAgentWorkspaceAttachments,
} from "openclaw/plugin-sdk/agent-workspace-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import type {
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished as onTestComplete,
  vi,
} from "vitest";
import { handleDirList } from "./node-host/dir-list.js";
import { handleFileFetch } from "./node-host/file-fetch.js";
import { handleFileStat } from "./node-host/file-stat.js";
import { handleFileWrite } from "./node-host/file-write.js";
import { createFileTransferNodeInvokePolicy } from "./shared/node-invoke-policy.js";
import { createCtx } from "./shared/node-invoke-policy.test-support.js";
import { registerNodeWorkspaces } from "./workspace-service.js";
import { createNodeWorkspaceTestTransport } from "./workspace-service.test-support.js";

vi.mock("./shared/audit.js", () => ({ appendFileTransferAudit: vi.fn() }));

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
let local: string;
let remote: string;
let service: OpenClawPluginService;
let api: OpenClawPluginApi;
let nodePolicy: {
  allowReadPaths: string[];
  allowWritePaths: string[];
  denyPaths?: string[];
  followSymlinks: boolean;
  ask: "off";
  maxBytes?: number;
};
let invoke: ReturnType<typeof vi.fn<OpenClawPluginApi["runtime"]["nodes"]["invoke"]>>;

let openDuplex: OpenClawPluginServiceContext["openNodeDuplex"];
function context() {
  return {
    config: api.config,
    logger: api.logger,
    stateDir: local,
    invokeNode: invoke,
    openNodeDuplex: openDuplex,
  };
}

beforeEach(async () => {
  openDuplex = undefined;
  const parent = await fs.realpath(tempDirs.make("node-workspace-test-"));
  local = path.join(parent, "gateway");
  remote = path.join(parent, "harness");
  await fs.mkdir(local);
  await fs.mkdir(remote);
  await fs.writeFile(path.join(local, "AGENTS.md"), "Gateway decoy");
  await fs.writeFile(path.join(remote, "AGENTS.md"), "Harness instructions");
  nodePolicy = {
    allowReadPaths: [remote, `${remote}/**`],
    allowWritePaths: [`${remote}/AGENTS.md`],
    followSymlinks: false,
    ask: "off",
  };
  const pluginConfig = {
    policyVersion: 2,
    workspaces: { main: { nodeId: "node-1", remoteRoot: remote } },
    nodes: {
      "node-1": nodePolicy,
    },
  };
  invoke = vi.fn(async (request) => {
    expect(request.nodeId).toBe("node-1");
    const { ctx, invokeNode } = createCtx({
      command: request.command,
      params: request.params as Record<string, unknown>,
      pluginConfig,
    });
    invokeNode.mockImplementation(async ({ params } = {}) => {
      switch (request.command) {
        case "file.fetch":
          return {
            ok: true,
            payload: await handleFileFetch(params as Parameters<typeof handleFileFetch>[0]),
          };
        case "file.stat":
          return {
            ok: true,
            payload: await handleFileStat(params as Parameters<typeof handleFileStat>[0]),
          };
        case "file.write":
          return {
            ok: true,
            payload: await handleFileWrite(params as Parameters<typeof handleFileWrite>[0]),
          };
        case "dir.list":
          return {
            ok: true,
            payload: await handleDirList(params as Parameters<typeof handleDirList>[0]),
          };
        default:
          throw new Error(`Unexpected command ${request.command}`);
      }
    });
    const result = await createFileTransferNodeInvokePolicy().handle(ctx);
    if (!result.ok) {
      throw new Error(`${result.code}: ${result.message}`);
    }
    return result;
  });
  api = createTestPluginApi({
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
});

afterEach(async () => {
  await service.stop?.(context());
  vi.unstubAllEnvs();
});

describe("registered node workspace service", () => {
  it("discovers Harness Skills, reads their source and installs a dependency on the Harness", async ({
    onTestFinished,
  }) => {
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
    openDuplex = createNodeWorkspaceTestTransport(api, remote);
    await service.start(context());
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
  }, 60_000);

  it.each(["workspace", "execution", "symlink", "skill card", "byte limit"])(
    "does not send denied Skill discovery metadata (%s)",
    async (kind) => {
      const workspace = kind === "execution" ? path.join(remote, "execution") : remote;
      const skillDir = path.join(workspace, "skills", "private-tool");
      await fs.mkdir(skillDir, { recursive: true });
      const skillFile = path.join(skillDir, "SKILL.md");
      const instructionFile = kind === "symlink" ? path.join(skillDir, "private.md") : skillFile;
      const deniedFile =
        kind === "skill card" ? path.join(skillDir, "skill-card.md") : instructionFile;
      await fs.writeFile(
        instructionFile,
        "---\nname: private-tool\ndescription: Private metadata\n---\nPrivate instructions.\n",
      );
      if (kind === "skill card") {
        await fs.writeFile(deniedFile, "Private skill card");
      }
      if (kind === "symlink") {
        await fs.symlink("private.md", skillFile);
        nodePolicy.followSymlinks = true;
      }
      const output: Uint8Array[] = [];
      openDuplex = createNodeWorkspaceTestTransport(api, remote, undefined, (bytes) =>
        output.push(bytes),
      );
      await service.start(context());
      const request = {
        sourcePlan: {
          workspaceDir: local,
          managedSkillsDir: path.join(local, "managed"),
          roots: [
            {
              dir: path.join(local, "skills"),
              source: "openclaw-workspace",
              tier: "workspace" as const,
            },
          ],
          pluginSkillRoots: [],
        },
        executionWorkspaceDir: kind === "execution" ? path.join(local, "execution") : undefined,
        limits: {
          maxCandidatesPerRoot: 100,
          maxSkillsLoadedPerSource: 100,
          maxSkillFileBytes: 65536,
        },
        additionalBins: [],
        status: kind === "skill card" ? { skillCardKey: "private-tool" } : undefined,
      };
      const loadSkills = getAgentWorkspaceAccess(local)!.loadSkills!;
      const allowed = await loadSkills(request);
      const entries = kind === "execution" ? allowed.executionEntries : allowed.entries;
      expect(entries.map((entry) => entry.skill.name)).toContain("private-tool");
      if (kind === "skill card") {
        expect(allowed.status?.files[0]?.skillCard?.content).toBe("Private skill card");
      }
      expect(output.length).toBeGreaterThan(0);
      if (kind === "byte limit") {
        nodePolicy.maxBytes = 1;
      } else {
        nodePolicy.denyPaths = [deniedFile];
      }
      output.length = 0;
      await expect(loadSkills(request)).rejects.toMatchObject({
        message: "Remote workspace skill discovery failed",
        cause: {
          message: expect.stringContaining(
            kind === "byte limit" ? "response exceeds" : "denied by the node file read policy",
          ),
        },
      });
      expect(output).toEqual([]);
    },
  );

  it.each(["file", "symlink"])(
    "does not send a Skill bundle containing a denied child %s",
    async (kind) => {
      const skillDir = path.join(remote, "skills", "local-tool");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        "---\nname: local-tool\ndescription: Test resources\n---\nUse supporting files.\n",
      );
      const privatePath = path.join(skillDir, "private.txt");
      await fs.writeFile(privatePath, "Private bytes");
      if (kind === "symlink") {
        await fs.symlink("private.txt", path.join(skillDir, "alias.txt"));
        nodePolicy.followSymlinks = true;
      }
      const output: Uint8Array[] = [];
      openDuplex = createNodeWorkspaceTestTransport(api, remote, undefined, (bytes) =>
        output.push(bytes),
      );
      await service.start(context());
      const reader = getAgentWorkspaceAccess(local)!.skillResources!;
      const skill = await reader.resolveExplicitSkill({
        name: "local-tool",
        path: path.join(skillDir, "SKILL.md"),
      });
      expect(skill).not.toBeNull();
      const files = await reader.readSkillFiles(skill!, { allowMissingRoot: false });
      expect(files?.some((file) => file.path === "private.txt")).toBe(true);
      nodePolicy.denyPaths = [privatePath];
      output.length = 0;

      await expect(reader.readSkillFiles(skill!, { allowMissingRoot: false })).rejects.toThrow(
        "denied by the node file read policy",
      );
      expect(output).toEqual([]);
    },
  );

  it.each(["instructions", "explicit Skill", "Memory maintenance"])(
    "rejects raw parent traversal before native %s access",
    async (operation) => {
      const outside = await fs.realpath(tempDirs.make("node-worker-denied-"));
      await fs.mkdir(path.join(outside, "subdir"));
      await fs.symlink(path.join(outside, "subdir"), path.join(remote, "link"), "dir");
      const fileName = operation === "explicit Skill" ? "SKILL.md" : "secret.md";
      const allowed = path.join(remote, fileName);
      const denied = path.join(outside, fileName);
      const content =
        "---\nname: allowed-tool\ndescription: Allowed metadata\n---\nAllowed instructions.\n";
      await fs.writeFile(allowed, content);
      await fs.writeFile(
        denied,
        content.replaceAll("Allowed", "Private").replace("allowed-tool", "private-tool"),
      );
      nodePolicy.followSymlinks = true;
      nodePolicy.denyPaths = [denied];
      const output: Uint8Array[] = [];
      openDuplex = createNodeWorkspaceTestTransport(api, remote, undefined, (bytes) =>
        output.push(bytes),
      );
      await service.start(context());
      const access = getAgentWorkspaceAccess(local)!;
      const read = (filePath: string) =>
        operation === "instructions"
          ? access.skillResources!.readInstructions(filePath, {})
          : operation === "explicit Skill"
            ? access.skillResources!.resolveExplicitSkill({ name: "allowed-tool", path: filePath })
            : access.memoryFiles!.maintenance!.readFile(filePath);
      expect(await read(allowed)).toBeTruthy();
      output.length = 0;
      await expect(read(`${remote}/link/../${fileName}`)).rejects.toThrow(/parent|\.\./);
      expect(output).toEqual([]);
    },
  );

  it.each(["/", "/."])("accepts a single configured node root ending in %s", async (suffix) => {
    api.config.plugins!.entries!["file-transfer"]!.config = {
      ...api.config.plugins!.entries!["file-transfer"]!.config,
      workspaces: { main: { nodeId: "node-1", remoteRoot: remote + suffix } },
    };
    openDuplex = createNodeWorkspaceTestTransport(api, remote);
    await service.start(context());
    const access = getAgentWorkspaceAccess(local)!;
    expect(await access.skillResources!.readInstructions(path.join(remote, "AGENTS.md"), {})).toBe(
      "Harness instructions",
    );
    expect(await access.memoryFiles!.maintenance!.readFile(path.join(remote, "AGENTS.md"))).toEqual(
      Buffer.from("Harness instructions"),
    );
  });

  it.each(["whitespace", "home"])(
    "does not list denied Memory extra roots through %s expansion",
    async (kind) => {
      const home = await fs.realpath(tempDirs.make("node-extra-home-"));
      const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(home);
      onTestComplete(() => homeSpy.mockRestore());
      const allowed = path.join(remote, "notes");
      const denied = kind === "home" ? path.join(home, "notes") : allowed;
      await fs.mkdir(allowed);
      if (denied !== allowed) {
        await fs.mkdir(denied);
      }
      await fs.writeFile(path.join(denied, "private.md"), "Private memory");
      const output: Uint8Array[] = [];
      openDuplex = createNodeWorkspaceTestTransport(api, remote, undefined, (bytes) =>
        output.push(bytes),
      );
      await service.start(context());
      const memory = getAgentWorkspaceAccess(local)!.memoryFiles!;
      await expect(memory.listFiles(local, ["notes"])).resolves.toBeInstanceOf(Array);
      nodePolicy.denyPaths = [denied];
      output.length = 0;
      await expect(
        memory.listFiles(local, [kind === "home" ? "~/notes" : { path: " notes " }]),
      ).rejects.toThrow();
      expect(output).toEqual([]);
    },
  );

  it("authorizes the trimmed Memory read target before returning any bytes", async () => {
    await fs.mkdir(path.join(remote, "memory"));
    const file = path.join(remote, "memory", "private.md");
    await fs.writeFile(file, "Private memory");
    const output: Uint8Array[] = [];
    openDuplex = createNodeWorkspaceTestTransport(api, remote, undefined, (bytes) =>
      output.push(bytes),
    );
    await service.start(context());
    const memory = getAgentWorkspaceAccess(local)!.memoryFiles!;
    const request = { workspaceDir: local, relPath: "memory/private.md " };
    expect(await memory.readFile(request)).toMatchObject({ text: "Private memory" });
    nodePolicy.denyPaths = [file];
    for (const relPath of ["memory/private.md ", " memory/private.md", "memory/private.md\t"]) {
      output.length = 0;
      await expect(memory.readFile({ ...request, relPath })).rejects.toThrow(/file grant/);
      expect(output).toEqual([]);
    }
  });

  it.each(["file", "symlink"])(
    "authorizes the actual explicit Skill instruction %s before returning metadata",
    async (kind) => {
      const skillDir = path.join(remote, "skills", "private-tool");
      await fs.mkdir(skillDir, { recursive: true });
      const skillFile = path.join(skillDir, "SKILL.md");
      const actual = kind === "symlink" ? path.join(skillDir, "private.md") : skillFile;
      await fs.writeFile(
        actual,
        "---\nname: private-tool\ndescription: Private metadata\n---\nPrivate instructions.\n",
      );
      if (kind === "symlink") {
        await fs.symlink("private.md", skillFile);
        nodePolicy.followSymlinks = true;
      }
      const output: Uint8Array[] = [];
      openDuplex = createNodeWorkspaceTestTransport(api, remote, undefined, (bytes) =>
        output.push(bytes),
      );
      await service.start(context());
      const reader = getAgentWorkspaceAccess(local)!.skillResources!;
      const selection = { name: "private-tool", path: path.join(skillDir, "public.txt") };
      if (kind === "file") {
        expect(await reader.resolveExplicitSkill(selection)).toMatchObject({
          name: "private-tool",
        });
      }
      nodePolicy.denyPaths = [actual];
      output.length = 0;
      await expect(reader.resolveExplicitSkill(selection)).rejects.toThrow(
        kind === "file" ? /file grant/ : /canonical location/,
      );
      expect(output).toEqual([]);
    },
  );

  it("reads discovered Skill resources when the node root is inside the Gateway path", async () => {
    local = path.dirname(remote);
    const skillDir = path.join(remote, "skills", "overlap-tool");
    await fs.mkdir(skillDir, { recursive: true });
    const instructions =
      "---\nname: overlap-tool\ndescription: Overlapping roots\n---\nUse this tool.\n";
    await fs.writeFile(path.join(skillDir, "SKILL.md"), instructions);
    openDuplex = createNodeWorkspaceTestTransport(api, remote);
    await service.start(context());
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
    const skill = sources.entries.find((entry) => entry.skill.name === "overlap-tool")!.skill;
    const reader = access.skillResources!;
    expect(await reader.readInstructions(skill.filePath, {})).toBe(instructions);
    expect(
      await reader.resolveExplicitSkill({ name: skill.name, path: skill.filePath }),
    ).toMatchObject({ filePath: skill.filePath });
    expect(await reader.readSkillFiles(skill, { allowMissingRoot: false })).toContainEqual(
      expect.objectContaining({ path: "SKILL.md" }),
    );
  });

  it("reads and maintains Harness Memory through the shared client and native worker", async () => {
    vi.stubEnv("HOME", tempDirs.make("node-memory-home-"));
    await fs.mkdir(path.join(remote, "memory"));
    await fs.mkdir(path.join(local, "memory"));
    const file = path.join(local, "memory", "note.md");
    const remoteFile = path.join(remote, "memory", "note.md");
    await fs.writeFile(file, "Gateway decoy");
    await fs.writeFile(remoteFile, "Harness memory");
    nodePolicy.allowWritePaths.push(`${remote}/memory/**`);
    openDuplex = createNodeWorkspaceTestTransport(api, remote);
    await service.start(context());
    const memory = getAgentWorkspaceAccess(local)!.memoryFiles!;
    expect(await memory.listFiles(local)).toContain(file);
    expect(await memory.readForIndexing(file)).toMatchObject({ content: "Harness memory" });
    await memory.maintenance!.commitContent({
      filePath: file,
      content: "Updated memory",
      expectedContent: "Harness memory",
      tempPrefix: ".memory-test-",
    });
    expect(await fs.readFile(remoteFile, "utf8")).toBe("Updated memory");
    expect(await fs.readFile(file, "utf8")).toBe("Gateway decoy");
    const controller = new AbortController();
    const changes: string[] = [];
    const watching = memory.watch(
      {
        agentId: "main",
        settings: {
          extraPaths: [],
          multimodal: { enabled: false, modalities: [], maxFileBytes: 1024 },
          sync: { watchDebounceMs: 10 },
        },
      },
      (event) => changes.push(event),
      controller.signal,
    );
    void watching.catch(() => {});
    try {
      await vi.waitFor(
        async () => {
          await fs.writeFile(remoteFile, "New Harness memory");
          expect(changes).toContain("change");
        },
        { timeout: 5_000, interval: 200 },
      );
    } finally {
      controller.abort();
      await watching.catch(() => {});
    }
    nodePolicy.allowReadPaths = [`${remote}/AGENTS.md`];
    await expect(memory.readForIndexing(file)).rejects.toThrow(/file grant/);
  }, 30_000);

  it("retries a structured unary size refusal through bounded binary file.fetch", async () => {
    const bytes = Buffer.alloc(32 * 1024 * 1024, 0x6d);
    await fs.writeFile(path.join(remote, "output.bin"), bytes);
    await fs.writeFile(path.join(local, "output.bin"), "Gateway decoy");
    openDuplex = createNodeWorkspaceTestTransport(api, remote);
    const duplex = vi.fn(openDuplex!);
    openDuplex = duplex;
    await service.start(context());
    const media = getAgentWorkspaceAccess(local)!.outboundMedia!;
    const data = await media.readFile(path.join(local, "output.bin"), bytes.length);
    expect(createHash("sha256").update(data).digest("hex")).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      command: "file.fetch",
      params: { maxBytes: 16 * 1024 * 1024 },
    });
    expect(duplex).toHaveBeenCalledOnce();
    expect(duplex.mock.calls[0]?.[0]).toMatchObject({
      command: "file.fetch",
      params: { transport: "binary", maxBytes: bytes.length },
    });
    nodePolicy.maxBytes = 20 * 1024 * 1024;
    await expect(media.readFile(path.join(local, "output.bin"), bytes.length)).rejects.toThrow();
    expect(await fs.readFile(path.join(local, "output.bin"), "utf8")).toBe("Gateway decoy");
  });

  it("keeps unary small reads with a larger budget and never retries policy denial", async () => {
    openDuplex = vi.fn();
    await service.start(context());
    const media = getAgentWorkspaceAccess(local)!.outboundMedia!;
    expect(await media.readFile(path.join(local, "AGENTS.md"), 32 * 1024 * 1024)).toEqual(
      Buffer.from("Harness instructions"),
    );
    nodePolicy.allowReadPaths = [];
    await expect(media.readFile(path.join(local, "AGENTS.md"), 32 * 1024 * 1024)).rejects.toThrow();
    expect(openDuplex).not.toHaveBeenCalled();
  });

  it("fails large reads explicitly when duplex is unavailable", async () => {
    await fs.writeFile(path.join(remote, "output.bin"), "");
    await fs.truncate(path.join(remote, "output.bin"), 17 * 1024 * 1024);
    await service.start(context());
    await expect(
      getAgentWorkspaceAccess(local)!.outboundMedia!.readFile(
        path.join(local, "output.bin"),
        32 * 1024 * 1024,
      ),
    ).rejects.toThrow("FILE_TOO_LARGE");
  });

  it("aborts a binary outbound read when its service stops", async () => {
    await fs.writeFile(path.join(remote, "output.bin"), Buffer.alloc(17 * 1024 * 1024));
    openDuplex = createNodeWorkspaceTestTransport(api, remote, () => {
      void service.stop?.(context());
    });
    await service.start(context());
    await expect(
      getAgentWorkspaceAccess(local)!.outboundMedia!.readFile(
        path.join(local, "output.bin"),
        32 * 1024 * 1024,
      ),
    ).rejects.toThrow();
  });

  it("binds bounded outbound reads to the node policy and service lifetime", async () => {
    await fs.writeFile(path.join(local, "report.txt"), "Gateway decoy");
    await fs.writeFile(path.join(remote, "report.txt"), "Harness output");
    await service.start(context());
    const media = getAgentWorkspaceAccess(local)!.outboundMedia!;
    expect(media.localRoots).toEqual([local]);
    const filePath = path.join(local, "report.txt");
    expect(await media.readFile(filePath, 100)).toEqual(Buffer.from("Harness output"));
    await expect(media.readFile(filePath, 4)).rejects.toThrow();
    nodePolicy.allowReadPaths = [`${remote}/AGENTS.md`];
    await expect(media.readFile(filePath, 100)).rejects.toThrow();
    nodePolicy.allowReadPaths = [remote, `${remote}/**`];
    await service.stop?.(context());
    invoke.mockClear();
    await expect(media.readFile(filePath, 100)).rejects.toThrow("stopped or not ready");
    expect(invoke).not.toHaveBeenCalled();
    expect(await fs.readFile(filePath, "utf8")).toBe("Gateway decoy");
  });

  it("allows agents to share the same node workspace", async () => {
    api.config.plugins!.entries!["file-transfer"]!.config = {
      workspaces: {
        main: { nodeId: "node-1", remoteRoot: remote },
        other: { nodeId: "node-1", remoteRoot: `${remote}/.` },
      },
    };
    await service.start(context());
    expect(
      await getAgentWorkspaceAccess(local)!.bridge.readFile({ filePath: "AGENTS.md" }),
    ).toEqual(Buffer.from("Harness instructions"));
  });

  it.each(["node", "root"])("rejects conflicting %s mappings for one workspace", async (kind) => {
    api.config.plugins!.entries!["file-transfer"]!.config = {
      workspaces: {
        main: { nodeId: "node-1", remoteRoot: remote },
        other: {
          nodeId: kind === "node" ? "node-2" : "node-1",
          remoteRoot: kind === "root" ? `${remote}/other` : remote,
        },
      },
    };
    await expect(service.start(context())).rejects.toThrow("Conflicting node workspace mappings");
    expect(() => getAgentWorkspaceAccess(local)).toThrow(/not ready/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== "win32")(
    "lists POSIX filenames containing backslashes",
    async () => {
      await fs.writeFile(path.join(remote, "draft\\old.txt"), "");
      await service.start(context());
      const entries = await getAgentWorkspaceAccess(local)!.bridge.readDirectory!({
        filePath: ".",
      });
      expect(entries).toEqual([
        { name: "AGENTS.md", isDirectory: false },
        { name: "draft\\old.txt", isDirectory: false },
      ]);
    },
  );

  it("requires service-owned access instead of borrowing the caller's runtime authority", async () => {
    await expect(service.start({ ...context(), invokeNode: undefined })).rejects.toThrow(
      "Gateway service node access",
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(() => getAgentWorkspaceAccess(local)).toThrow(/not ready/);
  });
  it("reads and writes the Harness workspace through existing policy and commands", async () => {
    expect(() => getAgentWorkspaceAccess(local)).toThrow(/not ready/);
    await service.start(context());
    const access = getAgentWorkspaceAccess(local)!;
    const filePath = path.join(local, "AGENTS.md");
    expect(await access.bridge.readFileWithSource!({ filePath })).toEqual({
      data: Buffer.from("Harness instructions"),
      canonicalPath: path.join(remote, "AGENTS.md"),
      workspaceRelativePath: "AGENTS.md",
    });
    expect(await access.bridge.stat({ filePath })).toMatchObject({ type: "file", size: 20 });
    expect(await access.bridge.stat({ filePath: path.join(local, "missing") })).toBeNull();
    await expect(access.bridge.readFile({ filePath: "missing" })).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await access.bridge.readDirectory!({ filePath: local })).toEqual([
      { name: "AGENTS.md", isDirectory: false },
    ]);
    await access.bridge.writeFile({ filePath, data: "Live owner edit" });
    expect(await fs.readFile(path.join(remote, "AGENTS.md"), "utf8")).toBe("Live owner edit");
    expect(await fs.readFile(filePath, "utf8")).toBe("Gateway decoy");
  });

  it("does not turn workspace placement into a broader write grant", async () => {
    await service.start(context());
    const bridge = getAgentWorkspaceAccess(local)!.bridge;
    await expect(bridge.writeFile({ filePath: "project.txt", data: "denied" })).rejects.toThrow();
    expect(await fs.readdir(remote)).toEqual(["AGENTS.md"]);
    invoke.mockClear();
    await expect(bridge.readFile({ filePath: "../outside" })).rejects.toThrow(/outside/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("lists a workspace directory across node result pages", async () => {
    for (let start = 0; start < 4100; start += 100) {
      await Promise.all(
        Array.from({ length: 100 }, (_, offset) =>
          fs.writeFile(path.join(remote, `${String(start + offset).padStart(4, "0")}.txt`), ""),
        ),
      );
    }
    await service.start(context());
    const entries = await getAgentWorkspaceAccess(local)!.bridge.readDirectory!({ filePath: "." });
    expect(entries).toHaveLength(4101);
    expect(new Set(entries.map((entry) => entry.name))).toEqual(new Set(await fs.readdir(remote)));
    expect(entries).toContainEqual({ name: "AGENTS.md", isDirectory: false });
  });

  it("rejects a directory continuation that makes no progress", async () => {
    await service.start(context());
    invoke.mockResolvedValue({
      payload: { ok: true, path: remote, entries: [], truncated: true, nextPageToken: "0" },
    });
    await expect(
      getAgentWorkspaceAccess(local)!.bridge.readDirectory!({ filePath: "." }),
    ).rejects.toThrow("Invalid dir.list continuation");
  });

  it("preserves bootstrap reads through in-workspace parent aliases", async () => {
    const nested = path.join(remote, "nested");
    await fs.mkdir(nested);
    await fs.writeFile(path.join(nested, "MEMORY.md"), "Nested memory");
    await fs.symlink(nested, path.join(remote, "alias"), "dir");
    nodePolicy.followSymlinks = true;
    await service.start(context());
    const bridge = getAgentWorkspaceAccess(local)!.bridge;
    expect(await bridge.readFileWithSource!({ filePath: "alias/MEMORY.md" })).toEqual({
      data: Buffer.from("Nested memory"),
      canonicalPath: path.join(nested, "MEMORY.md"),
      workspaceRelativePath: "nested/MEMORY.md",
    });
    await fs.symlink(remote, path.join(remote, "root-alias"), "dir");
    expect(await bridge.readFileWithSource!({ filePath: "root-alias/AGENTS.md" })).toMatchObject({
      canonicalPath: path.join(remote, "AGENTS.md"),
      workspaceRelativePath: "AGENTS.md",
    });
    // Ordinary document access keeps its stricter no-alias behavior.
    await expect(bridge.readFile({ filePath: "alias/MEMORY.md" })).rejects.toThrow();
  });

  it.each(["outside", "leaf", "policy"])(
    "does not expand bootstrap reads through a %s alias",
    async (kind) => {
      nodePolicy.followSymlinks = kind !== "policy";
      const outside = await fs.realpath(tempDirs.make("node-workspace-read-outside-"));
      await fs.writeFile(path.join(outside, "AGENTS.md"), "Outside instructions");
      // Even a broader node grant must not let the workspace reader escape.
      nodePolicy.allowReadPaths.push(`${outside}/**`);
      const target = kind === "outside" ? outside : remote;
      const alias = path.join(remote, "alias");
      const filePath = kind === "leaf" ? "alias" : "alias/AGENTS.md";
      await fs.symlink(kind === "leaf" ? path.join(remote, "AGENTS.md") : target, alias);
      await service.start(context());
      await expect(
        getAgentWorkspaceAccess(local)!.bridge.readFileWithSource!({ filePath }),
      ).rejects.toThrow();
    },
  );

  it("rejects owner document writes through a hard link outside the workspace", async () => {
    const outside = path.join(path.dirname(remote), "outside.md");
    await fs.link(path.join(remote, "AGENTS.md"), outside);
    await service.start(context());

    await expect(
      getAgentWorkspaceAccess(local)!.bridge.writeFile({
        filePath: "AGENTS.md",
        data: "Must not write",
      }),
    ).rejects.toThrow("HARDLINK_TARGET_DENIED");
    expect(await fs.readFile(outside, "utf8")).toBe("Harness instructions");
    expect(await fs.readFile(path.join(remote, "AGENTS.md"), "utf8")).toBe("Harness instructions");
  });

  it.each(["parent", "root"])(
    "rejects a symlinked %s before writing outside the workspace",
    async (kind) => {
      const outside = await fs.realpath(tempDirs.make("node-workspace-outside-"));
      const target = path.join(outside, "AGENTS.md");
      await fs.writeFile(target, "Outside instructions");
      nodePolicy.followSymlinks = true;
      nodePolicy.allowWritePaths = [`${remote}/**`, `${outside}/**`];
      let filePath = "redirect/AGENTS.md";
      if (kind === "root") {
        await fs.rename(remote, `${remote}-original`);
        await fs.symlink(outside, remote);
        filePath = "AGENTS.md";
      } else {
        await fs.symlink(outside, path.join(remote, "redirect"));
      }
      await service.start(context());
      await expect(
        getAgentWorkspaceAccess(local)!.bridge.writeFile({ filePath, data: "Must not write" }),
      ).rejects.toThrow();
      expect(await fs.readFile(target, "utf8")).toBe("Outside instructions");
    },
  );

  it("keeps byte limits and returns no local fallback after service shutdown", async () => {
    await service.start(context());
    const bridge = getAgentWorkspaceAccess(local)!.bridge;
    await expect(bridge.readFile({ filePath: "AGENTS.md", maxBytes: 4 })).rejects.toThrow(
      /FILE_TOO_LARGE/,
    );
    await service.stop?.(context());
    invoke.mockClear();
    await expect(bridge.readFile({ filePath: "AGENTS.md" })).rejects.toThrow(/stopped/);
    expect(() => getAgentWorkspaceAccess(local)).toThrow(/not ready/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("cancels an in-flight request when the service stops", async () => {
    await service.start(context());
    const response = createDeferred<unknown>();
    invoke.mockImplementationOnce(async () => response.promise);
    const pending = getAgentWorkspaceAccess(local)!.bridge.readFile({ filePath: "AGENTS.md" });
    const signal = invoke.mock.calls[0]?.[0]?.signal;
    await service.stop?.(context());
    expect(signal?.aborted).toBe(true);
    response.resolve({ payload: {} });
    await expect(pending).rejects.toThrow(/stopped/);
  });
});

async function attachmentInput(sizeMiB: number) {
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(local, "state"));
  const bytes = Buffer.alloc(sizeMiB * 1024 * 1024, 0x6d);
  const saved = await saveMediaBuffer(
    bytes,
    "application/octet-stream",
    "inbound",
    bytes.length,
    "report.bin",
  );
  expect(saved.path.startsWith(local + path.sep)).toBe(true);
  const inputDirectory = `media/inbound/openclaw-staged-${createHash("sha256").update(saved.path).digest("hex")}`;
  const target = path.join(remote, inputDirectory, `input-${path.basename(saved.path)}`);
  nodePolicy.allowReadPaths = [
    `${remote}/AGENTS.md`,
    `${remote}/media/inbound/openclaw-staged-*`,
    `${remote}/media/inbound/openclaw-staged-*/**`,
  ];
  nodePolicy.allowWritePaths.push(`${remote}/media/inbound/openclaw-staged-*/**`);
  return { bytes, target, turn: { media: [{ path: saved.path }], timeoutMs: 60_000 } };
}

describe("node workspace attachment caller", () => {
  it.each([17, 50])(
    "transfers %i MiB through registered access and retains Harness edits",
    async (size) => {
      const input = await attachmentInput(size);
      openDuplex = createNodeWorkspaceTestTransport(api, remote);
      await service.start(context());
      const params = { workspaceDir: local, turn: input.turn, assertCurrent: () => {} };
      const original = JSON.stringify(input.turn);
      const note = await prepareAgentWorkspaceAttachments(params);
      expect(note).toBe(`[media attached: ${input.target}]`);
      expect(
        createHash("sha256")
          .update(await fs.readFile(input.target))
          .digest("hex"),
      ).toBe(createHash("sha256").update(input.bytes).digest("hex"));
      expect(JSON.stringify(input.turn)).toBe(original);
      expect(await fs.readFile(path.join(local, "AGENTS.md"), "utf8")).toBe("Gateway decoy");
      await expect(fs.stat(path.join(local, "media"))).rejects.toMatchObject({ code: "ENOENT" });
      await fs.writeFile(input.target, "Harness edit");
      expect(await prepareAgentWorkspaceAttachments(params)).toBe(note);
      expect(await fs.readFile(input.target, "utf8")).toBe("Harness edit");
    },
  );

  it("requires explicit input-path permission without widening owner document writes", async () => {
    const input = await attachmentInput(1);
    nodePolicy.allowWritePaths = [`${remote}/AGENTS.md`];
    openDuplex = createNodeWorkspaceTestTransport(api, remote);
    await service.start(context());
    await expect(
      prepareAgentWorkspaceAttachments({
        workspaceDir: local,
        turn: input.turn,
        assertCurrent: () => {},
      }),
    ).rejects.toThrow();
    expect(await fs.readdir(remote)).toEqual(["AGENTS.md"]);
  });

  it("revokes a turn during transfer without publishing partial input", async () => {
    const input = await attachmentInput(17);
    let current = true;
    openDuplex = createNodeWorkspaceTestTransport(api, remote, () => {
      current = false;
    });
    await service.start(context());
    await expect(
      prepareAgentWorkspaceAttachments({
        workspaceDir: local,
        turn: input.turn,
        assertCurrent() {
          if (!current) {
            throw new Error("turn ended");
          }
        },
      }),
    ).rejects.toThrow("turn ended");
    await expect(fs.stat(input.target)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
