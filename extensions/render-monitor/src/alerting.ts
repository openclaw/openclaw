import type { DetectedRenderIncident, RenderMonitorServiceTarget, RenderMonitorState } from "./types.js";

function escapeTelegramMarkdown(raw: string): string {
  // Telegram markdown escaping is complex; use minimal escaping to keep it readable.
  return raw.replaceAll("_", "\\_").replaceAll("*", "\\*").replaceAll("`", "\\`");
}

export function buildIncidentAlertText(params: {
  incident: DetectedRenderIncident;
  incidentId: string;
  service: RenderMonitorServiceTarget;
  dedupeHint?: boolean;
}): string {
  const { incident, service } = params;
  const env = service.environment ? ` (${service.environment})` : "";
  const name = service.name ? ` · ${service.name}` : "";
  const detailsJson =
    incident.details && Object.keys(incident.details).length
      ? `\n\nDetails: ${escapeTelegramMarkdown(JSON.stringify(incident.details))}`
      : "";
  return [
    `🚨 Render incident: *${incident.incidentType}*`,
    `Service: *${service.serviceId}*${name}${env}`,
    `Incident ID: \`${params.incidentId}\``,
    `When: ${new Date(incident.createdAtMs).toISOString()}`,
    ``,
    escapeTelegramMarkdown(incident.summary),
    detailsJson,
  ]
    .join("\n")
    .trim();
}

export function resolveRenderDashboardLinks(serviceId: string): { service: string; logs: string } {
  const base = "https://dashboard.render.com";
  return {
    service: `${base}/services/${serviceId}`,
    logs: `${base}/services/${serviceId}/logs`,
  };
}

