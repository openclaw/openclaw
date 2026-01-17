import { afterEach, expect, test } from "vitest";

import { resetProcessRegistryForTests } from "./bash-process-registry";
import { createExecTool } from "./bash-tools.exec";
import { createProcessTool } from "./bash-tools.process";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  resetProcessRegistryForTests();
});

test("process send-keys encodes Enter for pty sessions", async () => {
  const execTool = createExecTool();
  const processTool = createProcessTool();
  const result = await execTool.execute("toolcall", {
    command:
      "node -e \"process.stdin.on('data', d => { process.stdout.write(d); if (d.includes(10) || d.includes(13)) process.exit(0); });\"",
    pty: true,
    background: true,
  });

  expect(result.details.status).toBe("running");
  const sessionId = result.details.sessionId;
  expect(sessionId).toBeTruthy();

  await processTool.execute("toolcall", {
    action: "send-keys",
    sessionId,
    keys: ["h", "i", "Enter"],
  });

  const deadline = Date.now() + (process.platform === "win32" ? 4000 : 2000);
  while (Date.now() < deadline) {
    await wait(50);
    const poll = await processTool.execute("toolcall", { action: "poll", sessionId });
    const details = poll.details as { status?: string; aggregated?: string };
    if (details.status !== "running") {
      expect(details.status).toBe("completed");
      expect(details.aggregated ?? "").toContain("hi");
      return;
    }
  }

  throw new Error("PTY session did not exit after send-keys");
});
