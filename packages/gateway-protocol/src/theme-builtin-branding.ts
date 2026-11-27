import type { ThemeId } from "./theme-ids.js";
import type { ThemeBranding, ThemeCritterId, ThemeDescriptor } from "./theme.js";

const DEFAULT_THEME_CRITTERS: readonly ThemeCritterId[] = [];

export function resolveThemeBranding(
  source:
    | Pick<
        ThemeDescriptor,
        | "mascot"
        | "brandName"
        | "brandIcon"
        | "workingIndicator"
        | "lobsterdex"
        | "communityLinks"
        | "workingPhrases"
        | "critters"
        | "avatarHat"
        | "artwork"
      >
    | undefined,
): ThemeBranding {
  const mascot = source?.mascot ?? "claw";
  return {
    mascot,
    brandName: source?.brandName ?? "OpenClaw",
    brandIcon: source?.brandIcon ?? (mascot === "claw" ? "claw" : "mark"),
    workingIndicator: source?.workingIndicator ?? (mascot === "claw" ? "claw" : "dots"),
    lobsterdex: source?.lobsterdex ?? true,
    communityLinks: source?.communityLinks ?? true,
    workingPhrases: source?.workingPhrases,
    critters: source?.critters ?? DEFAULT_THEME_CRITTERS,
    avatarHat: source?.avatarHat,
    ...(source?.artwork ? { artwork: source.artwork } : {}),
  };
}

// Boot needs only the branding exceptions, not the catalog names and descriptions.
export function builtinThemeBrandingOverrides(theme: ThemeId | "custom") {
  if (theme === "phosphor" || theme === "crt") {
    return {
      mascot: "none",
      brandIcon: "mark",
      workingIndicator: "dots",
      lobsterdex: false,
    } as const;
  }
  return undefined;
}
