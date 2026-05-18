import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

// Agent OS — bounded OpenClaw plugin wrapper.
//
// This package intentionally exposes a native OpenClaw plugin entry while
// keeping rollback behavior inert until a separately authorized activation.
// The registration below is metadata-only: it registers no tools, providers,
// services, hooks, runtime readers, channel accessors, or token accessors.
// A separately-authorized future activation may call publishOutboundInspector()
// to wire the global outbound seam exposed in src/infra/outbound/deliver.ts.
// The seam accepts only bounded metadata and cannot suppress delivery.

export interface AgentOsOutboundInspectionContext {
  channel?: string;
  to?: string;
  payloadCount?: number;
  taskId?: string;
  sessionId?: string;
}

export type AgentOsOutboundInspector = (
  ctx: AgentOsOutboundInspectionContext,
) => void;

declare global {
  // eslint-disable-next-line no-var
  var __agentOsRollbackInspectOutbound: AgentOsOutboundInspector | undefined;
}

export function publishOutboundInspector(inspector: AgentOsOutboundInspector): void {
  globalThis.__agentOsRollbackInspectOutbound = (ctx) => {
    inspector({
      channel: ctx.channel,
      to: ctx.to,
      payloadCount: ctx.payloadCount,
      taskId: ctx.taskId,
      sessionId: ctx.sessionId,
    });
  };
}

export function unpublishOutboundInspector(): void {
  delete globalThis.__agentOsRollbackInspectOutbound;
}

// Agent OS WS13 — L1 pure-plugin simulated handler/unit proof.
// Inert namespace export: importing this activates nothing (no Gateway, no
// live runtime, no Slack delivery, no hook registration). Additive only — it
// does not disturb the inert rollback inspector surface above. Plugin
// manifest activation.onStartup remains false.
export * as ws13 from "./src/ws13/index.js";

export default definePluginEntry({
  id: "agent-os",
  name: "Agent OS",
  description:
    "Bounded Agent OS rollback integration metadata surfaces; inert until separately authorized activation.",
  register(api) {
    void api;
  },
});
