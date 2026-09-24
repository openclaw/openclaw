import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { getTaskExecutionObservation } from "../tasks/task-execution-observation.js";
import { getTaskById, listTasksForOwnerKey } from "../tasks/task-registry.js";
import { resetTaskRegistryForTests } from "../tasks/task-registry.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getSession, waitForExecScope } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";

afterEach(() => {
  resetProcessRegistryForTests();
  resetTaskRegistryForTests({ persist: false });
});

it("settles a real quiet background command in the ledger without a completion notification", async () => {
  await withOpenClawTestState({ layout: "home", scenario: "minimal" }, async ({ workspaceDir }) => {
    resetTaskRegistryForTests({ persist: false });
    const sessionKey = "agent:main:quiet-exec-task";
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      cwd: workspaceDir,
      sessionKey,
      scopeKey: sessionKey,
      notifyOnExit: false,
    });
    // Host exec closes stdin. A watched file holds this silent child until the
    // test releases it; the existence check also covers release before startup.
    const releaseFile = path.join(workspaceDir, "release-quiet-exec");
    const source = [
      `const fs = require("node:fs"); const gate = ${JSON.stringify(releaseFile)};`,
      "const watcher = fs.watch(process.cwd(), () => { if (fs.existsSync(gate)) watcher.close(); });",
      "if (fs.existsSync(gate)) watcher.close();",
    ].join(" ");
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`;
    try {
      const result = await tool.execute("quiet-background", { command, background: true });
      expect(result.details.status).toBe("running");
      if (result.details.status !== "running") {
        throw new Error("expected background command");
      }
      const processSession = getSession(result.details.sessionId);
      const rows = listTasksForOwnerKey(sessionKey);
      expect(rows).toHaveLength(1);
      const task = rows[0]!;
      expect(task).toMatchObject({ status: "running", task: command });
      expect(getTaskExecutionObservation(task)).toMatchObject({ state: "running" });
      await writeFile(releaseFile, "");
      await waitForExecScope(sessionKey);
      const completed = getTaskById(task.taskId)!;
      expect(completed).toMatchObject({
        status: "succeeded",
        terminalSummary: "Command completed",
        detail: { exitCode: 0 },
      });
      expect(getTaskExecutionObservation(completed)).toEqual({ state: "finished" });
      expect(processSession?.aggregated).toBe("");
    } finally {
      await writeFile(releaseFile, "");
      await waitForExecScope(sessionKey);
      resetTaskRegistryForTests({ persist: false });
    }
  });
});
