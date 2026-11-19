// One content-input owner for UI cache reuse and source-revision comparisons.
import fs from "node:fs";
import path from "node:path";
import { hashInputFiles, listCacheFiles, type BuildCacheEntry } from "./build-artifact-cache.mts";
import { isRecord, trimString } from "./record-shared.mjs";

export async function createControlUiBuildInputs(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  args: string[],
) {
  const sourcePluginInventory =
    env.OPENCLAW_CONTROL_UI_REQUIRE_PLUGIN_DISTRIBUTIONS === "1"
      ? (await import("./bundled-plugin-build-entries.mjs"))
          .collectSourceCheckoutPluginBuildEntries({
            cwd: repoRoot,
            // Private runtime plugins do not change UI discovery. Keep the full
            // source inventory in both flavors so new UI declarations invalidate reuse.
            env: { ...env, OPENCLAW_BUILD_PRIVATE_QA: "1" },
          })
          .map(({ id, isolated, packageJson }) => {
            const openclaw =
              isRecord(packageJson) && isRecord(packageJson.openclaw)
                ? packageJson.openclaw
                : undefined;
            return [id, isolated, openclaw?.controlUi];
          })
      : undefined;
  const paths: BuildCacheEntry[] = [
    { path: "ui", excludeDirectories: ["node_modules"] },
    { path: "packages", excludeDirectories: ["node_modules", "dist", ".artifacts"] },
    ...fs
      .readdirSync(path.join(repoRoot, "scripts/lib"))
      .filter((file) => file.startsWith("control-ui-i18n"))
      .map((file) => `scripts/lib/${file}`),
    "scripts/ui.js",
    "scripts/ui.mts",
    "scripts/pnpm-runner.mts",
    "scripts/run-node-package-bin.mts",
    "scripts/lib/build-artifact-cache.mts",
    "scripts/lib/control-ui-build-inputs.mts",
    "scripts/lib/output-root-guard.mjs",
    "scripts/lib/build-identity.mts",
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    // Poster generation reads bundled fonts outside the UI source tree.
    "src/gateway/assets/session-card/Lato-Regular.ttf",
    "src/gateway/assets/session-card/InstrumentSerif-Regular.ttf",
    // Package metadata discovers new generations; all copied files (including
    // deferred chunks absent from Vite's module graph) invalidate reuse.
    ...(() => {
      const root = path.join(repoRoot, "dist/extensions");
      if (!fs.existsSync(root)) {
        return [];
      }
      return fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => {
          const relative = `dist/extensions/${entry.name}`;
          const manifestPath = path.join(repoRoot, relative, "openclaw.plugin.json");
          if (!fs.existsSync(manifestPath)) {
            return [];
          }
          const manifest: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
          if (!isRecord(manifest) || !trimString(manifest.id)) {
            throw new Error(
              `Invalid packaged plugin manifest for ${entry.name}: missing plugin id`,
            );
          }
          // The distribution plugin consumes only declared native UI assets.
          // Keep malformed declarations in the key so Vite still rejects them.
          if (manifest.controlUi === undefined) {
            return [];
          }
          return [
            `${relative}/package.json`,
            `${relative}/openclaw.plugin.json`,
            `${relative}/dist/control-ui`,
          ];
        });
    })(),
  ];
  const staticInputs = listCacheFiles(repoRoot, paths, fs);
  const testInputs = new Set(
    staticInputs.filter((file) =>
      /^ui\/src\/.*\.test\.tsx?$/u.test(path.relative(repoRoot, file).replaceAll(path.sep, "/")),
    ),
  );
  const inputSignature = (inputs: string[]) =>
    hashInputFiles(
      repoRoot,
      [
        ...new Set([
          ...staticInputs.filter((file) => !testInputs.has(file)),
          ...inputs.map((file) => path.join(repoRoot, file)),
        ]),
      ].toSorted(),
      fs,
      [
        "NODE_ENV",
        "OPENCLAW_CONTROL_UI_BASE_PATH",
        "OPENCLAW_CONTROL_UI_RELEASE_BUILD",
        "OPENCLAW_CONTROL_UI_REQUIRE_PLUGIN_DISTRIBUTIONS",
      ],
      env,
      JSON.stringify({
        args,
        platform: process.platform,
        arch: process.arch,
        sourcePluginInventory,
        // New glob matches must miss; existing tests matter only if Vite consumed them.
        testInputPaths: [...testInputs].map((file) => path.relative(repoRoot, file)),
      }),
    );
  return { paths, inputSignature };
}
