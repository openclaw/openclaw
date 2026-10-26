import type { Static } from "typebox";
import { Type } from "typebox";
import type { ThemeArtwork, ThemeDefinition, ThemeDescriptor, ThemeMode } from "../theme.js";
import {
  THEME_LOCAL_ID_MAX_LENGTH,
  THEME_ARTWORK_ID_PATTERN,
  THEME_NAME_MAX_LENGTH,
  THEME_BRAND_NAME_MAX_LENGTH,
  THEME_DESCRIPTION_MAX_LENGTH,
  THEME_TOKEN_MAX_LENGTH,
  THEME_WORKING_PHRASES_MAX,
  THEME_WORKING_PHRASE_MAX_LENGTH,
} from "../theme.js";
import { closedObject } from "./closed-object.js";
import { stringLiteralUnion } from "./string-literal-union.js";

const ThemeValue = Type.String({ minLength: 1, maxLength: THEME_TOKEN_MAX_LENGTH });
const ThemeArtworkId = Type.String({ pattern: THEME_ARTWORK_ID_PATTERN.source, maxLength: 32 });
export const ThemePaletteSchema = closedObject({
  background: ThemeValue,
  foreground: ThemeValue,
  card: ThemeValue,
  "card-foreground": ThemeValue,
  popover: ThemeValue,
  "popover-foreground": ThemeValue,
  primary: ThemeValue,
  "primary-foreground": ThemeValue,
  secondary: ThemeValue,
  "secondary-foreground": ThemeValue,
  muted: ThemeValue,
  "muted-foreground": ThemeValue,
  accent: ThemeValue,
  "accent-foreground": ThemeValue,
  destructive: ThemeValue,
  "destructive-foreground": ThemeValue,
  border: ThemeValue,
  input: ThemeValue,
  ring: ThemeValue,
  "font-sans": Type.Optional(ThemeValue),
  "font-mono": Type.Optional(ThemeValue),
});
export const ThemeDefinitionSchema = closedObject({
  name: Type.String({ minLength: 1, maxLength: THEME_NAME_MAX_LENGTH }),
  description: Type.String({ minLength: 1, maxLength: THEME_DESCRIPTION_MAX_LENGTH }),
  mascot: Type.Optional(stringLiteralUnion(["claw", "none"])),
  brandName: Type.Optional(Type.String({ minLength: 1, maxLength: THEME_BRAND_NAME_MAX_LENGTH })),
  brandIcon: Type.Optional(ThemeArtworkId),
  workingIndicator: Type.Optional(stringLiteralUnion(["claw", "dots", "brand", "none"])),
  lobsterdex: Type.Optional(Type.Boolean()),
  communityLinks: Type.Optional(Type.Boolean()),
  workingPhrases: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: THEME_WORKING_PHRASE_MAX_LENGTH }), {
      maxItems: THEME_WORKING_PHRASES_MAX,
    }),
  ),
  critters: Type.Optional(Type.Array(ThemeArtworkId, { maxItems: 8 })),
  avatarHat: Type.Optional(ThemeArtworkId),
  light: Type.Optional(ThemePaletteSchema),
  dark: Type.Optional(ThemePaletteSchema),
});
export const ThemeModeSchema = stringLiteralUnion(["system", "light", "dark"]);
const ThemeId = Type.String({ minLength: 1, maxLength: 256 });
export const ThemesListParamsSchema = closedObject({});
export const ThemesGetParamsSchema = closedObject({ id: Type.Optional(ThemeId) });
export const ThemesSetParamsSchema = closedObject({
  id: Type.Optional(Type.Union([ThemeId, Type.Null()])),
  mode: Type.Optional(Type.Union([ThemeModeSchema, Type.Null()])),
  appearance: Type.Optional(
    closedObject({
      accent: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      fontUi: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      fontChat: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    }),
  ),
});
export const ThemesImportParamsSchema = closedObject({
  id: Type.String({
    minLength: 1,
    maxLength: THEME_LOCAL_ID_MAX_LENGTH,
    pattern: "^[a-z0-9][a-z0-9_-]*$",
  }),
  definition: ThemeDefinitionSchema,
  apply: Type.Optional(Type.Boolean()),
  mode: Type.Optional(ThemeModeSchema),
});

