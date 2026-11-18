import fs from "node:fs/promises";
import path from "node:path";
import { isMissingPathError } from "../../infra/errors.js";
import { canonicalPathFromExistingAncestor } from "../../infra/fs-safe.js";
import { logWarn } from "../../logger.js";
import type { CliBackendExecuteContext } from "../../plugins/cli-backend.types.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentIds } from "../agent-scope.js";
import { getAdmittedRunTurnTaintState } from "../embedded-agent-runner/run/turn-taint-state.js";
import { createMemoryWriteProvenanceObserver } from "../memory-write-provenance.js";
import type { PreparedCliRunContext } from "./types.js";

/** Observe native writes; permission, execution, and rollback remain native-owned. */
export function createNativeMemoryProvenanceObserver(
  context: PreparedCliRunContext,
  assertCurrent: () => void,
): NonNullable<CliBackendExecuteContext["observeToolMutation"]> {
  const run = context.params;
  const config = run.config ?? {};
  const agentId = resolveSessionAgentIds({
    config,
    agentId: run.agentId,
    sessionKey: run.sessionKey,
  }).sessionAgentId;
  const workspaceDir = resolveAgentWorkspaceDir(config, agentId);
  const taint = getAdmittedRunTurnTaintState(run.admittedRunContext);
  const observer = createMemoryWriteProvenanceObserver({
    mutationRoot: workspaceDir,
    workspaceDir,
    resolveOriginClass: () =>
      run.senderIsOwner === false || taint?.isTainted() === true ? "untrusted" : "agent",
    sessionId: run.sessionId,
    sessionKey: run.sessionKey,
  });
  const pending = new Map<string, { absolutePath: string; contentBefore: string }>();
  return async (event) => {
    assertCurrent();
    if (event.toolName !== "Edit" && event.toolName !== "Write") {
      return;
    }
    try {
      if (event.phase === "before") {
        const filePath = event.toolInput.file_path;
        if (typeof filePath !== "string") {
          return;
        }
        const absolutePath = await canonicalPathFromExistingAncestor(
          path.resolve(event.cwd ?? context.cwd ?? context.workspaceDir, filePath),
        );
        if (!(await observer.classifies(absolutePath))) {
          return;
        }
        const contentBefore = await fs.readFile(absolutePath, "utf8").catch((error: unknown) => {
          if (!isMissingPathError(error)) {
            throw error;
          }
          return "";
        });
        pending.set(event.toolCallId, { absolutePath, contentBefore });
        return;
      }
      const before = pending.get(event.toolCallId);
      pending.delete(event.toolCallId);
      if (!before) {
        return;
      }
      const contentAfter = await fs.readFile(before.absolutePath, "utf8");
      await observer.write({
        ...before,
        contentAfter,
        // PostToolUse reports an already successful native mutation. Never replay it.
        commit: async () => {},
      });
    } catch (error) {
      // Observation cannot undo a native write. A missed post hook or failed record
      // leaves the prior hash in place, so a later tracked edit still quarantines drift.
      logWarn("native memory provenance " + event.phase + " observation failed: " + String(error));
    }
  };
}
