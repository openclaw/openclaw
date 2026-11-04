import fs from "node:fs/promises";
import path from "node:path";
import * as workspace from "openclaw/plugin-sdk/agent-workspace-runtime";
import type * as Plugin from "openclaw/plugin-sdk/plugin-entry";
import * as testApi from "openclaw/plugin-sdk/plugin-test-api";
import { expect, vi } from "vitest";
import { createWorkspaceNodeDispatcher } from "./workspace-service.test-support.js";

export async function createWorkspaceFixture(parent: string, unary = false) {
  const state: {
    local: string;
    openDuplex: Plugin.OpenClawPluginServiceContext["openNodeDuplex"];
  } = { local: path.join(parent, "gateway"), openDuplex: undefined };
  const remote = path.join(parent, "harness");
  await Promise.all([state.local, remote].map((dir) => fs.mkdir(dir)));
  const nodePolicy: {
    allowReadPaths: string[];
    allowWritePaths: string[];
    denyPaths?: string[];
    followSymlinks?: boolean;
    maxBytes?: number;
  } = {
    allowReadPaths: [remote, `${remote}/**`],
    allowWritePaths: [],
  };
  const pluginConfig = {
    policyVersion: 2,
    workspaces: { main: { nodeId: "node-1", remoteRoot: remote } },
    nodes: { "node-1": nodePolicy },
  };
  const dispatch = createWorkspaceNodeDispatcher(remote);
  const invoke = vi.fn<Plugin.OpenClawPluginApi["runtime"]["nodes"]["invoke"]>(async (request) => {
    if (!unary) {
      throw new Error("Lifecycle must use the paired stream");
    }
    expect(request.nodeId).toBe("node-1");
    return dispatch(request, pluginConfig);
  });
  const registerService = vi.fn<Plugin.OpenClawPluginApi["registerService"]>();
  const scheduler = testApi.createTestPluginServiceScheduler();
  const api = testApi.createTestPluginApi({
    config: { plugins: { entries: { "file-transfer": { config: pluginConfig } } } },
    pluginConfig,
    runtime: {
      agent: { resolveAgentWorkspaceDir: (): string => fixture.local },
      nodes: { invoke },
    } as unknown as Plugin.OpenClawPluginApi["runtime"],
    registerService,
  });
  const fixture = {
    ...state,
    remote,
    nodePolicy,
    invoke,
    api,
    get service() {
      return registerService.mock.lastCall![0];
    },
    scheduler,
    context: () => ({
      config: api.config,
      logger: api.logger,
      stateDir: fixture.local,
      invokeNode: invoke,
      openNodeDuplex: fixture.openDuplex,
      scheduler,
    }),
    async start() {
      await this.service.start(this.context());
      return workspace.getAgentWorkspaceAccess(fixture.local)!;
    },
  };
  return fixture;
}

export type WorkspaceFixture = Awaited<ReturnType<typeof createWorkspaceFixture>>;

export function workspaceSkillRequest(
  local: string,
  includeState = false,
): Parameters<NonNullable<workspace.AgentWorkspaceAccess["loadSkills"]>>[0] {
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
