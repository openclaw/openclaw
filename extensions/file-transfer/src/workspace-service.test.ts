import fs from "node:fs/promises";
import path from "node:path";
import { getAgentWorkspaceAccess } from "openclaw/plugin-sdk/agent-workspace-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginApi, OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleDirList } from "./node-host/dir-list.js";
import { handleFileFetch } from "./node-host/file-fetch.js";
import { handleFileStat } from "./node-host/file-stat.js";
import { handleFileWrite } from "./node-host/file-write.js";
import { createFileTransferNodeInvokePolicy } from "./shared/node-invoke-policy.js";
import { createCtx } from "./shared/node-invoke-policy.test-support.js";
import { registerNodeWorkspaces } from "./workspace-service.js";

vi.mock("./shared/audit.js", () => ({ appendFileTransferAudit: vi.fn() }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let local: string;
let remote: string;
let service: OpenClawPluginService;
let api: OpenClawPluginApi;
let nodePolicy: {
  allowReadPaths: string[];
  allowWritePaths: string[];
  followSymlinks: boolean;
  ask: "off";
};
let invoke: ReturnType<typeof vi.fn<OpenClawPluginApi["runtime"]["nodes"]["invoke"]>>;

function context() {
  return { config: api.config, logger: api.logger, stateDir: local, invokeNode: invoke };
}

beforeEach(async () => {
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
});

describe("registered node workspace service", () => {
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
