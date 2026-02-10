import { afterEach, expect, test } from "vitest";
import { sleep } from "../utils";
import { resetProcessRegistryForTests } from "./bash-process-registry";
import { createExecTool } from "./bash-tools.exec";
import { createProcessTool } from "./bash-tools.process";

afterEach(() => {
  resetProcessRegistryForTests();
});

test("process send-keys encodes Enter for pty sessions", async () => {
  const execTool = createExecTool();
  const processTool = createProcessTool();
  const result = await execTool.execute("toolcall", {
    command:
      'node -e "const dataEvent=String.fromCharCode(100,97,116,97);process.stdin.on(dataEvent,d=>{process.stdout.write(d);if(d.includes(10)||d.includes(13))process.exit(0);});"',
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
    await sleep(50);
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

test("process submit sends Enter for pty sessions", async () => {
  const execTool = createExecTool();
  const processTool = createProcessTool();
  const result = await execTool.execute("toolcall", {
    command:
      'node -e "const dataEvent=String.fromCharCode(100,97,116,97);const submitted=String.fromCharCode(115,117,98,109,105,116,116,101,100);process.stdin.on(dataEvent,d=>{if(d.includes(10)||d.includes(13)){process.stdout.write(submitted);process.exit(0);}});"',
    pty: true,
    background: true,
  });

  expect(result.details.status).toBe("running");
  const sessionId = result.details.sessionId;
  expect(sessionId).toBeTruthy();

  await processTool.execute("toolcall", {
    action: "submit",
    sessionId,
  });

  const deadline = Date.now() + (process.platform === "win32" ? 4000 : 2000);
  while (Date.now() < deadline) {
    await sleep(50);
    const poll = await processTool.execute("toolcall", { action: "poll", sessionId });
    const details = poll.details as { status?: string; aggregated?: string };
    if (details.status !== "running") {
      expect(details.status).toBe("completed");
      expect(details.aggregated ?? "").toContain("submitted");
      return;
    }
  }

  throw new Error("PTY session did not exit after submit");
});

test("process list/poll/log expose truncated stderr in details", async () => {
  const execTool = createExecTool({ allowBackground: true, backgroundMs: 0 });
  const processTool = createProcessTool();

  const result = await execTool.execute("toolcall", {
    command: "bash -lc 'for i in $(seq 1 80); do echo \"err-$i\" 1>&2; done; exit 3'",
    background: true,
  });

  expect(result.details.status).toBe("running");
  const sessionId = result.details.sessionId;
  expect(sessionId).toBeTruthy();

  // Wait for process to finish.
  const deadline = Date.now() + 8000;
  let finishedDetails: { status?: string; aggregated?: string; stderr?: string } | undefined;
  while (Date.now() < deadline) {
    const poll = await processTool.execute("toolcall", { action: "poll", sessionId });
    const details = poll.details as { status?: string; aggregated?: string; stderr?: string };
    if (details.status !== "running") {
      finishedDetails = details;
      break;
    }
    await sleep(50);
  }

  expect(finishedDetails).toBeDefined();
  expect(finishedDetails?.status).toBe("failed");
  // stderr may be missing or empty on some platforms, but when present it
  // should be truncated to at most 50 lines.
  if (finishedDetails?.stderr) {
    expect(finishedDetails.stderr.split("\n").length).toBeLessThanOrEqual(50);
  }

  // Check list/log also surface stderr field.
  const list = await processTool.execute("toolcall", { action: "list" });
  const listDetails = list.details as { sessions: Array<{ stderr?: string }> };
  expect(listDetails.sessions.length).toBeGreaterThan(0);
  const listed = listDetails.sessions.find((s) => s.stderr);
  expect(listed?.stderr).toBeDefined();
  expect(listed?.stderr?.split("\n").length ?? 0).toBeLessThanOrEqual(50);

  const log = await processTool.execute("toolcall", {
    action: "log",
    sessionId,
  });
  const logDetails = log.details as { stderr?: string };
  expect(logDetails.stderr).toBeDefined();
  expect(logDetails.stderr?.split("\n").length ?? 0).toBeLessThanOrEqual(50);
});
