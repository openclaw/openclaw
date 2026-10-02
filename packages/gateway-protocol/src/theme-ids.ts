/** Lightweight theme identifiers used while browser preferences boot. */
export const BUILTIN_THEME_IDS = [
  "claw",
  "knot",
  "dash",
  "absolutely",
  "tide",
  "beacon",
  "phosphor",
  "crt",
  "manuscript",
  "rose",
  "miami",
] as const;

export type BuiltinThemeId = (typeof BUILTIN_THEME_IDS)[number];
export type ThemeId = BuiltinThemeId | `${string}/${string}`;
export type ThemeMode = "system" | "light" | "dark";
export const THEME_LOCAL_ID_MAX_LENGTH = 64;
export const THEME_LOCAL_ID_PATTERN = new RegExp(
  `^[a-z0-9][a-z0-9_-]{0,${THEME_LOCAL_ID_MAX_LENGTH - 1}}$`,
);

export function isBuiltinThemeId(value: unknown): value is BuiltinThemeId {
  return BUILTIN_THEME_IDS.some((id) => id === value);
}

export function isThemeId(value: unknown): value is ThemeId {
  if (isBuiltinThemeId(value)) {
    return true;
  }
  if (typeof value !== "string" || value.length > 256) {
    return false;
  }
  const separator = value.lastIndexOf("/");
  const owner = value.slice(0, separator);
  return (
    separator > 0 &&
    !owner.startsWith("user/") &&
    /^@?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i.test(owner) &&
    THEME_LOCAL_ID_PATTERN.test(value.slice(separator + 1))
  );
}

export function normalizeThemeMode(value: unknown): ThemeMode | undefined {
  return value === "system" || value === "light" || value === "dark" ? value : undefined;
}
