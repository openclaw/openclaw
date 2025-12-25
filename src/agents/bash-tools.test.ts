import { beforeEach, describe, expect, it } from "vitest";
import {
  bashTool,
  createBashTool,
  createProcessTool,
  processTool,
} from "./bash-tools.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForCompletion(sessionId: string) {
  let status = "running";
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && status === "running") {
    const poll = await processTool.execute("call-wait", {
      action: "poll",
      sessionId,
    });
    status = (poll.details as { status: string }).status;
    if (status === "running") {
      await sleep(20);
    }
  }
  return status;
}

beforeEach(() => {
  resetProcessRegistryForTests();
});

describe("bash tool backgrounding", () => {
  it("backgrounds after yield and can be polled", async () => {
    const result = await bashTool.execute("call1", {
      command: "node -e \"setTimeout(() => { console.log('done') }, 50)\"",
      yieldMs: 10,
    });

    expect(result.details.status).toBe("running");
    const sessionId = (result.details as { sessionId: string }).sessionId;

    let status = "running";
    let output = "";
    const deadline = Date.now() + 2000;

    while (Date.now() < deadline && status === "running") {
      const poll = await processTool.execute("call2", {
        action: "poll",
        sessionId,
      });
      status = (poll.details as { status: string }).status;
      const textBlock = poll.content.find((c) => c.type === "text");
      output = textBlock?.text ?? "";
      if (status === "running") {
        await sleep(20);
      }
    }

    expect(status).toBe("completed");
    expect(output).toContain("done");
  });

  it("supports explicit background", async () => {
    const result = await bashTool.execute("call1", {
      command: "node -e \"setTimeout(() => { console.log('later') }, 50)\"",
      background: true,
    });

    expect(result.details.status).toBe("running");
    const sessionId = (result.details as { sessionId: string }).sessionId;

    const list = await processTool.execute("call2", { action: "list" });
    const sessions = (
      list.details as { sessions: Array<{ sessionId: string }> }
    ).sessions;
    expect(sessions.some((s) => s.sessionId === sessionId)).toBe(true);
  });

  it("derives a session name from the command", async () => {
    const result = await bashTool.execute("call1", {
      command: "echo hello",
      background: true,
    });
    const sessionId = (result.details as { sessionId: string }).sessionId;
    await sleep(25);

    const list = await processTool.execute("call2", { action: "list" });
    const sessions = (
      list.details as { sessions: Array<{ sessionId: string; name?: string }> }
    ).sessions;
    const entry = sessions.find((s) => s.sessionId === sessionId);
    expect(entry?.name).toBe("echo hello");
  });

  it("uses default timeout when timeout is omitted", async () => {
    const customBash = createBashTool({ timeoutSec: 1, backgroundMs: 10 });
    const customProcess = createProcessTool();

    const result = await customBash.execute("call1", {
      command: "node -e \"setInterval(() => {}, 1000)\"",
      background: true,
    });

    const sessionId = (result.details as { sessionId: string }).sessionId;
    let status = "running";
    const deadline = Date.now() + 5000;

    while (Date.now() < deadline && status === "running") {
      const poll = await customProcess.execute("call2", {
        action: "poll",
        sessionId,
      });
      status = (poll.details as { status: string }).status;
      if (status === "running") {
        await sleep(50);
      }
    }

    expect(status).toBe("failed");
  });

  it("logs line-based slices and defaults to last lines", async () => {
    const result = await bashTool.execute("call1", {
      command:
        "node -e \"console.log('one'); console.log('two'); console.log('three');\"",
      background: true,
    });
    const sessionId = (result.details as { sessionId: string }).sessionId;

    const status = await waitForCompletion(sessionId);

    const log = await processTool.execute("call3", {
      action: "log",
      sessionId,
      limit: 2,
    });
    const textBlock = log.content.find((c) => c.type === "text");
    expect(textBlock?.text).toBe("two\nthree");
    expect((log.details as { totalLines?: number }).totalLines).toBe(3);
    expect(status).toBe("completed");
  });

  it("supports line offsets for log slices", async () => {
    const result = await bashTool.execute("call1", {
      command:
        "node -e \"console.log('alpha'); console.log('beta'); console.log('gamma');\"",
      background: true,
    });
    const sessionId = (result.details as { sessionId: string }).sessionId;
    await waitForCompletion(sessionId);

    const log = await processTool.execute("call2", {
      action: "log",
      sessionId,
      offset: 1,
      limit: 1,
    });
    const textBlock = log.content.find((c) => c.type === "text");
    expect(textBlock?.text).toBe("beta");
  });
});
