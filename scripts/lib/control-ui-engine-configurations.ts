import {
  BUILTIN_THEME_IDS,
  isBuiltinThemeId,
  type BuiltinThemeId,
} from "../../packages/gateway-protocol/src/theme-ids.ts";
import { isSupportedLocale, type Locale } from "../../src/shared/control-ui-locale.ts";

export type EngineConfiguration = {
  name: string;
  theme: BuiltinThemeId;
  themeMode: "light" | "dark";
  locale: Locale;
  deviceScaleFactor: number;
  colorScheme: "light" | "dark";
  reducedMotion: "no-preference" | "reduce";
  forcedColors: "none" | "active";
  accessibility: "default" | "on" | "off";
};

const defaults: Omit<EngineConfiguration, "name"> = {
  theme: "claw",
  themeMode: "light",
  locale: "en",
  deviceScaleFactor: 1,
  colorScheme: "light",
  reducedMotion: "no-preference",
  forcedColors: "none",
  accessibility: "default",
};

function resolveConfiguration(name: string): EngineConfiguration {
  const configuration: EngineConfiguration = { name, ...defaults };
  if (name === "default" || name === "control") {
    return configuration;
  }
  if (name === "reduced-motion") {
    return { ...configuration, reducedMotion: "reduce" };
  }
  if (name === "forced-colors") {
    return { ...configuration, forcedColors: "active" };
  }
  if (name === "accessibility" || name === "accessibility-control") {
    return { ...configuration, accessibility: "on" };
  }
  if (name === "accessibility-off" || name === "accessibility-off-control") {
    return { ...configuration, accessibility: "off" };
  }
  const parts = name.split(":");
  const [axis, value, mode] = parts;
  if (axis === "theme" && isBuiltinThemeId(value) && parts.length === 3) {
    if (mode === "light" || mode === "dark") {
      return { ...configuration, theme: value, themeMode: mode, colorScheme: mode };
    }
  }
  if (axis === "locale" && isSupportedLocale(value) && parts.length === 2) {
    return { ...configuration, locale: value };
  }
  if (axis === "scale" && (value === "2" || value === "3") && parts.length === 2) {
    return { ...configuration, deviceScaleFactor: Number(value) };
  }
  throw new Error(`Unsupported engine configuration: ${name}`);
}

/** Expand one-axis presets; names remain distinct for interleaved A/A controls. */
export function resolveEngineConfigurations(selection: string): EngineConfiguration[] {
  const names = selection.split(",").flatMap((entry) => {
    const name = entry.trim();
    return name === "all"
      ? ["default"].concat(
          BUILTIN_THEME_IDS.filter((theme) => theme !== "claw").map(
            (theme) => `theme:${theme}:light`,
          ),
          BUILTIN_THEME_IDS.map((theme) => `theme:${theme}:dark`),
          [
            "locale:zh-CN",
            "locale:ar",
            "locale:de",
            "scale:2",
            "scale:3",
            "reduced-motion",
            "forced-colors",
          ],
        )
      : [name];
  });
  if (new Set(names).size !== names.length) {
    throw new Error("Use distinct engine configuration names");
  }
  return names.map(resolveConfiguration);
}
