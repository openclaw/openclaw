import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";

const fixtures = createFixtureLifetime();
const metadataUrl = new URL("./package-metadata.ts", import.meta.url);

afterEach(() => fixtures.cleanup());

function writePackage(root: string, manifest: Record<string, unknown>) {
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "examples"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", ...manifest }));
  writeFileSync(join(root, "README.md"), "fixture readme");
  writeFileSync(join(root, "docs", "guide.md"), "fixture guide");
  writeFileSync(join(root, "examples", "example.txt"), "fixture example");
}

function expectedAssets(root: string) {
  return {
    paths: [join(root, "README.md"), join(root, "docs"), join(root, "examples")],
    contents: ["fixture readme", "fixture guide", "fixture example"],
  };
}

async function compileMetadata(outfile: string, workerVersion?: string) {
  await build({
    entryPoints: [fileURLToPath(metadataUrl)],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    tsconfig: fileURLToPath(new URL("../../tsconfig.json", import.meta.url)),
    logLevel: "silent",
    define:
      workerVersion === undefined
        ? undefined
        : { WORKER_DEPLOY_VERSION: JSON.stringify(workerVersion) },
  });
}

const snapshotScript = String.raw`
  import { readFileSync } from "node:fs";
  import { join } from "node:path";
  const metadata = await import(process.argv[1]);
  function snapshot() {
    const paths = [metadata.getReadmePath(), metadata.getDocsPath(), metadata.getExamplesPath()];
    return {
      appName: metadata.APP_NAME,
      configDir: metadata.CONFIG_DIR_NAME,
      version: metadata.PACKAGE_MANIFEST_VERSION,
      isBunBinary: metadata.isBunBinary,
      paths,
      contents: [
        readFileSync(paths[0], "utf8"),
        readFileSync(join(paths[1], "guide.md"), "utf8"),
        readFileSync(join(paths[2], "example.txt"), "utf8"),
      ],
    };
  }
`;

