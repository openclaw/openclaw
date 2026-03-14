import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RegisteredCustomThemes, ResolvedThemes, ResolvingThemes } from "@pierre/diffs";

let pierreThemesRegistration: Promise<void> | null = null;

async function loadPierreTheme(themeFileName: string, themeName: string): Promise<unknown> {
  const diffsPackageRoot = await fs.realpath(
    fileURLToPath(new URL("../node_modules/@pierre/diffs", import.meta.url)),
  );
  const themePath = path.join(diffsPackageRoot, "..", "theme", "themes", themeFileName);
  return {
    ...(JSON.parse(await fs.readFile(themePath, "utf8")) as Record<string, unknown>),
    name: themeName,
  };
}

export async function ensurePierreThemesRegistered(): Promise<void> {
  pierreThemesRegistration ??= Promise.resolve().then(() => {
    RegisteredCustomThemes.set("pierre-light", () =>
      loadPierreTheme("pierre-light.json", "pierre-light"),
    );
    RegisteredCustomThemes.set("pierre-dark", () =>
      loadPierreTheme("pierre-dark.json", "pierre-dark"),
    );
    ResolvedThemes.delete("pierre-light");
    ResolvedThemes.delete("pierre-dark");
    ResolvingThemes.delete("pierre-light");
    ResolvingThemes.delete("pierre-dark");
  });
  await pierreThemesRegistration;
}
