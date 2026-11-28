import { Type } from "typebox";
import { strictObject } from "./tools-card-mutations.js";

export const sessionsBoardScopeField = Type.Optional(
  strictObject({
    agentIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    includeSessionKeys: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
        description:
          "Only include these exact session keys. An empty array selects no sessions. Omit this field to include all matching sessions.",
      }),
    ),
    group: Type.Optional(
      Type.String({
        description: "Exact sidebar group name. An empty string selects ungrouped sessions.",
      }),
    ),
    projectId: Type.Optional(
      Type.String({ minLength: 1, description: "Exact ID of the project linked to the session." }),
    ),
    titleContains: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Case-insensitive text to match in session titles.",
      }),
    ),
    includeArchived: Type.Optional(Type.Boolean()),
    includeAutomation: Type.Optional(
      Type.Boolean({
        description: "Include automation (cron) and system sessions. Defaults to false.",
      }),
    ),
    includeHome: Type.Optional(
      Type.Boolean({
        description: "Include each agent's Home session. Defaults to false.",
      }),
    ),
    maxAgeHours: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  }),
);
