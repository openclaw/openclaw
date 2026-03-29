// src/build.ts
import { writeFileSync, mkdirSync } from "node:fs";
import { light as rolesLight, dark as rolesDark } from "./palette";
import { makeTheme } from "./theme";
import { makeZedThemeFamily } from "./zed-theme";
import { convertRolesToP3 } from "./color-p3";

mkdirSync("themes", { recursive: true });
mkdirSync("zed/themes", { recursive: true });

// Convert palettes to Display P3 color space
const rolesLightP3 = convertRolesToP3(rolesLight);
const rolesDarkP3 = convertRolesToP3(rolesDark);

// ============================================
// VS Code Themes
// ============================================
const vscodeThemes = [
  { file: "themes/pierre-light.json", theme: makeTheme("Pierre Light", "light", rolesLight) },
  { file: "themes/pierre-dark.json",  theme: makeTheme("Pierre Dark",  "dark",  rolesDark)  },
  { file: "themes/pierre-light-vibrant.json", theme: makeTheme("Pierre Light Vibrant", "light", rolesLightP3) },
  { file: "themes/pierre-dark-vibrant.json",  theme: makeTheme("Pierre Dark Vibrant",  "dark",  rolesDarkP3)  }
];

for (const {file, theme} of vscodeThemes) {
  writeFileSync(file, JSON.stringify(theme, null, 2), "utf8");
  console.log("Wrote", file);
}

// ============================================
// Zed Theme Family
// ============================================
const zedTheme = makeZedThemeFamily("Pierre", "pierrecomputer", [
  { name: "Pierre Light", appearance: "light", roles: rolesLight },
  { name: "Pierre Dark", appearance: "dark", roles: rolesDark },
]);

writeFileSync("zed/themes/pierre.json", JSON.stringify(zedTheme, null, 2), "utf8");
console.log("Wrote zed/themes/pierre.json");
