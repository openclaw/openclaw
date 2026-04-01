import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const tempDirs: string[] = [];
const REPO_ROOT = process.cwd();
const MATRIX_RUNTIME_STUB = [
  "export async function ensureMatrixCryptoRuntime() {}",
  "export async function handleVerifyRecoveryKey() {}",
  "export async function handleVerificationBootstrap() {}",
  "export async function handleVerificationStatus() {}",
  "",
].join("\n");

function makeFixtureRoot(prefix: string) {
  const fixtureRoot = fs.mkdtempSync(path.join(REPO_ROOT, prefix));
  tempDirs.push(fixtureRoot);
  return fixtureRoot;
}

function writeFixtureFile(fixtureRoot: string, relativePath: string, value: string) {
  const fullPath = path.join(fixtureRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, value, "utf8");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("loads the plugin-entry runtime wrapper through native ESM import", async () => {
  const wrapperPath = path.join(
    process.cwd(),
    "extensions",
    "matrix",
    "src",
    "plugin-entry.runtime.js",
  );
  const wrapperUrl = pathToFileURL(wrapperPath);
  const mod = await import(wrapperUrl.href);

  expect(mod).toMatchObject({
    ensureMatrixCryptoRuntime: expect.any(Function),
    handleVerifyRecoveryKey: expect.any(Function),
    handleVerificationBootstrap: expect.any(Function),
    handleVerificationStatus: expect.any(Function),
  });
}, 240_000);

it("loads the packaged runtime wrapper without recursing through the stable root alias", async () => {
  const fixtureRoot = makeFixtureRoot(".tmp-matrix-runtime-");
  const wrapperSource = fs.readFileSync(
    path.join(REPO_ROOT, "extensions", "matrix", "src", "plugin-entry.runtime.js"),
    "utf8",
  );

  writeFixtureFile(
    fixtureRoot,
    "package.json",
    JSON.stringify(
      {
        name: "openclaw",
        type: "module",
        exports: {
          "./plugin-sdk": "./dist/plugin-sdk/index.js",
        },
      },
      null,
      2,
    ) + "\n",
  );
  writeFixtureFile(fixtureRoot, "dist/plugin-sdk/index.js", "export {};\n");
  writeFixtureFile(fixtureRoot, "dist/plugin-entry.runtime-C88YIa_v.js", wrapperSource);
  writeFixtureFile(
    fixtureRoot,
    "dist/plugin-entry.runtime.js",
    'export * from "./plugin-entry.runtime-C88YIa_v.js";\n',
  );
  writeFixtureFile(
    fixtureRoot,
    "dist/extensions/matrix/plugin-entry.handlers.runtime.js",
    MATRIX_RUNTIME_STUB,
  );

  const wrapperUrl = pathToFileURL(
    path.join(fixtureRoot, "dist", "plugin-entry.runtime-C88YIa_v.js"),
  );
  const mod = await import(`${wrapperUrl.href}?t=${Date.now()}`);

  expect(mod).toMatchObject({
    ensureMatrixCryptoRuntime: expect.any(Function),
    handleVerifyRecoveryKey: expect.any(Function),
    handleVerificationBootstrap: expect.any(Function),
    handleVerificationStatus: expect.any(Function),
  });
}, 240_000);
