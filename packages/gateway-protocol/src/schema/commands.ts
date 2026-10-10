import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/**
 * Command catalog protocol schemas.
 *
 * Command entries describe native, skill, and plugin commands that clients can
 * render or route; limits keep command catalogs bounded for UI and transport.
 */
export const COMMAND_NAME_MAX_LENGTH = 200;
export const COMMAND_DESCRIPTION_MAX_LENGTH = 2_000;
export const COMMAND_ALIAS_MAX_ITEMS = 20;
export const COMMAND_ARGS_MAX_ITEMS = 20;
export const COMMAND_ARG_NAME_MAX_LENGTH = 200;
export const COMMAND_ARG_DESCRIPTION_MAX_LENGTH = 500;
export const COMMAND_ARG_CHOICES_MAX_ITEMS = 50;
export const COMMAND_CHOICE_VALUE_MAX_LENGTH = 200;
export const COMMAND_CHOICE_LABEL_MAX_LENGTH = 200;
export const COMMAND_LIST_MAX_ITEMS = 500;

const BoundedNonEmptyString = (maxLength: number) => Type.String({ minLength: 1, maxLength });

const CommandSourceSchema = Type.Union([
  Type.Literal("native"),
  Type.Literal("skill"),
  Type.Literal("plugin"),
]);

const CommandScopeSchema = Type.Union([
  Type.Literal("text"),
  Type.Literal("native"),
  Type.Literal("both"),
]);

const CommandCategorySchema = Type.Union([
  Type.Literal("session"),
  Type.Literal("options"),
  Type.Literal("status"),
  Type.Literal("management"),
  Type.Literal("media"),
  Type.Literal("tools"),
]);

const CommandArgChoiceSchema = closedObject({
  value: Type.String({ maxLength: COMMAND_CHOICE_VALUE_MAX_LENGTH }),
  label: Type.String({ maxLength: COMMAND_CHOICE_LABEL_MAX_LENGTH }),
});

const CommandArgSchema = closedObject({
  name: BoundedNonEmptyString(COMMAND_ARG_NAME_MAX_LENGTH),
  description: Type.String({ maxLength: COMMAND_ARG_DESCRIPTION_MAX_LENGTH }),
  type: Type.Union([Type.Literal("string"), Type.Literal("number"), Type.Literal("boolean")]),
  required: Type.Optional(Type.Boolean()),
  choices: Type.Optional(
    Type.Array(CommandArgChoiceSchema, { maxItems: COMMAND_ARG_CHOICES_MAX_ITEMS }),
  ),
  dynamic: Type.Optional(Type.Boolean()),
});

const CommandClientPresentationActionSchema = Type.Union([
  closedObject({ kind: Type.Literal("device-pairing") }),
]);

const CommandClientPresentationSchema = closedObject({
  when: Type.Literal("no-arguments"),
  action: CommandClientPresentationActionSchema,
});

export const CommandEntrySchema = closedObject({
  name: BoundedNonEmptyString(COMMAND_NAME_MAX_LENGTH),
  nativeName: Type.Optional(BoundedNonEmptyString(COMMAND_NAME_MAX_LENGTH)),
  textAliases: Type.Optional(
    Type.Array(BoundedNonEmptyString(COMMAND_NAME_MAX_LENGTH), {
      maxItems: COMMAND_ALIAS_MAX_ITEMS,
    }),
  ),
  description: Type.String({ maxLength: COMMAND_DESCRIPTION_MAX_LENGTH }),
  category: Type.Optional(CommandCategorySchema),
  source: CommandSourceSchema,
  /** Human-readable skill title used by client display surfaces. */
  skillDisplayName: Type.Optional(BoundedNonEmptyString(COMMAND_NAME_MAX_LENGTH)),
  /** Whether a skill command is also present in the model-visible skill catalog. */
  skillModelVisible: Type.Optional(Type.Boolean()),
  scope: CommandScopeSchema,
  acceptsArgs: Type.Boolean(),
  args: Type.Optional(Type.Array(CommandArgSchema, { maxItems: COMMAND_ARGS_MAX_ITEMS })),
  clientPresentation: Type.Optional(CommandClientPresentationSchema),
});

export const CommandsListParamsSchema = closedObject({
  sessionKey: Type.Optional(NonEmptyString),
  agentId: Type.Optional(NonEmptyString),
  provider: Type.Optional(NonEmptyString),
  scope: Type.Optional(CommandScopeSchema),
  includeArgs: Type.Optional(Type.Boolean()),
});

export const CommandsListResultSchema = closedObject({
  commands: Type.Array(CommandEntrySchema, { maxItems: COMMAND_LIST_MAX_ITEMS }),
});

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type CommandEntry = Static<typeof CommandEntrySchema>;
export type CommandsListParams = Static<typeof CommandsListParamsSchema>;
export type CommandsListResult = Static<typeof CommandsListResultSchema>;
