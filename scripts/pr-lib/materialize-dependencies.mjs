import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";

const manifestPath = join(dirname(process.argv[3]), "package.json");
const manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : undefined;
// Pre-#149585 anchors contain no package manifest and need only these tooling pins.
const dependencies = [
  "tsx",
  "zod",
  "minimatch",
  "yaml",
  ...(manifest
    ? [
        "@openclaw/fs-safe",
        "@openclaw/proxyline",
        "acorn",
        "chalk",
        "commander",
        "dotenv",
        "execa",
        "hosted-git-info",
        "import-meta-resolve",
        "ipaddr.js",
        "jiti",
        "json5",
        "koffi",
        "kysely",
        "ms",
        "p-map",
        "semver",
        "string-width",
        "tsdown",
        "tslog",
        "typebox",
        "typescript",
        "undici",
      ]
    : []),
].map((dependency) => {
  const link = join(process.argv[3], dependency);
  // An older parent or the current supervisor may already have pinned this package.
  // Preserve that installation even if canonical aliases change during the run.
  const present = lstatSync(link, { throwIfNoEntry: false });
  const installedPath = present ? link : join(process.argv[2], dependency);
  try {
    const target = realpathSync(installedPath);
    if (!statSync(target).isDirectory()) {
      throw new Error("not a package directory");
    }
    const expectedVersion =
      manifest?.dependencies?.[dependency] ?? manifest?.devDependencies?.[dependency];
    const installedVersion = JSON.parse(readFileSync(join(target, "package.json"), "utf8")).version;
    if (manifest && (!expectedVersion || installedVersion !== expectedVersion)) {
      console.error(
        `Installed scripts/pr dependency '${dependency}' has version ${installedVersion}; the trust anchor requires ${expectedVersion}.`,
      );
      throw new Error("dependency version mismatch");
    }
    return { dependency, target, present };
  } catch {
    console.error(
      `Cannot resolve installed scripts/pr dependency '${dependency}' at ${installedPath}.`,
    );
    console.error(
      "Restore frozen dependencies in a clean trusted-main checkout before retrying; no dependencies were installed.",
    );
    return process.exit(1);
  }
});
mkdirSync(process.argv[3], { recursive: true });
for (const { dependency, target, present } of dependencies) {
  if (present) {
    continue;
  }
  // Native junctions avoid Git Bash copying package directories on Windows.
  const link = join(process.argv[3], dependency);
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}
