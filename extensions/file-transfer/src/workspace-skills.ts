import path from "node:path";
import type { AgentWorkspaceAccess } from "openclaw/plugin-sdk/agent-workspace-runtime";
import { runNodeWorkspaceWorker, type NodeWorkspaceWorkerOptions } from "./workspace-worker.js";

type SkillsAccess = Required<
  Pick<
    AgentWorkspaceAccess,
    "loadSkills" | "watchSkills" | "skillResources" | "installSkillDependencies"
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
  return {
    loadSkills: (request) => call("discovery", { ...request, ...mapSources(request) }),
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
      readInstructions: (filePath, { signal }) => call("readInstructions", { filePath }, signal),
      readCompanion: (skillFilePath, relativePath, sourceRootIdentity, { signal }) =>
        call("readCompanion", { skillFilePath, relativePath, sourceRootIdentity }, signal),
      resolveExplicitSkill: (selection) => call("resolveResource", selection),
      readSkillFiles: (skill, { allowMissingRoot }) =>
        call("readResources", { skill, allowMissingRoot }),
    },
    installSkillDependencies: (request) => call("installDependencies", request),
  };
}
