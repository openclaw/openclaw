import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { controlUiLocaleModulesPlugin } from "../../../../ui/config/control-ui-locales.ts";
import { controlUiSolidPlugin } from "../../../../ui/config/control-ui-solid.ts";
import {
  resolveExternalPackageAliasesForVite,
  resolveSourcePackageAliasesForVite,
  resolveTsconfigPathAliasesForVite,
} from "../../../../ui/vite.config.ts";

const root = path.dirname(fileURLToPath(import.meta.url));
const requireUi = createRequire(new URL("../../../../ui/package.json", import.meta.url));

export default defineConfig({
  root,
  base: "/fixture/",
  publicDir: false,
  plugins: [controlUiSolidPlugin(), controlUiLocaleModulesPlugin()],
  resolve: {
    alias: [
      {
        find: /^solid-js$/u,
        replacement: path.join(path.dirname(requireUi.resolve("solid-js")), "solid.js"),
      },
      {
        find: /^@solidjs\/web$/u,
        replacement: path.join(path.dirname(requireUi.resolve("@solidjs/web")), "web.js"),
      },
      ...resolveExternalPackageAliasesForVite(),
      ...resolveSourcePackageAliasesForVite(),
      ...resolveTsconfigPathAliasesForVite(),
    ],
  },
  build: {
    outDir: path.join(root, "dist"),
    emptyOutDir: true,
    target: "es2022",
    rolldownOptions: { input: path.join(root, "onboarding-card.html") },
  },
});
