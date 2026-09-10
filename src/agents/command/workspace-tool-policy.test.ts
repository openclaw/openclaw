import { expect, it } from "vitest";
import { resolveEffectiveToolFsWorkspaceOnly } from "../tool-fs-policy.js";
import { constrainAgentCommandWorkspaceTools } from "./workspace-tool-policy.js";

it("narrows global and per-agent file policies without mutating the configured permissions", () => {
  const original = {
    tools: { fs: { workspaceOnly: false }, exec: { applyPatch: { workspaceOnly: false } } },
    agents: { entries: { poc: { tools: { fs: { workspaceOnly: false } } } } },
  };
  const narrowed = constrainAgentCommandWorkspaceTools(original);
  expect(resolveEffectiveToolFsWorkspaceOnly({ cfg: narrowed, agentId: "poc" })).toBe(true);
  expect(narrowed.tools?.exec?.applyPatch?.workspaceOnly).toBe(true);
  expect(resolveEffectiveToolFsWorkspaceOnly({ cfg: original, agentId: "poc" })).toBe(false);
  expect(original.tools.exec.applyPatch.workspaceOnly).toBe(false);
});
