import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { listTeams } from "./fathom-client.js";

const Schema = Type.Object({
  cursor: Type.Optional(Type.String()),
}, { additionalProperties: false });

export function createFathomListTeamsTool(api: OpenClawPluginApi) {
  return {
    name: "fathom_list_teams",
    label: "Fathom List Teams",
    description: "List Fathom teams.",
    parameters: Schema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => jsonResult(await listTeams({
      cfg: api.config,
      cursor: readStringParam(rawParams, "cursor") || undefined,
    })),
  };
}
