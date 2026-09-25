import type { SkillSnapshot } from "../../skills/types.js";
import { resolveSandboxSkillRuntimeInputs } from "../embedded-agent-runner/sandbox-skills.js";
import { prepareInstalledSkillCatalog } from "../installed-skill-runtime.js";
import type { SandboxContext } from "../sandbox/types.js";

/** Catalog identity is host-owned; readable paths follow the effective tool placement. */
export function bindHostSkillCatalog(params: {
  snapshot?: SkillSnapshot;
  workspaceDir: string;
  sandbox?: SandboxContext | null;
  readable: boolean;
  assertCurrent: () => void;
}) {
  return (placement?: SandboxContext | null) => {
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
    return prepareInstalledSkillCatalog({
      snapshot: inputs.skillsSnapshot,
      workspaceDir: inputs.skillsWorkspaceDir,
      sandbox,
      assertCurrent: params.assertCurrent,
    });
  };
}
