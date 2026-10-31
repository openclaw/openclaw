import fs from "node:fs/promises";
import path from "node:path";
import { awaitGateBeforeSettlement } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it, vi } from "vitest";
import {
  createParams,
  createResumeHarness,
  runCodexAppServerAttempt,
} from "./run-attempt-test-harness.js";

export function registerCodexWorkspacePolicyTests({
  createRunPaths,
  writeExistingBinding,
}: {
  createRunPaths: () => { sessionFile: string; workspaceDir: string };
  writeExistingBinding: (sessionFile: string, workspaceDir: string) => Promise<void>;
}) {
  it.each(["nested", "outside", "root-only"] as const)(
    "prepares retry settings from the admitted %s cwd before resumed harness turns",
    async (placement) => {
      const { sessionFile, workspaceDir } = createRunPaths();
      const nestedCwd = path.join(workspaceDir, "packages", "app");
      await fs.mkdir(nestedCwd, { recursive: true });
      await writeExistingBinding(sessionFile, workspaceDir);
      const harness = createResumeHarness();
      const params = createParams(sessionFile, workspaceDir);
      const sessionRoot = placement === "root-only" ? nestedCwd : workspaceDir;
      const effectiveCwd = placement === "outside" ? workspaceDir : nestedCwd;
      params.cwd =
        placement === "root-only"
          ? undefined
          : placement === "outside"
            ? path.join(workspaceDir, "..", "rejected-project")
            : nestedCwd;
      params.permissionMode = "full";
      params.sessionRoot = sessionRoot;
      const prepareContinuationRetryCount = vi.fn();
      params.hostCapabilities = {
        ...params.hostCapabilities,
        prepareContinuationRetryCount,
      };
      const run = runCodexAppServerAttempt(params, {
        pluginConfig: { appServer: { mode: "guardian" } },
      });
      await awaitGateBeforeSettlement(
        harness.waitForMethod("turn/start"),
        run,
        "Codex attempt settled before turn/start",
      );
      expect(prepareContinuationRetryCount).toHaveBeenCalledExactlyOnceWith({
        cwd: effectiveCwd,
      });
      await harness.completeTurn({ threadId: "thread-existing", turnId: "turn-1" });
      await run;
      const resumeParams = harness.requests.find((request) => request.method === "thread/resume")
        ?.params as Record<string, unknown> | undefined;
      const turnParams = harness.requests.find((request) => request.method === "turn/start")
        ?.params as Record<string, unknown> | undefined;
      expect(resumeParams?.cwd).toBe(effectiveCwd);
      expect(resumeParams?.runtimeWorkspaceRoots).toEqual([sessionRoot]);
      expect(resumeParams?.approvalPolicy).toBe("never");
      expect(resumeParams?.sandbox).toBe("danger-full-access");
      expect(turnParams?.cwd).toBe(effectiveCwd);
      expect(turnParams?.runtimeWorkspaceRoots).toEqual([sessionRoot]);
      expect(turnParams?.approvalPolicy).toBe("never");
      expect(turnParams?.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
    },
  );
}
