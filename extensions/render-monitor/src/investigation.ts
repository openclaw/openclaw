import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { RenderMonitorConfigResolved, StoredRenderIncident, RenderMonitorServiceTarget } from "./types.js";

function resolveRenderLinks(service: RenderMonitorServiceTarget): { serviceUrl: string; logsUrl: string } {
  const base = "https://dashboard.render.com";
  return {
    serviceUrl: `${base}/services/${service.serviceId}`,
    logsUrl: `${base}/services/${service.serviceId}/logs`,
  };
}

function buildInvestigationPrompt(params: {
  config: RenderMonitorConfigResolved;
  incident: StoredRenderIncident;
  service: RenderMonitorServiceTarget;
}): string {
  const { incident, service } = params;
  const links = resolveRenderLinks(service);

  return [
    "You are OpenClaw's remediation investigator for a Render incident.",
    "",
    "Goal:",
    "Return a machine-readable remediation proposal for a Git repository that will fix the incident.",
    "",
    "Incident:",
    `- incidentId: ${incident.id}`,
    `- incidentType: ${incident.incidentType}`,
    `- serviceId: ${incident.serviceId}`,
    `- summary: ${incident.summary}`,
    `- createdAtMs: ${incident.createdAtMs}`,
    `- lastDetectedAtMs: ${incident.lastDetectedAtMs}`,
    `- acknowledgedAtMs: ${incident.acknowledgedAtMs ?? null}`,
    "",
    "Incident details (may include Render API fields):",
    JSON.stringify(incident.details ?? {}, null, 2),
    "",
    "Render links:",
    `- service: ${links.serviceUrl}`,
    `- logs: ${links.logsUrl}`,
    "",
    "Git remediation constraints:",
    "- The actual git edits/push must be done ONLY by the OpenClaw /apply workflow after explicit operator approval.",
    "- You must propose the exact unified diff patch and the git commit message and the target branch/push branch details.",
    "",
    "Output requirements (critical):",
    "- Output EXACTLY one JSON object with this schema and no other text:",
    "{",
    "  \"proposal\": {",
    "    \"repo\": {",
    "      \"repoPath\": string,",
    "      \"githubRepo\": string,",
    "      \"remote\": string",
    "    },",
    "    \"git\": {",
    "      \"baseBranch\": string,",
    "      \"deployBranch\": string,",
    "      \"newBranch\": string",
    "    },",
    "    \"commit\": {",
    "      \"message\": string",
    "    },",
    "    \"patchUnifiedDiff\": string",
    "  },",
    "  \"reasoning\": {",
    "    \"hypothesis\": string,",
    "    \"evidence\": string[],",
    "    \"verification\": string[]",
    "  }",
    "}",
    "",
    "- patchUnifiedDiff must be a valid unified diff against the repo working tree.",
    "- verification should mention how to validate via CI and Render health checks.",
    "",
    "Now produce the JSON response.",
  ].join("\n");
}

export async function startRenderInvestigation(params: {
  api: OpenClawPluginApi;
  config: RenderMonitorConfigResolved;
  incident: StoredRenderIncident;
  service: RenderMonitorServiceTarget;
}): Promise<{ runId: string; sessionKey: string }> {
  const { api, config, incident, service } = params;
  const sessionKey = `render-monitor:investigate:${incident.id}`;

  const run = await api.runtime.subagent.run({
    sessionKey,
    message: buildInvestigationPrompt({ config, incident, service }),
    deliver: false,
    idempotencyKey: `render-monitor:investigate:${incident.id}`,
  });

  return { runId: run.runId, sessionKey };
}

