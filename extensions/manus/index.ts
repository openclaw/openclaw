/**
 * OpenClaw Manus Plugin
 *
 * Integration with Manus AI for async research tasks.
 * Tracks credit usage, provides budget awareness, and auto-notification.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { ManusTracker } from "./src/tracker.js";

export default function register(api: OpenClawPluginApi) {
  const tracker = new ManusTracker();

  // Load config from environment
  const config = api.config;
  const env = config.env ?? {};

  const budgetStr = env.MANUS_MONTHLY_CREDIT_BUDGET as string | undefined;
  if (budgetStr) {
    const budget = Number(budgetStr);
    if (Number.isFinite(budget) && budget > 0) {
      tracker.setMonthlyBudget(budget);
    }
  }

  // Register gateway method: usage.manus.track
  api.registerGatewayMethod("usage.manus.track", async ({ respond, params }) => {
    const taskId = typeof params?.taskId === "string" ? params.taskId : undefined;
    const credits = typeof params?.credits === "number" ? params.credits : undefined;
    const status =
      typeof params?.status === "string"
        ? (params.status as "completed" | "error" | "running")
        : undefined;
    const description = typeof params?.description === "string" ? params.description : undefined;

    if (!taskId || credits === undefined) {
      respond(false, undefined, {
        code: -32602,
        message: "Missing required params: taskId, credits",
      });
      return;
    }

    tracker.recordTask({ taskId, credits, status, description });
    const summary = tracker.getSummary();
    respond(true, { recorded: true, summary }, undefined);
  });

  // Register gateway method: usage.manus.summary
  api.registerGatewayMethod("usage.manus.summary", async ({ respond }) => {
    const summary = tracker.getSummary();
    respond(true, summary, undefined);
  });

  // Register gateway method: usage.manus.budget
  api.registerGatewayMethod("usage.manus.budget", async ({ respond }) => {
    const context = tracker.getBudgetContext();
    respond(true, context, undefined);
  });

  // Register tool for agents to track Manus tasks
  api.registerTool(
    () => ({
      name: "manus_track",
      description: "Track a Manus AI task completion (credits used)",
      parameters: Type.Object({
        taskId: Type.String({ description: "Manus task ID" }),
        credits: Type.Number({ description: "Credits consumed" }),
        status: Type.Optional(
          Type.Union([Type.Literal("completed"), Type.Literal("error"), Type.Literal("running")]),
        ),
        description: Type.Optional(Type.String({ description: "Task description" })),
      }),
      execute: async ({ taskId, credits, status, description }) => {
        tracker.recordTask({ taskId, credits, status, description });
        return { success: true, summary: tracker.getSummary() };
      },
    }),
    { optional: true },
  );

  api.log.info("[manus] Plugin loaded - credit tracking enabled");
}
