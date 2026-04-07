import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { listMeetings } from "./fathom-client.js";

const CalendarInviteesDomainsType = Type.Union([
  Type.Literal("all"),
  Type.Literal("only_internal"),
  Type.Literal("one_or_more_external"),
]);

const FathomListMeetingsSchema = Type.Object({
  calendar_invitees_domains: Type.Optional(Type.Array(Type.String())),
  calendar_invitees_domains_type: Type.Optional(CalendarInviteesDomainsType),
  created_after: Type.Optional(Type.String({ description: "ISO-8601 timestamp." })),
  created_before: Type.Optional(Type.String({ description: "ISO-8601 timestamp." })),
  cursor: Type.Optional(Type.String()),
  include_action_items: Type.Optional(Type.Boolean()),
  include_crm_matches: Type.Optional(Type.Boolean()),
  include_summary: Type.Optional(Type.Boolean()),
  include_transcript: Type.Optional(Type.Boolean()),
  recorded_by: Type.Optional(Type.Array(Type.String({ format: "email" }))),
  teams: Type.Optional(Type.Array(Type.String())),
}, { additionalProperties: false });

export function createFathomListMeetingsTool(api: OpenClawPluginApi) {
  return {
    name: "fathom_list_meetings",
    label: "Fathom List Meetings",
    description: "List Fathom meetings with filters for teams, recorders, date ranges, external participants, and optional transcript/summary expansion.",
    parameters: FathomListMeetingsSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      return jsonResult(await listMeetings({
        cfg: api.config,
        calendarInviteesDomains: Array.isArray(rawParams.calendar_invitees_domains) ? rawParams.calendar_invitees_domains.filter((v): v is string => typeof v === "string" && v.length > 0) : undefined,
        calendarInviteesDomainsType: readStringParam(rawParams, "calendar_invitees_domains_type") || undefined,
        createdAfter: readStringParam(rawParams, "created_after") || undefined,
        createdBefore: readStringParam(rawParams, "created_before") || undefined,
        cursor: readStringParam(rawParams, "cursor") || undefined,
        includeActionItems: rawParams.include_action_items === true,
        includeCrmMatches: rawParams.include_crm_matches === true,
        includeSummary: rawParams.include_summary === true,
        includeTranscript: rawParams.include_transcript === true,
        recordedBy: Array.isArray(rawParams.recorded_by) ? rawParams.recorded_by.filter((v): v is string => typeof v === "string" && v.length > 0) : undefined,
        teams: Array.isArray(rawParams.teams) ? rawParams.teams.filter((v): v is string => typeof v === "string" && v.length > 0) : undefined,
      }));
    },
  };
}
