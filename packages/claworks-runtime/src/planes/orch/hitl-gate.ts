import { randomUUID } from "node:crypto";
import type { PlaybookRun } from "./playbook-types.js";

export interface HitlPending {
  runId: string;
  stepId: string;
  message: string;
  options: string[];
  createdAt: Date;
}

export interface HitlGate {
  suspend(run: PlaybookRun, stepId: string, message: string, options: string[]): string;
  resolve(token: string, decision: string, comment?: string): HitlPending | null;
  get(token: string): HitlPending | undefined;
}

export function createHitlGate(): HitlGate {
  const pending = new Map<string, HitlPending>();

  return {
    suspend(run, stepId, message, options) {
      const token = randomUUID();
      pending.set(token, {
        runId: run.id,
        stepId,
        message,
        options,
        createdAt: new Date(),
      });
      return token;
    },

    resolve(token, decision, _comment) {
      const entry = pending.get(token);
      if (!entry) {
        return null;
      }
      pending.delete(token);
      return { ...entry, decision } as HitlPending & { decision: string };
    },

    get(token) {
      return pending.get(token);
    },
  };
}
