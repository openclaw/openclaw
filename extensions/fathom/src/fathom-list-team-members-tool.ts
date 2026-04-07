import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { listTeamMembers } from "./fathom-client.js";

const Schema = Type.Object({
  cursor: Type.Optional(Type.String()),
  team: Type.Optional(Type.String()),
}, { additionalProperties: false });

export function createFathomListTeamMembersTool(api: OpenClawPluginApi) {
  return {
    name: "fathom_list_team_members",
    label: "Fathom List Team Members",
    description: "List Fathom team members, optionally filtering by team name.",
    parameters: Schema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => jsonResult(await listTeamMembers({
      cfg: api.config,
      cursor: readStringParam(rawParams, "cursor") || undefined,
      team: readStringParam(rawParams, "team") || undefined,
    })),
  };
}
