import fs from "node:fs/promises";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { resolveSubagentSessionAttachmentRootDir } from "../subagents/subagent-attachment-paths.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { hashTextSha256 } from "./hash.js";
import type { resolveSandboxRuntimeStatus } from "./runtime-status.js";

/** Resolve existing namespace policy without creating a workspace or a runtime. */
export async function resolveSandboxSession(params: {
  skillsSnapshot?: SkillSnapshot;
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  preparedRuntimeStatus: ReturnType<typeof resolveSandboxRuntimeStatus>;
}) {
  const rawSessionKey = params.sessionKey?.trim();
  if (!rawSessionKey) {
    return null;
  }

  const runtime = { ...params.preparedRuntimeStatus };
  if (!runtime.sandboxed) {
    return null;
  }

  const configured = resolveSandboxConfigForAgent(params.config, runtime.agentId);
  const sessionAttachmentRoot = resolveSubagentSessionAttachmentRootDir({
    agentId: runtime.agentId,
    childSessionKey: rawSessionKey,
  });
  // An attachment grant is session-owned. Give the child a dedicated runtime
  // even when ordinary agent-scoped turns share one, so no sibling guest can
  // inherit this session's protected projection.
  try {
    if ((await fs.stat(sessionAttachmentRoot)).isDirectory()) {
      runtime.isolationSubject = { kind: "session", sessionKey: rawSessionKey };
    }
  } catch {
    // No attachment grant for this session.
  }
  const librarySelections = params.skillsSnapshot?.librarySelections;
  // Shared/agent sandboxes cannot expose one person's private bundles to another session,
  // or replace bytes under an active revision. Selection changes get a separate runtime.
  if (librarySelections?.length) {
    runtime.isolationSubject = {
      kind: "session",
      sessionKey: `${rawSessionKey}:skills:${hashTextSha256(JSON.stringify(librarySelections))}`,
    };
  }
  // Docker and browser backends replace shared scope keys with a literal name;
  // agent scope lets the prepared isolation subject own every sandbox resource.
  const cfg = runtime.sandboxRequired
    ? { ...configured, scope: "agent" as const, workspaceAccess: runtime.workspaceAccess }
    : librarySelections?.length
      ? { ...configured, scope: "agent" as const }
      : configured;
  return { rawSessionKey, runtime, cfg };
}
