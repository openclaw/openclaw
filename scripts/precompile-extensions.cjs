#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const extDir = path.join(process.cwd(), "extensions");
if (!fs.existsSync(extDir)) {
  console.log("No extensions directory — skipping pre-compilation.");
  process.exit(0);
}

let esbuild;
try { esbuild = require("esbuild"); } catch { console.error("esbuild not found — skipping"); process.exit(1); }

for (const ext of fs.readdirSync(extDir)) {
  const extPath = path.join(extDir, ext);
  const pkgPath = path.join(extPath, "package.json");
  if (!fs.existsSync(pkgPath)) continue;

  const srcDir = path.join(extPath, "src");
  const tsFiles = [];

  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      if (f.isDirectory()) walk(full);
      else if (f.name.endsWith(".ts") && !f.name.endsWith(".d.ts")) tsFiles.push(full);
    }
  };

  if (fs.existsSync(srcDir)) walk(srcDir);
  const indexTs = path.join(extPath, "index.ts");
  if (fs.existsSync(indexTs)) tsFiles.push(indexTs);
  if (tsFiles.length === 0) continue;

  try {
    esbuild.buildSync({
      entryPoints: tsFiles,
      outdir: ".",
      outbase: ".",
      format: "esm",
      platform: "node",
      allowOverwrite: true,
      logLevel: "warning",
    });

    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    if (pkg.openclaw?.extensions) {
      pkg.openclaw.extensions = pkg.openclaw.extensions.map((e) =>
        e.replace(/\.ts$/, ".js"),
      );
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    }
    console.log("Pre-compiled: " + ext + " (" + tsFiles.length + " files)");
  } catch (e) {
    console.warn("Pre-compile skipped: " + ext + " — " + e.message);
  }
}
