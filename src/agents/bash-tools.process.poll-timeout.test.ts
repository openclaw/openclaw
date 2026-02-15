import { afterEach, expect, test } from "vitest";
import { resetProcessRegistryForTests } from "./bash-process-registry.js";
import { createExecTool } from "./bash-tools.exec.js";
import { createProcessTool } from "./bash-tools.process.js";

afterEach(() => {
  resetProcessRegistryForTests();
});

const sleepAndEcho =
  process.platform === "win32"
    ? "Start-Sleep -Milliseconds 300; Write-Output done"
    : "sleep 0.3; echo done";

test("process poll waits for completion when timeout is provided", async () => {
  const execTool = createExecTool();
  const processTool = createProcessTool();
  const started = Date.now();
  const run = await execTool.execute("toolcall", {
    command: sleepAndEcho,
    background: true,
  });
  expect(run.details.status).toBe("running");
  const sessionId = run.details.sessionId;

  const poll = await processTool.execute("toolcall", {
    action: "poll",
    sessionId,
    timeout: 2000,
  });
  const elapsedMs = Date.now() - started;
  const details = poll.details as { status?: string; aggregated?: string };
  expect(details.status).toBe("completed");
  expect(details.aggregated ?? "").toContain("done");
  expect(elapsedMs).toBeGreaterThanOrEqual(200);
});

test("process poll accepts string timeout values", async () => {
  const execTool = createExecTool();
  const processTool = createProcessTool();
  const run = await execTool.execute("toolcall", {
    command: sleepAndEcho,
    background: true,
  });
  expect(run.details.status).toBe("running");
  const sessionId = run.details.sessionId;

  const poll = await processTool.execute("toolcall", {
    action: "poll",
    sessionId,
    timeout: "2000",
  });
  const details = poll.details as { status?: string; aggregated?: string };
  expect(details.status).toBe("completed");
  expect(details.aggregated ?? "").toContain("done");
});
