import { jsonResult } from "openclaw/plugin-sdk/core";
import { Type } from "typebox";
import type { HermesBridgeConfig } from "./config.js";
import { executeHermesBridgeTask } from "./executor.js";
import { normalizeHermesBridgeRequest } from "./schema.js";
import { listHermesBridgeTasks } from "./task-registry.js";

type ToolParams = {
  action?: string;
  taskId?: string;
  requestId?: string;
  idempotencyKey?: string;
  intent?: string;
  priority?: string;
  requiresConfirmation?: boolean;
  allowedTools?: string[];
  dryRun?: boolean;
  input?: Record<string, unknown>;
};

function readInput(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function createHermesBridgeTool(params: { config: HermesBridgeConfig }) {
  return {
    name: "hermes_bridge",
    label: "Hermes Bridge",
    description:
      "Inspect the Hermes bridge and invoke mock-safe Hermes task templates for local testing.",
    parameters: Type.Object({
      action: Type.String({ enum: ["status", "list_tasks", "invoke_mock"] }),
      taskId: Type.Optional(Type.String()),
      requestId: Type.Optional(Type.String()),
      idempotencyKey: Type.Optional(Type.String()),
      intent: Type.Optional(Type.String()),
      priority: Type.Optional(Type.String({ enum: ["low", "normal", "high"] })),
      requiresConfirmation: Type.Optional(Type.Boolean()),
      allowedTools: Type.Optional(Type.Array(Type.String())),
      dryRun: Type.Optional(Type.Boolean()),
      input: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const raw = rawParams as ToolParams;
      const action = raw.action ?? "status";
      if (action === "status") {
        return jsonResult({
          enabled: params.config.enabled,
          mode: params.config.mode,
          hermesMode: params.config.hermesMode,
          hermesAgentPath: params.config.hermesAgentPath,
          sharedSecretEnv: params.config.sharedSecretEnv,
          allowedTasks: params.config.allowedTasks,
          maxRequestBytes: params.config.maxRequestBytes,
        });
      }
      if (action === "list_tasks") {
        return jsonResult({
          tasks: listHermesBridgeTasks().map((task) => ({
            taskId: task.taskId,
            description: task.description,
            mockOnly: task.mockOnly,
            dangerous: task.dangerous,
            requiredTools: task.requiredTools,
            allowed: params.config.allowedTasks.includes(task.taskId),
          })),
        });
      }
      if (action === "invoke_mock") {
        if (!raw.taskId) {
          throw new Error("taskId required");
        }
        const normalized = normalizeHermesBridgeRequest({
          taskId: raw.taskId,
          requestId: raw.requestId,
          idempotencyKey: raw.idempotencyKey,
          intent: raw.intent,
          priority: raw.priority,
          requiresConfirmation: raw.requiresConfirmation,
          allowedTools: raw.allowedTools,
          input: readInput(raw.input),
          dryRun: raw.dryRun,
        });
        if (!normalized.ok) {
          throw new Error(normalized.error.message);
        }
        return jsonResult(
          await executeHermesBridgeTask({
            config: { ...params.config, mode: "mock" },
            request: normalized.request,
          }),
        );
      }
      throw new Error(`Unsupported Hermes bridge action: ${action}`);
    },
  };
}