describe("package metadata", () => {
  it.each(["absolute", "relative", "~", "~/"] as const)(
    "captures custom metadata through a %s override while asset paths follow later overrides",
    (form) =>
      fixtures.run(async () => {
        const root = fixtures.createTempDir("openclaw-package-metadata-");
        const home = join(root, "home");
        const packageDir = form === "~" ? home : join(home, "package");
        const nextPackageDir = join(root, "replacement");
        writePackage(packageDir, {
          name: "@fixture/package-name",
          version: "7.8.9-custom",
          openclawConfig: { name: "fixture-claw", configDir: ".fixture-claw" },
        });
        writePackage(nextPackageDir, {
          version: "8.0.0",
          openclawConfig: { name: "replacement", configDir: ".replacement" },
        });
        const overrides = {
          absolute: packageDir,
          relative: relative(root, packageDir),
          "~": "~",
          "~/": "~/package",
        };
        const entry = join(root, "package-metadata.mjs");
        await compileMetadata(entry);
        const result = await fixtures.track(
          runNodeScript(
            [
              "--input-type=module",
              "--eval",
              `${snapshotScript}
                const before = snapshot();
                process.env.OPENCLAW_PACKAGE_DIR = process.argv[2];
                console.log(JSON.stringify({ before, after: snapshot() }));
              `,
              pathToFileURL(entry).href,
              nextPackageDir,
            ],
            {
              ...process.env,
              HOME: home,
              USERPROFILE: home,
              OPENCLAW_PACKAGE_DIR: overrides[form],
            },
            10_000,
            { cwd: root, requireProcessTreeExit: true },
          ),
        );

        expect(result, result.stderr).toMatchObject({ error: undefined, status: 0 });
        const captured = {
          appName: "fixture-claw",
          configDir: ".fixture-claw",
          version: "7.8.9-custom",
          isBunBinary: false,
        };
        expect(JSON.parse(result.stdout)).toEqual({
          before: { ...captured, ...expectedAssets(packageDir) },
          after: { ...captured, ...expectedAssets(nextPackageDir) },
        });
      }),
  );

  it.each(["src/agents", "dist"])(
    "uses the nearest package manifest and assets when emitted under %s",
    (layout) =>
      fixtures.run(async () => {
        const root = fixtures.createTempDir("openclaw-package-layout-");
        writePackage(root, {
          version: "99.0.0",
          openclawConfig: { name: "outer-package", configDir: ".outer-package" },
        });
        const packageDir = join(root, "installed-package");
        writePackage(packageDir, { name: "@fixture/repackaged" });
        const entry = join(packageDir, layout, "package-metadata.mjs");
        await compileMetadata(entry);
        const result = await fixtures.track(
          runNodeScript(
            [
              "--input-type=module",
              "--eval",
              `${snapshotScript}\nconsole.log(JSON.stringify(snapshot()));`,
              pathToFileURL(entry).href,
            ],
            { ...process.env, OPENCLAW_PACKAGE_DIR: undefined },
            10_000,
            { cwd: root, requireProcessTreeExit: true },
          ),
        );

        expect(result, result.stderr).toMatchObject({ error: undefined, status: 0 });
        expect(JSON.parse(result.stdout)).toEqual({
          appName: "openclaw",
          configDir: ".openclaw",
          version: "0.0.0",
          isBunBinary: false,
          ...expectedAssets(packageDir),
        });
      }),
  );

  it.each(["missing", "invalid"] as const)(
    "surfaces a %s overridden package manifest instead of using the source package",
    (state) =>
      fixtures.run(async () => {
        const root = fixtures.createTempDir("openclaw-package-manifest-");
        const packageDir = join(root, "override");
        const manifest = join(packageDir, "package.json");
        mkdirSync(packageDir);
        if (state === "invalid") {
          writeFileSync(manifest, "{");
        }
        const entry = join(root, "package-metadata.mjs");
        await compileMetadata(entry);
        const result = await fixtures.track(
          runNodeScript(
            [
              "--input-type=module",
              "--eval",
              String.raw`
                try {
                  await import(process.argv[1]);
                  throw new Error("Expected manifest import to fail");
                } catch (error) {
                  console.log(JSON.stringify({ name: error.name, code: error.code, path: error.path }));
                }
              `,
              pathToFileURL(entry).href,
            ],
            { ...process.env, OPENCLAW_PACKAGE_DIR: packageDir },
            10_000,
            { cwd: root, requireProcessTreeExit: true },
          ),
        );

        expect(result, result.stderr).toMatchObject({ error: undefined, status: 0 });
        expect(JSON.parse(result.stdout)).toEqual(
          state === "missing"
            ? { name: "Error", code: "ENOENT", path: manifest }
            : { name: "SyntaxError" },
        );
      }),
  );

  it.each(["2026.9.14-worker", ""])(
    "preserves the worker version binding %j and manifest fallback",
    (workerVersion) =>
      fixtures.run(async () => {
        const root = fixtures.createTempDir("openclaw-worker-package-metadata-");
        const entry = join(root, "worker", "metadata.mjs");
        writePackage(root, {
          version: "4.5.6",
          openclawConfig: { name: "package-claw", configDir: ".package-claw" },
        });
        if (workerVersion) {
          rmSync(join(root, "package.json"));
        }
        await compileMetadata(entry, workerVersion);
        const result = await fixtures.track(
          runNodeScript(
            [
              "--input-type=module",
              "--eval",
              `${snapshotScript}\nconsole.log(JSON.stringify(snapshot()));`,
              pathToFileURL(entry).href,
            ],
            { ...process.env, OPENCLAW_PACKAGE_DIR: root },
            10_000,
            { cwd: dirname(entry), requireProcessTreeExit: true },
          ),
        );

        expect(result, result.stderr).toMatchObject({ error: undefined, status: 0 });
        expect(JSON.parse(result.stdout)).toEqual({
          appName: workerVersion ? "openclaw" : "package-claw",
          configDir: workerVersion ? ".openclaw" : ".package-claw",
          version: workerVersion || "4.5.6",
          isBunBinary: false,
          ...expectedAssets(root),
        });
      }),
  );
});
