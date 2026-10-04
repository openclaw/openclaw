import path from "node:path";
import {
  isPathInside,
  readLocalFileFromRoots,
  resolveLocalPathFromRootsSync,
} from "../../infra/fs-safe.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { resolveSandboxSkillRuntimeInputs } from "../embedded-agent-runner/sandbox-skills.js";
import { MAX_SKILL_INSTRUCTION_BYTES, type InstalledSkill } from "../installed-skill-catalog.js";
import { prepareInstalledSkillCatalog } from "../installed-skill-runtime.js";
import type { SandboxContext } from "../sandbox/types.js";

/** Catalog identity is host-owned; readable paths follow the effective tool placement. */
export function bindHostSkillCatalog(params: {
  snapshot?: SkillSnapshot;
  workspaceDir: string;
  sandbox?: SandboxContext | null;
  requiredRoot?: string;
  readable: boolean;
  assertCurrent: () => void;
}) {
  return (placement?: SandboxContext | null, permissionRoot?: string) => {
    params.assertCurrent();
    if (!params.readable) {
      return [];
    }
    // A late placement can add a sandbox, never remove an already admitted one.
    const sandbox = params.sandbox?.enabled ? params.sandbox : (placement ?? params.sandbox);
    const inputs = resolveSandboxSkillRuntimeInputs({
      sandbox,
      skillsAnchorWorkspace: params.workspaceDir,
      skillsSnapshot: params.snapshot,
    });
    const catalog = prepareInstalledSkillCatalog({
      snapshot: inputs.skillsSnapshot,
      workspaceDir: inputs.skillsWorkspaceDir,
      sandbox,
      assertCurrent: params.assertCurrent,
    });
    if (!params.requiredRoot) {
      return catalog;
    }
    const requiredRoot = permissionRoot ?? params.requiredRoot;
    if (!isPathInside(params.requiredRoot, requiredRoot)) {
      throw new Error("Skill permission root escapes the captured required workspace.");
    }
    return catalog
      .filter((skill) => {
        if (!sandbox?.enabled) {
          return (
            resolveLocalPathFromRootsSync({
              filePath: skill.source.filePath,
              roots: [requiredRoot],
              requireFile: true,
            }) !== null
          );
        }
        const resolved = sandbox.fsBridge?.resolvePath({
          filePath: skill.location,
          cwd: sandbox.containerWorkdir,
        });
        return resolved?.hostPath !== undefined && isPathInside(requiredRoot, resolved.hostPath);
      })
      .map<InstalledSkill>((skill) => {
        const entry: InstalledSkill = Object.assign({}, skill);
        // Cached instructions must not bypass the read-time workspace boundary.
        entry.source = { filePath: skill.source.filePath };
        entry.reader = async ({ location, signal }) => {
          params.assertCurrent();
          signal?.throwIfAborted();
          const maxBytes = skill.promptListed
            ? Number.MAX_SAFE_INTEGER
            : MAX_SKILL_INSTRUCTION_BYTES;
          let content: Buffer;
          if (sandbox?.enabled) {
            if (!sandbox.fsBridge?.readFileWithSource) {
              throw new Error("Sandbox skill reads require a source-aware filesystem bridge.");
            }
            const result = await sandbox.fsBridge.readFileWithSource({
              filePath: location,
              cwd: sandbox.containerWorkdir,
              signal,
              maxBytes,
            });
            if (
              result.workspaceRelativePath === undefined ||
              !isPathInside(
                requiredRoot,
                path.resolve(sandbox.workspaceDir, result.workspaceRelativePath),
              )
            ) {
              throw new Error("Skill instructions escape the captured required workspace.");
            }
            content = result.data;
          } else {
            const result = await readLocalFileFromRoots({
              filePath: location,
              roots: [requiredRoot],
              hardlinks: "reject",
              symlinks: "follow-within-root",
              maxBytes,
            });
            if (!result) {
              throw new Error("Skill instructions escape the captured required workspace.");
            }
            content = result.buffer;
          }
          params.assertCurrent();
          signal?.throwIfAborted();
          return content.toString("utf8");
        };
        return entry;
      });
  };
}
