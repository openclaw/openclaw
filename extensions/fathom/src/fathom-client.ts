import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { readResponseText } from "openclaw/plugin-sdk/provider-web-search";
import { wrapExternalContent } from "openclaw/plugin-sdk/security-runtime";
import {
  DEFAULT_FATHOM_BASE_URL,
  resolveFathomApiKey,
  resolveFathomBaseUrl,
  resolveFathomTimeoutSeconds,
} from "./config.js";

export type FathomRequestOptions = {
  cfg?: OpenClawConfig;
  method?: "GET" | "POST" | "DELETE";
  pathname: string;
  query?: Record<string, string | number | boolean | string[] | undefined>;
  body?: Record<string, unknown>;
  timeoutSeconds?: number;
  errorLabel: string;
};

function resolveEndpoint(baseUrl: string, pathname: string, query?: FathomRequestOptions["query"]): string {
  const trimmed = baseUrl.trim() || DEFAULT_FATHOM_BASE_URL;
  const url = new URL(trimmed.replace(/\/$/, "") + pathname);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item) url.searchParams.append(key, item);
        }
        continue;
      }
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function fathomFetch<T = Record<string, unknown>>(options: FathomRequestOptions): Promise<T> {
  const apiKey = resolveFathomApiKey(options.cfg);
  if (!apiKey) {
    throw new Error(
      "Fathom tools need a Fathom API key. Set FATHOM_API_KEY in the Gateway environment, or configure plugins.entries.fathom.config.fathom.apiKey.",
    );
  }

  const response = await fetch(resolveEndpoint(resolveFathomBaseUrl(options.cfg), options.pathname, options.query), {
    method: options.method ?? "GET",
    headers: {
      "X-Api-Key": apiKey,
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(resolveFathomTimeoutSeconds(options.timeoutSeconds) * 1000),
  });

  if (!response.ok) {
    const text = await readResponseText(response);
    throw new Error(`${options.errorLabel} failed (${response.status}): ${text || response.statusText}`);
  }

  if (response.status === 204) {
    return { ok: true } as T;
  }

  return (await response.json()) as T;
}

function wrapMaybeString(value: unknown) {
  return typeof value === "string"
    ? wrapExternalContent(value, { source: "web_fetch", includeWarning: false })
    : value;
}

export async function listMeetings(params: {
  cfg?: OpenClawConfig;
  calendarInviteesDomains?: string[];
  calendarInviteesDomainsType?: string;
  createdAfter?: string;
  createdBefore?: string;
  cursor?: string;
  includeActionItems?: boolean;
  includeCrmMatches?: boolean;
  includeSummary?: boolean;
  includeTranscript?: boolean;
  recordedBy?: string[];
  teams?: string[];
  timeoutSeconds?: number;
}) {
  return fathomFetch({
    cfg: params.cfg,
    pathname: "/meetings",
    query: {
      "calendar_invitees_domains[]": params.calendarInviteesDomains,
      calendar_invitees_domains_type: params.calendarInviteesDomainsType,
      created_after: params.createdAfter,
      created_before: params.createdBefore,
      cursor: params.cursor,
      include_action_items: params.includeActionItems,
      include_crm_matches: params.includeCrmMatches,
      include_summary: params.includeSummary,
      include_transcript: params.includeTranscript,
      "recorded_by[]": params.recordedBy,
      "teams[]": params.teams,
    },
    timeoutSeconds: params.timeoutSeconds,
    errorLabel: "Fathom list meetings",
  });
}

export async function getSummary(params: {
  cfg?: OpenClawConfig;
  recordingId: number;
  destinationUrl?: string;
  timeoutSeconds?: number;
}) {
  const payload = await fathomFetch<Record<string, unknown>>({
    cfg: params.cfg,
    pathname: `/recordings/${params.recordingId}/summary`,
    query: { destination_url: params.destinationUrl },
    timeoutSeconds: params.timeoutSeconds,
    errorLabel: "Fathom get summary",
  });
  if (payload && typeof payload === "object" && payload.summary && typeof payload.summary === "object") {
    const summary = payload.summary as Record<string, unknown>;
    return {
      ...payload,
      summary: {
        ...summary,
        markdown_formatted: wrapMaybeString(summary.markdown_formatted),
      },
    };
  }
  return payload;
}

export async function getTranscript(params: {
  cfg?: OpenClawConfig;
  recordingId: number;
  destinationUrl?: string;
  timeoutSeconds?: number;
}) {
  const payload = await fathomFetch<Record<string, unknown>>({
    cfg: params.cfg,
    pathname: `/recordings/${params.recordingId}/transcript`,
    query: { destination_url: params.destinationUrl },
    timeoutSeconds: params.timeoutSeconds,
    errorLabel: "Fathom get transcript",
  });
  if (Array.isArray(payload.transcript)) {
    return {
      ...payload,
      transcript: payload.transcript.map((item) => {
        if (!item || typeof item !== "object") return item;
        const entry = item as Record<string, unknown>;
        return {
          ...entry,
          text: wrapMaybeString(entry.text),
        };
      }),
    };
  }
  return payload;
}

export async function listTeams(params: { cfg?: OpenClawConfig; cursor?: string; timeoutSeconds?: number }) {
  return fathomFetch({
    cfg: params.cfg,
    pathname: "/teams",
    query: { cursor: params.cursor },
    timeoutSeconds: params.timeoutSeconds,
    errorLabel: "Fathom list teams",
  });
}

export async function listTeamMembers(params: {
  cfg?: OpenClawConfig;
  cursor?: string;
  team?: string;
  timeoutSeconds?: number;
}) {
  return fathomFetch({
    cfg: params.cfg,
    pathname: "/team_members",
    query: { cursor: params.cursor, team: params.team },
    timeoutSeconds: params.timeoutSeconds,
    errorLabel: "Fathom list team members",
  });
}

export async function createWebhook(params: {
  cfg?: OpenClawConfig;
  destinationUrl: string;
  triggeredFor: string[];
  includeTranscript?: boolean;
  includeCrmMatches?: boolean;
  includeSummary?: boolean;
  includeActionItems?: boolean;
  timeoutSeconds?: number;
}) {
  return fathomFetch({
    cfg: params.cfg,
    method: "POST",
    pathname: "/webhooks",
    body: {
      destination_url: params.destinationUrl,
      triggered_for: params.triggeredFor,
      include_transcript: params.includeTranscript === true,
      include_crm_matches: params.includeCrmMatches === true,
      include_summary: params.includeSummary === true,
      include_action_items: params.includeActionItems === true,
    },
    timeoutSeconds: params.timeoutSeconds,
    errorLabel: "Fathom create webhook",
  });
}

export async function deleteWebhook(params: {
  cfg?: OpenClawConfig;
  id: string;
  timeoutSeconds?: number;
}) {
  return fathomFetch({
    cfg: params.cfg,
    method: "DELETE",
    pathname: `/webhooks/${encodeURIComponent(params.id)}`,
    timeoutSeconds: params.timeoutSeconds,
    errorLabel: "Fathom delete webhook",
  });
}

export const __testing = {
  resolveEndpoint,
};
