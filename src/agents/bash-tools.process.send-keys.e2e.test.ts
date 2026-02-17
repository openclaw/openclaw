import { afterEach, expect, test } from "vitest";
import { sleep } from "../utils";
import { resetProcessRegistryForTests } from "./bash-process-registry";
import { createExecTool } from "./bash-tools.exec";
import { createProcessTool } from "./bash-tools.process";

afterEach(() => {
  resetProcessRegistryForTests();
});

async function startPtySession(command: string) {
  const execTool = createExecTool();
  const processTool = createProcessTool();
  const result = await execTool.execute("toolcall", {
    command,
    pty: true,
    background: true,
  });

  expect(result.details.status).toBe("running");
  const sessionId = result.details.sessionId;
  expect(sessionId).toBeTruthy();
  return { processTool, sessionId };
}

async function waitForSessionCompletion(params: {
  processTool: ReturnType<typeof createProcessTool>;
  sessionId: string;
  expectedText: string;
}) {
  const deadline = Date.now() + (process.platform === "win32" ? 4000 : 2000);
  while (Date.now() < deadline) {
    await sleep(50);
    const poll = await params.processTool.execute("toolcall", {
      action: "poll",
      sessionId: params.sessionId,
    });
    const details = poll.details as { status?: string; aggregated?: string };
    if (details.status !== "running") {
      expect(details.status).toBe("completed");
      expect(details.aggregated ?? "").toContain(params.expectedText);
      return;
    }
  }

  throw new Error(`PTY session did not exit after ${params.expectedText}`);
}

test("process send-keys encodes Enter for pty sessions", async () => {
  const { processTool, sessionId } = await startPtySession(
    'node -e "const dataEvent=String.fromCharCode(100,97,116,97);process.stdin.on(dataEvent,d=>{process.stdout.write(d);if(d.includes(10)||d.includes(13))process.exit(0);});"',
  );

  await processTool.execute("toolcall", {
    action: "send-keys",
    sessionId,
    keys: ["h", "i", "Enter"],
  });

  await waitForSessionCompletion({ processTool, sessionId, expectedText: "hi" });
});

test("process submit sends Enter for pty sessions", async () => {
  const { processTool, sessionId } = await startPtySession(
    'node -e "const dataEvent=String.fromCharCode(100,97,116,97);const submitted=String.fromCharCode(115,117,98,109,105,116,116,101,100);process.stdin.on(dataEvent,d=>{if(d.includes(10)||d.includes(13)){process.stdout.write(submitted);process.exit(0);}});"',
  );

  await processTool.execute("toolcall", {
    action: "submit",
    sessionId,
  });

  await waitForSessionCompletion({ processTool, sessionId, expectedText: "submitted" });
});
