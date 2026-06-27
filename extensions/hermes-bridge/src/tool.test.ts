import { describe, expect, it } from "vitest";
import { resolveHermesBridgeConfig } from "./config.js";
import { createHermesBridgeTool } from "./tool.js";

async function executeTool(rawParams: Record<string, unknown>) {
  const tool = createHermesBridgeTool({
    config: resolveHermesBridgeConfig({
      enabled: true,
      allowedTasks: ["status.echo", "status.health", "message.preview", "message.send"],
      allowedTools: ["telegram.send"],
    }),
  });
  const result = await tool.execute("call-1", rawParams);
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  return JSON.parse(text) as unknown;
}

describe("hermes_bridge tool", () => {
  it("lists mock-safe task templates", async () => {
    await expect(executeTool({ action: "list_tasks" })).resolves.toMatchObject({
      tasks: [
        { taskId: "status.echo" },
        { taskId: "status.health" },
        { taskId: "message.preview" },
        { taskId: "tasks.organize_today" },
        { taskId: "agents.ask_team" },
        { taskId: "message.send", dangerous: true },
      ],
    });
  });

  it("invokes mock tasks through the same allowlisted executor", async () => {
    await expect(
      executeTool({
        action: "invoke_mock",
        taskId: "status.echo",
        input: { message: "hello" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      mode: "mock",
      taskId: "status.echo",
      status: "succeeded",
      output: { message: "hello" },
    });
  });

  it("reports the configured Hermes checkout path and runtime mode", async () => {
    await expect(executeTool({ action: "status" })).resolves.toMatchObject({
      enabled: true,
      hermesMode: "mock",
      hermesAgentPath: "../hermes-agent",
    });
  });
});
