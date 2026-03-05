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
    // Explicit alias to import components from sibling app `remotion3`
    try {
      const remotion3Src = path.resolve(process.cwd(), "../remotion3/src");
      if (fs.existsSync(remotion3Src)) {
        entries["@app/remotion3"] = remotion3Src;
      }
    } catch {}
    config.resolve = config.resolve ?? {};
    config.resolve.alias = { ...alias, ...entries };
  } catch {}
  return config;
});

// Ensure the correct entry point (file with registerRoot)
Config.setEntryPoint("./src/index.ts");

// Use ANGLE + EGL to improve WebGL context creation stability in headless
// See: https://www.remotion.dev/docs/three and https://www.remotion.dev/docs/chromium-flags#--gl
Config.setChromiumOpenGlRenderer("angle-egl");
// macOS / Apple Silicon 向けの追加フラグは CLI 側で渡してください
// 例: --chromium-flag=--enable-webgl --chromium-flag=--ignore-gpu-blocklist --chromium-flag=--use-angle=metal
