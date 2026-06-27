import type { HermesBridgeConfig } from "./config.js";
import { executeHermesBridgeTask } from "./executor.js";
import { normalizeHermesBridgeRequest } from "./schema.js";
import type { HermesBridgeResult } from "./types.js";

export type MockHermesDelegationInput = {
  taskId: string;
  intent?: string;
  priority?: "high" | "low" | "normal";
  requiresConfirmation?: boolean;
  allowedTools?: string[];
  input?: Record<string, unknown>;
  dryRun?: boolean;
  idempotencyKey?: string;
};

export type MockOpenClawBridge = {
  delegate: (input: MockHermesDelegationInput) => Promise<HermesBridgeResult>;
};

export function createMockOpenClawBridge(config: HermesBridgeConfig): MockOpenClawBridge {
  const idempotencyStore = new Map<string, HermesBridgeResult>();
  return {
    async delegate(input) {
      const normalized = normalizeHermesBridgeRequest({
        requestedBy: "hermes",
        taskId: input.taskId,
        intent: input.intent,
        priority: input.priority,
        requiresConfirmation: input.requiresConfirmation,
        allowedTools: input.allowedTools,
        input: input.input,
        dryRun: input.dryRun,
        idempotencyKey: input.idempotencyKey,
      });
      if (!normalized.ok) {
        return {
          ok: false,
          mode: "mock",
          status: "failed",
          summary: normalized.error.message,
          artifacts: [],
          auditLog: [],
          error: normalized.error,
        };
      }
      if (normalized.request.idempotencyKey) {
        const cached = idempotencyStore.get(normalized.request.idempotencyKey);
        if (cached) {
          return cached;
        }
      }
      const result = await executeHermesBridgeTask({ config, request: normalized.request });
      if (normalized.request.idempotencyKey) {
        idempotencyStore.set(normalized.request.idempotencyKey, result);
      }
      return result;
    },
  };
}

export function createMockHermesClient(params: { bridge: MockOpenClawBridge }) {
  return {
    delegateTask(input: MockHermesDelegationInput): Promise<HermesBridgeResult> {
      return params.bridge.delegate({
        dryRun: true,
        priority: "normal",
        ...input,
      });
    },
  };
}
