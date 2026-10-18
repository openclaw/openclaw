import path from "node:path";
import type { AgentWorkspaceAccess } from "openclaw/plugin-sdk/agent-workspace-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createNodeSkillLifecycle } from "./workspace-skill-lifecycle.js";
import { runNodeWorkspaceWorker, type NodeWorkspaceWorkerOptions } from "./workspace-worker.js";

const MAX_PAIRING_CHANGE_RETRIES = 2;

function isPairingChange(error: unknown): boolean {
  const record = asOptionalRecord(error);
  return record?.retryable === true && asOptionalRecord(record.details)?.code === "PAIRING_CHANGED";
}

type SkillsAccess = Required<
  Pick<
    AgentWorkspaceAccess,
    | "loadSkills"
    | "watchSkills"
    | "skillResources"
    | "installSkillDependencies"
    | "applySkillRoot"
    | "recordSkillSourceInstall"
    | "clawHubSkills"
  >
>;

/** Native Skills retain discovery and installation; this adapter supplies node IO. */
export function createNodeWorkspaceSkills(options: NodeWorkspaceWorkerOptions): SkillsAccess {
  const mapPath = (value: string) => {
    const relative = path.relative(options.workspaceDir, value);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      ? path.posix.join(options.remoteRoot, ...relative.split(path.sep))
      : value;
  };
  const mapSources = (request: Parameters<SkillsAccess["watchSkills"]>[0]) => {
    if (path.resolve(request.sourcePlan.workspaceDir) !== options.workspaceDir) {
      throw new Error("Skill request does not match the configured workspace");
    }
    const plan = request.sourcePlan;
    return {
      ...request,
      executionWorkspaceDir:
        request.executionWorkspaceDir && mapPath(request.executionWorkspaceDir),
      sourcePlan: {
        ...plan,
        workspaceDir: options.remoteRoot,
        stateDir: plan.stateDir && mapPath(plan.stateDir),
        managedSkillsDir: mapPath(plan.managedSkillsDir),
        pluginSkillsDir: plan.pluginSkillsDir && mapPath(plan.pluginSkillsDir),
        bundledSkillsDir: plan.bundledSkillsDir && mapPath(plan.bundledSkillsDir),
        roots: plan.roots.map((root) => ({ ...root, dir: mapPath(root.dir) })),
        pluginSkillRoots: plan.pluginSkillRoots.map((root) => ({
          ...root,
          dir: mapPath(root.dir),
        })),
        allowSymlinkTargets: plan.allowSymlinkTargets?.map(mapPath),
      },
    };
  };
  async function call<T>(operation: string, request: unknown, signal?: AbortSignal): Promise<T> {
    const active = signal ? AbortSignal.any([options.signal, signal]) : options.signal;
    return JSON.parse(
      await runNodeWorkspaceWorker(
        options,
        "workspace.skills",
        {
          operation,
          request: JSON.stringify(request),
          watch: false,
        },
        active,
      ),
    );
  }
  async function read<T>(operation: string, request: unknown, signal?: AbortSignal): Promise<T> {
    // Pairing approvals advance the generation and node.invoke returns retryable PAIRING_CHANGED.
    // Retry reads against the new generation; revoked nodes still fail after the bound.
    for (let retries = 0; ; retries += 1) {
      try {
        return await call<T>(operation, request, signal);
      } catch (error) {
        if (!isPairingChange(error) || retries >= MAX_PAIRING_CHANGE_RETRIES) {
          throw error;
        }
      }
    }
  }
  return {
    ...createNodeSkillLifecycle(options),
    loadSkills: (request) => read("discovery", mapSources(request)),
    async watchSkills(request, onChange, signal) {
      await runNodeWorkspaceWorker(
        options,
        "workspace.skills",
        {
          operation: "watch",
          request: JSON.stringify(mapSources(request)),
          watch: true,
        },
        AbortSignal.any([options.signal, signal]),
        (line) => {
          const event: unknown = JSON.parse(line);
          if (event !== "change" && event !== "unavailable" && event !== "available") {
            throw new Error("Invalid Skill change notification");
          }
          onChange(event);
        },
      );
    },
    // Resource identities already belong to the node that discovered the Skills.
    skillResources: {
      readInstructions: (filePath, { signal }) => read("readInstructions", { filePath }, signal),
      resolveExplicitSkill: (selection) => read("resolveResource", selection),
      readSkillFiles: (skill, { allowMissingRoot }) =>
        read("readResources", { skill, allowMissingRoot }),
    },
    installSkillDependencies: (request) => call("installDependencies", request),
  };
}