export const CLAWHUB_THEME_PAGE_SIZE = 24;
export const CLAWHUB_THEME_MAX_PAGE_SIZE = 48;
const RegistryThemeId = Type.String({
  maxLength: 105,
  pattern: "^[a-z0-9](?:[a-z0-9._-]{0,38}[a-z0-9])?/[a-z0-9][a-z0-9_-]{0,63}$",
});
const RegistryThemeVersion = Type.String({
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-zA-Z0-9][a-zA-Z0-9._+-]*$",
});
const RegistryThemeCursor = Type.String({ minLength: 1, maxLength: 4096 });
export const ThemesBrowseParamsSchema = closedObject({
  query: Type.Optional(Type.String({ maxLength: 200 })),
  cursor: Type.Optional(RegistryThemeCursor),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: CLAWHUB_THEME_MAX_PAGE_SIZE })),
});
export const ThemesInstallParamsSchema = closedObject({
  id: RegistryThemeId,
  version: RegistryThemeVersion,
});
export const ThemesRemoveParamsSchema = closedObject({
  id: Type.String({ maxLength: 69, pattern: "^user/[a-z0-9][a-z0-9_-]{0,63}$" }),
});
export const ThemeSummarySchema = closedObject({
  id: RegistryThemeId,
  name: Type.String({ minLength: 1, maxLength: THEME_NAME_MAX_LENGTH }),
  description: Type.String({ minLength: 1, maxLength: THEME_DESCRIPTION_MAX_LENGTH }),
  version: RegistryThemeVersion,
  category: Type.Literal("themes"),
  author: closedObject({ handle: Type.String({ minLength: 1, maxLength: 64 }) }),
  updatedAt: Type.Integer({ minimum: 0 }),
});
export const ThemesBrowseResultSchema = closedObject({
  items: Type.Array(ThemeSummarySchema, { maxItems: CLAWHUB_THEME_MAX_PAGE_SIZE }),
  nextCursor: Type.Union([RegistryThemeCursor, Type.Null()]),
});
export const ThemeReleaseSchema = closedObject({
  ...ThemeSummarySchema.properties,
  definition: ThemeDefinitionSchema,
  sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
});
export const ThemeReleaseResultSchema = closedObject({ item: ThemeReleaseSchema });

export type ThemesBrowseParams = Static<typeof ThemesBrowseParamsSchema>;
export type ThemesInstallParams = Static<typeof ThemesInstallParamsSchema>;
export type ThemesRemoveParams = Static<typeof ThemesRemoveParamsSchema>;
export type ThemeSummary = Static<typeof ThemeSummarySchema>;
export type ThemeRelease = Static<typeof ThemeReleaseSchema>;
export type ThemesBrowseResult = Static<typeof ThemesBrowseResultSchema>;

export type ThemesListParams = Static<typeof ThemesListParamsSchema>;
export type ThemesGetParams = Static<typeof ThemesGetParamsSchema>;
export type ThemesSetParams = Static<typeof ThemesSetParamsSchema>;
export type ThemesImportParams = Static<typeof ThemesImportParamsSchema>;
export type ThemeSelection = {
  id: string;
  mode: ThemeMode;
  effectiveMode?: "light" | "dark";
  scope: "profile" | "gateway";
  overrides: { id?: string; mode?: ThemeMode };
  requestedId?: string;
};
export type ThemesGetResult = {
  current: ThemeSelection;
  theme: ThemeDescriptor;
  definition?: ThemeDefinition;
  artwork?: ThemeArtwork;
};
export type ThemesListResult = ThemesGetResult & { themes: ThemeDescriptor[] };
export type ThemesMutationResult = ThemesGetResult & { application: "saved" };
