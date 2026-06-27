import { describe, expect, it } from "vitest";
import { resolveHermesBridgeConfig } from "./config.js";
import { executeHermesBridgeTask } from "./executor.js";
import { normalizeHermesBridgeRequest } from "./schema.js";

function request(raw: Record<string, unknown>) {
  const normalized = normalizeHermesBridgeRequest(raw);
  if (!normalized.ok) {
    throw new Error(normalized.error.message);
  }
  return normalized.request;
}

describe("executeHermesBridgeTask", () => {
  it("rejects tasks that are not allowlisted", async () => {
    const result = await executeHermesBridgeTask({
      config: resolveHermesBridgeConfig({ enabled: true }),
      request: request({ taskId: "status.echo", input: { message: "hello" } }),
    });

    expect(result).toMatchObject({
      ok: false,
      taskId: "status.echo",
      mode: "mock",
      status: "blocked",
      error: { type: "task_not_allowed" },
    });
  });

  it("executes allowlisted mock-safe tasks", async () => {
    const result = await executeHermesBridgeTask({
      config: resolveHermesBridgeConfig({
        enabled: true,
        mode: "live",
        allowedTasks: ["status.echo"],
      }),
      request: request({
        requestId: "req-1",
        taskId: "status.echo",
        dryRun: true,
        input: { message: "hello" },
      }),
    });

    expect(result).toMatchObject({
      ok: true,
      requestId: "req-1",
      idempotencyKey: "req-1",
      taskId: "status.echo",
      mode: "mock",
      status: "succeeded",
      summary: "Hermes bridge task succeeded: status.echo",
      output: { message: "hello" },
    });
  });

  it("executes the MVP Hermes dry-run task organizer without external side effects", async () => {
    const result = await executeHermesBridgeTask({
      config: resolveHermesBridgeConfig({
        enabled: true,
        allowedTasks: ["tasks.organize_today"],
        allowedTools: [],
      }),
      request: request({
        requestId: "mvp-acceptance",
        taskId: "tasks.organize_today",
        intent: "請 OpenClaw 幫我整理今天的任務，但只做 dry-run。",
        allowedTools: [],
        dryRun: true,
        input: {
          request: "請 OpenClaw 幫我整理今天的任務，但只做 dry-run。",
        },
      }),
    });

    expect(result).toMatchObject({
      ok: true,
      requestId: "mvp-acceptance",
      taskId: "tasks.organize_today",
      mode: "mock",
      status: "succeeded",
      summary: "Dry-run completed. No external side effects were performed.",
      output: {
        dryRun: true,
        sideEffectsPerformed: false,
      },
    });
    expect(result.auditLog).toEqual([
      expect.objectContaining({ step: "accepted" }),
      expect.objectContaining({ step: "executed" }),
    ]);
  });

  it("requires dryRun=true for the MVP task organizer", async () => {
    const result = await executeHermesBridgeTask({
      config: resolveHermesBridgeConfig({
        enabled: true,
        allowedTasks: ["tasks.organize_today"],
      }),
      request: request({
        taskId: "tasks.organize_today",
        dryRun: false,
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      status: "blocked",
      error: { type: "dry_run_required" },
    });
  });

  it("accepts a dry-run OpenClaw agent team delegation without starting agents", async () => {
    const result = await executeHermesBridgeTask({
      config: resolveHermesBridgeConfig({
        enabled: true,
        allowedTasks: ["agents.ask_team"],
        allowedTools: [],
      }),
      request: request({
        requestId: "team-dry-run",
        taskId: "agents.ask_team",
        intent: "請 OpenClaw agent 團隊協助分析目前 Hermes bridge 狀態，但只做 dry-run。",
        allowedTools: [],
        dryRun: true,
        input: {
          team: "openclaw",
          question: "為何 Hermes 還無法呼叫 OpenClaw agent 團隊？",
        },
      }),
    });

    expect(result).toMatchObject({
      ok: true,
      requestId: "team-dry-run",
      taskId: "agents.ask_team",
      mode: "mock",
      status: "succeeded",
      summary: "Dry-run completed. No OpenClaw agents were started.",
      output: {
        team: "openclaw",
        question: "為何 Hermes 還無法呼叫 OpenClaw agent 團隊？",
        dryRun: true,
        agentsStarted: false,
        sideEffectsPerformed: false,
      },
    });
  });

  it("requires confirmation for dangerous mock-only task templates", async () => {
    const result = await executeHermesBridgeTask({
      config: resolveHermesBridgeConfig({
        enabled: true,
        allowedTasks: ["message.send"],
        allowedTools: ["telegram.send"],
      }),
      request: request({
        taskId: "message.send",
        allowedTools: ["telegram.send"],
        input: { body: "do not send" },
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      status: "needs_confirmation",
      error: { type: "confirmation_required" },
    });
  });

  it("blocks templates when required tools are not allowlisted by config and request", async () => {
    const result = await executeHermesBridgeTask({
      config: resolveHermesBridgeConfig({
        enabled: true,
        allowedTasks: ["message.send"],
      }),
      request: request({
        taskId: "message.send",
        requiresConfirmation: true,
        input: { body: "do not send" },
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      status: "blocked",
      error: { type: "tool_not_allowed" },
    });
  });
});
