import { beforeEach, describe, expect, it } from "vitest";
import { bashTool, processTool } from "./bash-tools.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    const sessions = (list.details as { sessions: Array<{ sessionId: string }> }).sessions;
    expect(sessions.some((s) => s.sessionId === sessionId)).toBe(true);
  });
});
