import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Audited npm artifacts: runtime exports use compiled JS. Mistral's optional
// "source" condition is not enabled by the desktop runtime. Re-audit on upgrades.
const developmentFiles = {
  openai: { versions: ["7.28.0"], sources: ["src"], trees: [] },
  zod: { versions: ["4.6.5"], sources: ["src"], trees: [] },
  "@anthropic-ai/sdk": { versions: ["0.131.0"], sources: ["src"], trees: [] },
  "@mistralai/mistralai": {
    versions: ["2.7.0"],
    sources: ["src"],
    trees: [
      "tests",
      "examples",
      "packages/mistralai-azure/examples",
      "packages/mistralai-gcp/examples",
    ],
  },
  pino: { versions: ["9.14.0"], sources: [], trees: ["test", "examples", "benchmarks"] },
  "pino-std-serializers": { versions: ["7.1.0"], sources: [], trees: ["test"] },
  "sonic-boom": { versions: ["4.2.1"], sources: [], trees: ["test"] },
  "process-warning": {
    versions: ["5.1.0"],
    sources: [],
    trees: ["test", "examples", "benchmarks"],
  },
  "quick-format-unescaped": { versions: ["4.0.4"], sources: [], trees: ["test"] },
  reusify: { versions: ["1.1.0"], sources: [], trees: ["benchmarks"] },
  retry: { versions: ["0.13.1"], sources: [], trees: ["example"] },
};

/** Trim only a private installed node_modules tree, before sealing or hashing. */
export function pruneDesktopRuntime(modules) {
  let files = 0;
  let bytes = 0;
  const within = (relative, trees) => trees.some((tree) => relative.startsWith(`${tree}/`));
  const packages = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === ".bin") {
        continue;
      }
      const child = path.join(directory, entry.name);
      if (entry.name.startsWith("@")) {
        packages(child);
      } else {
        visit(child, child);
      }
    }
  };
  const visit = (directory, packageRoot, inheritedRules) => {
    let rules = inheritedRules;
    if (directory === packageRoot) {
      const manifest = path.join(packageRoot, "package.json");
      if (fs.existsSync(manifest)) {
        const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
        const candidate = Object.hasOwn(developmentFiles, pkg.name)
          ? developmentFiles[pkg.name]
          : undefined;
        rules = candidate?.versions.includes(pkg.version) ? candidate : undefined;
      }
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(packageRoot, file).split(path.sep).join("/");
      // Plugins own their assets, including sources and examples used as data.
      if (relative === "extensions" || relative === "dist/extensions") {
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") {
          packages(file);
        } else {
          visit(file, packageRoot, rules);
        }
        if (fs.readdirSync(file).length === 0) {
          fs.rmdirSync(file);
        }
      } else if (entry.isFile()) {
        if (
          /\.md$/i.test(entry.name) ||
          entry.name === "package.json" ||
          /^(?:(?:un)?licen[cs]e|notice|copying|copyright|authors)(?:[.-]|$)/i.test(entry.name)
        ) {
          continue;
        }
        // Preserve executable maps for diagnostics/debuggers. Declaration maps
        // have no runtime consumer; JS, native code and other assets stay intact.
        const declaration = /\.d\.(?:ts|mts|cts)(?:\.map)?$/.test(entry.name);
        const development =
          rules &&
          (within(relative, rules.trees) ||
            (within(relative, rules.sources) && /\.(?:ts|mts|cts)$/.test(entry.name)));
        if (declaration || development) {
          bytes += fs.statSync(file).size;
          fs.unlinkSync(file);
          files++;
        }
      }
    }
  };
  packages(modules);
  console.error(`Trimmed desktop runtime: ${files} development files, ${bytes} bytes`);
  return { files, bytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  pruneDesktopRuntime(process.argv[2]);
}
