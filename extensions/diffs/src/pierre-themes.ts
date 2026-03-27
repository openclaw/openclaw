import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { RegisteredCustomThemes, ResolvedThemes, ResolvingThemes } from "@pierre/diffs";

type RegisteredThemeLoader = NonNullable<ReturnType<typeof RegisteredCustomThemes.get>>;
type RegisteredTheme = Awaited<ReturnType<RegisteredThemeLoader>>;
const require = createRequire(import.meta.url);

async function loadPierreTheme(
  themeSpecifier: string,
  themeName: string,
): Promise<RegisteredTheme> {
  const themePath = require.resolve(themeSpecifier);
  return {
    ...(JSON.parse(await fs.readFile(themePath, "utf8")) as Record<string, unknown>),
    name: themeName,
  };
}

export async function ensurePierreThemesRegistered(): Promise<void> {
  // Always overwrite the upstream loaders so the Node-safe path wins even if
  // @pierre/diffs registered its JSON-import loaders earlier in this process.
  RegisteredCustomThemes.set("pierre-light", () =>
    loadPierreTheme("@pierre/theme/themes/pierre-light.json", "pierre-light"),
  );
  RegisteredCustomThemes.set("pierre-dark", () =>
    loadPierreTheme("@pierre/theme/themes/pierre-dark.json", "pierre-dark"),
  );
  ResolvedThemes.delete("pierre-light");
  ResolvedThemes.delete("pierre-dark");
  ResolvingThemes.delete("pierre-light");
  ResolvingThemes.delete("pierre-dark");
}
