import fs from "node:fs/promises";
import path from "node:path";
import {
  getAgentWorkspaceAccess,
  type AgentWorkspaceAccess,
} from "openclaw/plugin-sdk/agent-workspace-runtime";
import type {
  OpenClawPluginApi,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { expect, vi } from "vitest";
import { handleDirList } from "./node-host/dir-list.js";
import { handleFileFetch } from "./node-host/file-fetch.js";
import { handleFileStat } from "./node-host/file-stat.js";
import { handleFileWrite } from "./node-host/file-write.js";
import { createFileTransferNodeInvokePolicy } from "./shared/node-invoke-policy.js";
import { createCtx } from "./shared/node-invoke-policy.test-support.js";

const unaryHandlers = {
  "file.fetch": (params: unknown) =>
    handleFileFetch(params as Parameters<typeof handleFileFetch>[0]),
  "file.stat": (params: unknown) => handleFileStat(params as Parameters<typeof handleFileStat>[0]),
  "file.write": (params: unknown) =>
    handleFileWrite(params as Parameters<typeof handleFileWrite>[0]),
  "dir.list": (params: unknown) => handleDirList(params as Parameters<typeof handleDirList>[0]),
};

export async function createWorkspaceFixture(parent: string, unary = false) {
  let local = path.join(parent, "gateway");
  const remote = path.join(parent, "harness");
  await fs.mkdir(local);
  await fs.mkdir(remote);
  const nodePolicy: {
    allowReadPaths: string[];
    allowWritePaths: string[];
    denyPaths?: string[];
    followSymlinks: boolean;
    ask: "off";
    maxBytes?: number;
  } = {
    allowReadPaths: [remote, `${remote}/**`],
    allowWritePaths: [],
    followSymlinks: false,
    ask: "off",
  };
  const pluginConfig = {
    policyVersion: 2,
    workspaces: { main: { nodeId: "node-1", remoteRoot: remote } },
    nodes: { "node-1": nodePolicy },
  };
  const invoke = vi.fn<OpenClawPluginApi["runtime"]["nodes"]["invoke"]>(async (request) => {
    if (!unary) {
      throw new Error("Lifecycle must use the paired stream");
    }
    expect(request.nodeId).toBe("node-1");
    const { ctx, invokeNode } = createCtx({
      command: request.command,
      params: request.params as Record<string, unknown>,
      pluginConfig,
    });
    invokeNode.mockImplementation(async (options = {}) => {
      const handler = Object.entries(unaryHandlers).find(
        ([command]) => command === request.command,
      )?.[1];
      if (!handler) {
        throw new Error(`Unexpected command ${request.command}`);
      }
      return { ok: true, payload: await handler(options.params) };
    });
    const result = await createFileTransferNodeInvokePolicy().handle(ctx);
    if (!result.ok) {
      throw new Error(`${result.code}: ${result.message}`);
    }
    return result;
  });
  let service!: Parameters<OpenClawPluginApi["registerService"]>[0];
  let openDuplex: OpenClawPluginServiceContext["openNodeDuplex"];
  const scheduler = createTestPluginServiceScheduler();
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
  return {
    get local() {
      return local;
    },
    set local(value: string) {
      local = value;
    },
    remote,
    nodePolicy,
    invoke,
    api,
    get service() {
      return service;
    },
    get openDuplex() {
      return openDuplex;
    },
    set openDuplex(value: OpenClawPluginServiceContext["openNodeDuplex"]) {
      openDuplex = value;
    },
    scheduler,
    context() {
      return {
        config: api.config,
        logger: api.logger,
        stateDir: local,
        invokeNode: invoke,
        openNodeDuplex: openDuplex,
        scheduler,
      };
    },
    async start() {
      await service.start(this.context());
      return getAgentWorkspaceAccess(local)!;
    },
  };
}

export type WorkspaceFixture = Awaited<ReturnType<typeof createWorkspaceFixture>>;

export function workspaceSkillRequest(
  local: string,
  includeState = false,
): Parameters<NonNullable<AgentWorkspaceAccess["loadSkills"]>>[0] {
  return {
    sourcePlan: {
      workspaceDir: local,
      ...(includeState ? { stateDir: local, pluginSkillsDir: path.join(local, "plugins") } : {}),
      managedSkillsDir: path.join(local, "managed"),
      roots: [{ dir: path.join(local, "skills"), source: "openclaw-workspace", tier: "workspace" }],
      pluginSkillRoots: [],
    },
    limits: { maxCandidatesPerRoot: 100, maxSkillsLoadedPerSource: 100, maxSkillFileBytes: 65536 },
    additionalBins: [],
  };
}

export async function expectMissing(file: string) {
  await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
}
