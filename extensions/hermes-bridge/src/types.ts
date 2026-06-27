import type { HermesBridgeMode } from "./config.js";
import type { HermesBridgeRequest, HermesBridgeResult } from "./schema.js";

export type { HermesBridgeRequest, HermesBridgeResult };

export type HermesBridgeTaskContext = {
  request: HermesBridgeRequest;
  mode: HermesBridgeMode;
};

export type HermesBridgeTask = {
  taskId: string;
  description: string;
  dangerous: boolean;
  mockOnly: true;
  requiresDryRun?: boolean;
  requiredTools: string[];
  successSummary?: string;
  execute: (ctx: HermesBridgeTaskContext) => unknown;
};
