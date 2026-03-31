import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { loadRenderMonitorConfig } from "./config.js";
import type { RenderIncidentType } from "./types.js";
import {
  ackIncident,
  listMutes,
  loadRenderMonitorState,
  muteService,
  resolveIncidentById,
  saveRenderMonitorState,
  unmuteService,
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

  // ── /mute ──────────────────────────────────────────────────────

  const VALID_INCIDENT_TYPES: RenderIncidentType[] = [
    "service_error",
    "healthcheck_failed",
    "deploy_failed",
    "http_unavailable",
    "crash_repeated",
    "log_error",
    "unknown_error",
  ];

  function parseDuration(raw: string): number | null {
    const match = raw.match(/^(\d+)\s*(m|min|h|hour|hours|d|day|days|w|week|weeks)$/i);
    if (!match) return null;
    const n = Number(match[1]);
    const unit = match[2].toLowerCase();
    if (unit.startsWith("m")) return n * 60_000;
    if (unit.startsWith("h")) return n * 3_600_000;
    if (unit.startsWith("d")) return n * 86_400_000;
    if (unit.startsWith("w")) return n * 604_800_000;
    return null;
  }

  api.registerCommand({
    name: "mute",
    description: "Mute alerts for a service. Usage: /mute <serviceId> [incidentType] [duration]",
    acceptsArgs: true,
    handler: async (ctx) => {
      if (!ctx.isAuthorizedSender) {
        return { text: "Not authorized." };
      }
      const parts = (ctx.args?.trim() ?? "").split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        return {
          text: [
            "Usage: /mute <serviceId> [incidentType] [duration]",
            "",
            "Examples:",
            "  /mute srv-xxx                    — mute all alerts permanently",
            "  /mute srv-xxx http_unavailable    — mute HTTP probes only",
            "  /mute srv-xxx http_unavailable 24h — mute for 24 hours",
            "  /mute srv-xxx all 7d              — mute all alerts for 7 days",
            "",
            `Incident types: ${VALID_INCIDENT_TYPES.join(", ")}`,
          ].join("\n"),
        };
      }

      const serviceId = parts[0];
      const config = loadRenderMonitorConfig(api);
      const service = config.services.find((s) => s.serviceId === serviceId || s.name === serviceId);
      const resolvedServiceId = service?.serviceId ?? serviceId;

      let incidentType: RenderIncidentType | null = null;
      let durationMs: number | null = null;

      if (parts[1] && parts[1] !== "all") {
        if (VALID_INCIDENT_TYPES.includes(parts[1] as RenderIncidentType)) {
          incidentType = parts[1] as RenderIncidentType;
        } else {
          return { text: `Unknown incident type "${parts[1]}". Valid: ${VALID_INCIDENT_TYPES.join(", ")}` };
        }
      }

      if (parts[2]) {
        durationMs = parseDuration(parts[2]);
        if (durationMs === null) {
          return { text: `Invalid duration "${parts[2]}". Use: 30m, 6h, 1d, 2w` };
        }
      }

      const stateDir = api.runtime.state.resolveStateDir();
      let state = await loadRenderMonitorState(stateDir);
      state = muteService({
        state,
        serviceId: resolvedServiceId,
        incidentType,
        durationMs,
        reason: ctx.args?.trim(),
      });
      await saveRenderMonitorState(stateDir, state);

      const typePart = incidentType ? ` (${incidentType})` : " (all types)";
      const durationPart = durationMs
        ? ` for ${parts[2]}`
        : " permanently (use /unmute to reactivate)";
      const namePart = service?.name ? ` · ${service.name}` : "";
      return { text: `🔇 Muted ${resolvedServiceId}${namePart}${typePart}${durationPart}` };
    },
  });

  api.registerCommand({
    name: "unmute",
    description: "Unmute alerts for a service. Usage: /unmute <serviceId> [incidentType]",
    acceptsArgs: true,
    handler: async (ctx) => {
      if (!ctx.isAuthorizedSender) {
        return { text: "Not authorized." };
      }
      const parts = (ctx.args?.trim() ?? "").split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        return { text: "Usage: /unmute <serviceId> [incidentType]" };
      }

      const serviceId = parts[0];
      const config = loadRenderMonitorConfig(api);
      const service = config.services.find((s) => s.serviceId === serviceId || s.name === serviceId);
      const resolvedServiceId = service?.serviceId ?? serviceId;

      let incidentType: RenderIncidentType | null = null;
      if (parts[1] && parts[1] !== "all") {
        if (VALID_INCIDENT_TYPES.includes(parts[1] as RenderIncidentType)) {
          incidentType = parts[1] as RenderIncidentType;
        }
      }

      const stateDir = api.runtime.state.resolveStateDir();
      let state = await loadRenderMonitorState(stateDir);
      const res = unmuteService({ state, serviceId: resolvedServiceId, incidentType });
      if (!res.changed) {
        return { text: `No active mute found for ${resolvedServiceId}.` };
      }
      await saveRenderMonitorState(stateDir, res.state);
      const namePart = service?.name ? ` · ${service.name}` : "";
      return { text: `🔔 Unmuted ${resolvedServiceId}${namePart}. Alerts are active again.` };
    },
  });

  api.registerCommand({
    name: "mutes",
    description: "List active mutes.",
    acceptsArgs: false,
    handler: async (ctx) => {
      if (!ctx.isAuthorizedSender) {
        return { text: "Not authorized." };
      }
      const stateDir = api.runtime.state.resolveStateDir();
      const state = await loadRenderMonitorState(stateDir);
      const config = loadRenderMonitorConfig(api);
      const nowMs = Date.now();
      const active = listMutes(state, nowMs);

      if (active.length === 0) {
        return { text: "No active mutes. All alerts are enabled." };
      }

      const lines = active.map((m) => {
        const svc = config.services.find((s) => s.serviceId === m.serviceId);
        const name = svc?.name ? ` · ${svc.name}` : "";
        const type = m.incidentType ?? "all";
        const expires = m.expiresAtMs
          ? `expires ${new Date(m.expiresAtMs).toISOString()}`
          : "permanent";
        return `  🔇 ${m.serviceId}${name} — ${type} (${expires})`;
      });

      return { text: `Active mutes:\n${lines.join("\n")}` };
    },
  });
}

