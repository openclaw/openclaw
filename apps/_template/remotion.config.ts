import path from "path";
import fs from "fs";
import type { WebpackConfiguration } from "remotion";
import { Config } from "@remotion/cli/config";

Config.overrideWebpackConfig((currentConfiguration) => {
  const config: WebpackConfiguration =
    currentConfiguration as WebpackConfiguration;
  const alias = (config.resolve?.alias ?? {}) as Record<string, string>;
  try {
    // Avoid import.meta/__dirname warnings by using process.cwd()
    const packagesDir = path.resolve(process.cwd(), "../../packages");
    const entries: Record<string, string> = {};
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const pkgJson = path.join(full, "package.json");
          const srcPath = path.join(full, "src");
          if (fs.existsSync(pkgJson) && fs.existsSync(srcPath)) {
            try {
              const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf8"));
              if (pkg.name) entries[pkg.name] = srcPath;
            } catch {}
          }
          walk(full);
        }
      }
    };
    walk(packagesDir);
    config.resolve = config.resolve ?? {};
    config.resolve.alias = { ...alias, ...entries };
  } catch {}
  return config;
});
