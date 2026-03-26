import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { loadRenderMonitorConfig } from "./config.js";
import {
  ackIncident,
  loadRenderMonitorState,
  resolveIncidentById,
  saveRenderMonitorState,
  upsertInvestigation,
} from "./state-store.js";
import { startRenderInvestigation } from "./investigation.js";
import { applyRenderRemediation } from "./remediation.js";

function readSingleArg(args: string | undefined): string | null {
  const trimmed = args?.trim() ?? "";
  if (!trimmed) {
    return null;
  }
  const token = trimmed.split(/\s+/).filter(Boolean)[0];
  return token?.trim() || null;
}

export function registerRenderMonitorCommands(api: OpenClawPluginApi): void {
  api.registerCommand({
    name: "ack",
    description: "Acknowledge a render incident so alerts are suppressed.",
    acceptsArgs: true,
    handler: async (ctx) => {
      if (!ctx.isAuthorizedSender) {
        return { text: "Not authorized." };
      }
      const incidentId = readSingleArg(ctx.args);
      if (!incidentId) {
        return { text: "Usage: /ack <incidentId>" };
      }

      const stateDir = api.runtime.state.resolveStateDir();
      const state = await loadRenderMonitorState(stateDir);
      const res = ackIncident({ state, incidentId });
      if (!res.changed) {
        return { text: `Incident ${incidentId} not found or already acknowledged.` };
      }
      await saveRenderMonitorState(stateDir, res.state);
      return { text: `✅ Incident ${incidentId} acknowledged.` };
    },
  });

  api.registerCommand({
    name: "logs",
    description: "Show cached Render incident context (logs + metadata).",
    acceptsArgs: true,
    handler: async (ctx) => {
      if (!ctx.isAuthorizedSender) {
        return { text: "Not authorized." };
      }
      const incidentId = readSingleArg(ctx.args);
      if (!incidentId) {
        return { text: "Usage: /logs <incidentId>" };
      }
      const stateDir = api.runtime.state.resolveStateDir();
      const state = await loadRenderMonitorState(stateDir);
      const incident = resolveIncidentById(state, incidentId);
      if (!incident) {
        return { text: `Incident ${incidentId} not found.` };
      }

      const investigation = incident.lastInvestigation;
      const details = incident.details ? JSON.stringify(incident.details, null, 2) : null;
      const text = [
        `🧾 Render incident ${incident.id}`,
        `Type: ${incident.incidentType}`,
        `Service: ${incident.serviceId}`,
        `Summary: ${incident.summary}`,
        investigation?.runId ? `Investigation runId: ${investigation.runId}` : null,
        investigation?.proposal
          ? `Proposal cached (truncated): ${JSON.stringify(investigation.proposal).slice(0, 800)}`
          : null,
        details ? `\nDetails:\n${details}` : null,
      ]
        .filter(Boolean)
        .join("\n");
      return { text };
    },
  });

  api.registerCommand({
    name: "investigate",
    description: "Trigger an automated OpenClaw remediation investigation (no git push yet).",
    acceptsArgs: true,
    handler: async (ctx) => {
      if (!ctx.isAuthorizedSender) {
        return { text: "Not authorized." };
      }
      const incidentId = readSingleArg(ctx.args);
      if (!incidentId) {
        return { text: "Usage: /investigate <incidentId>" };
      }

      const config = loadRenderMonitorConfig(api);
      const stateDir = api.runtime.state.resolveStateDir();
      let state = await loadRenderMonitorState(stateDir);
      const incident = resolveIncidentById(state, incidentId);
      if (!incident) {
        return { text: `Incident ${incidentId} not found.` };
      }

      const service = config.services.find((s) => s.serviceId === incident.serviceId);
      if (!service) {
        return { text: `No configured target for service ${incident.serviceId}.` };
      }

      const { runId, sessionKey } = await startRenderInvestigation({
        api,
        config,
        incident,
        service,
      });

      state = upsertInvestigation({
        state,
        incidentId,
        investigation: {
          runId,
          sessionKey,
          startedAtMs: Date.now(),
        },
      });
      await saveRenderMonitorState(stateDir, state);

      return {
        text: [
          `🧠 Investigation triggered for incident ${incidentId}.`,
          `runId: ${runId}`,
          "",
          "When ready, trigger the actual remediation push with:",
          `/apply ${incidentId}`,
        ].join("\n"),
      };
    },
  });

  api.registerCommand({
    name: "apply",
    description: "Apply proposed remediation and push to git (requires /apply approval policy).",
    acceptsArgs: true,
    handler: async (ctx) => {
      if (!ctx.isAuthorizedSender) {
        return { text: "Not authorized." };
      }
      const incidentId = readSingleArg(ctx.args);
      if (!incidentId) {
        return { text: "Usage: /apply <incidentId>" };
      }

      const config = loadRenderMonitorConfig(api);
      const stateDir = api.runtime.state.resolveStateDir();
      const state = await loadRenderMonitorState(stateDir);
      const incident = resolveIncidentById(state, incidentId);
      if (!incident) {
        return { text: `Incident ${incidentId} not found.` };
      }
      const service = config.services.find((s) => s.serviceId === incident.serviceId);
      if (!service) {
        return { text: `No configured target for service ${incident.serviceId}.` };
      }

      if (!incident.lastInvestigation?.runId || !incident.lastInvestigation.sessionKey) {
        return { text: `No investigation recorded for incident ${incidentId}. Run /investigate first.` };
      }

      const res = await applyRenderRemediation({ api, config, incident, service });
      if (res.ok) {
        return { text: `✅ /apply completed: ${res.summary}` };
      }
      return { text: `❌ /apply failed: ${res.error}\n\n${res.summary}` };
    },
  });
}

