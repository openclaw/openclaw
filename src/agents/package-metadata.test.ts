import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";

const fixtures = createFixtureLifetime();
const metadataUrl = new URL("./package-metadata.ts", import.meta.url);

afterEach(() => fixtures.cleanup());

function writePackage(root: string, name?: string) {
  mkdirSync(join(root, "docs"), { recursive: true });
  const openclawConfig = name ? { name, configDir: `.${name}` } : undefined;
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "@fixture/package-name", openclawConfig }),
  );
  writeFileSync(join(root, "README.md"), "fixture readme");
  writeFileSync(join(root, "docs", "guide.md"), "fixture guide");
}

function expectedMetadata(root: string, name = "openclaw") {
  return {
    appName: name,
    configDir: `.${name}`,
    paths: [join(root, "README.md"), join(root, "docs")],
    contents: ["fixture readme", "fixture guide"],
  };
}

const snapshotScript = String.raw`
  import { readFileSync } from "node:fs";
  import { join } from "node:path";
  const metadata = await import(process.argv[1]);
  function snapshot() {
    const paths = [metadata.getReadmePath(), metadata.getDocsPath()];
    return {
      appName: metadata.APP_NAME,
      configDir: metadata.CONFIG_DIR_NAME,
      paths,
      contents: [
        readFileSync(paths[0], "utf8"),
        readFileSync(join(paths[1], "guide.md"), "utf8"),
      ],
    };
  }
`;

async function readMetadata(
  entry: string,
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    script?: string;
    args?: string[];
    workerVersion?: string;
  },
): Promise<unknown> {
  await build({
    entryPoints: [fileURLToPath(metadataUrl)],
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "esm",
    tsconfig: fileURLToPath(new URL("../../tsconfig.json", import.meta.url)),
    logLevel: "silent",
    define:
      options.workerVersion === undefined
        ? undefined
        : { WORKER_DEPLOY_VERSION: JSON.stringify(options.workerVersion) },
  });
  const result = await fixtures.track(
    runNodeScript(
      [
        "--input-type=module",
        "--eval",
        options.script ?? `${snapshotScript}\nconsole.log(JSON.stringify(snapshot()));`,
        pathToFileURL(entry).href,
        ...(options.args ?? []),
      ],
      { ...process.env, OPENCLAW_PACKAGE_DIR: undefined, ...options.env },
      10_000,
      { cwd: options.cwd ?? dirname(entry), requireProcessTreeExit: true },
    ),
  );
  expect(result, result.stderr).toMatchObject({ error: undefined, status: 0 });
  return JSON.parse(result.stdout);
}

it.each(["relative", "~", "~/", "nested"] as const)(
  "captures %s package metadata while asset paths follow later overrides",
  (form) =>
    fixtures.run(async () => {
      const root = fixtures.createTempDir("openclaw-package-metadata-");
      const home = join(root, "home");
      const packageDir = form === "~" ? home : join(home, "package");
      const nextPackageDir = join(root, "replacement");
      const nested = form === "nested";
      writePackage(packageDir, nested ? undefined : "fixture-claw");
      writePackage(nextPackageDir, "replacement");
      if (nested) {
        writePackage(root, "outer-package");
      }
      const overrides = {
        relative: relative(root, packageDir),
        "~": "~",
        "~/": "~/package",
        nested: undefined,
      };
      const entry = join(nested ? join(packageDir, "src", "agents") : root, "package-metadata.mjs");
      const result = await readMetadata(entry, {
        cwd: root,
        env: { HOME: home, USERPROFILE: home, OPENCLAW_PACKAGE_DIR: overrides[form] },
        args: [nextPackageDir],
        script: `${snapshotScript}
            const before = snapshot();
            process.env.OPENCLAW_PACKAGE_DIR = process.argv[2];
            console.log(JSON.stringify({ before, after: snapshot() }));
          `,
      });
      const name = nested ? "openclaw" : "fixture-claw";
      expect(result).toEqual({
        before: expectedMetadata(packageDir, name),
        after: expectedMetadata(nextPackageDir, name),
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
      const result = await readMetadata(entry, {
        env: { OPENCLAW_PACKAGE_DIR: packageDir },
        script: String.raw`
            try {
              await import(process.argv[1]);
              throw new Error("Expected manifest import to fail");
            } catch (error) {
              console.log(JSON.stringify({ name: error.name, code: error.code, path: error.path }));
            }
          `,
      });
      expect(result).toEqual(
        state === "missing"
          ? { name: "Error", code: "ENOENT", path: manifest }
          : { name: "SyntaxError" },
      );
    }),
);

it.each(["2026.9.14-worker", ""])(
  "uses worker metadata defaults for %j and preserves manifest fallback",
  (workerVersion) =>
    fixtures.run(async () => {
      const root = fixtures.createTempDir("openclaw-worker-package-metadata-");
      const entry = join(root, "worker", "metadata.mjs");
      writePackage(root, "package-claw");
      if (workerVersion) {
        rmSync(join(root, "package.json"));
      }
      const result = await readMetadata(entry, {
        workerVersion,
        env: { OPENCLAW_PACKAGE_DIR: root },
      });
      expect(result).toEqual(expectedMetadata(root, workerVersion ? "openclaw" : "package-claw"));
    }),
);
