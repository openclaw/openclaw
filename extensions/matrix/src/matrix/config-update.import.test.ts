import { execFile } from "node:child_process";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "openclaw/plugin-sdk/process-runtime";
import { describe, expect, it } from "vitest";
import { matrixConfigImportEntrypoints } from "./config-update-runtime.test-support.js";

const updateUrl = resolveRuntimeWorkerUrl(matrixConfigImportEntrypoints.update);
const moduleExtension = extname(updateUrl.pathname);
const setupUrl = new URL(`../../../../src/secrets/plugin-setup-plan${moduleExtension}`, updateUrl);
const resolverUrl = new URL(`../../../../src/secrets/resolve${moduleExtension}`, updateUrl);

async function runImportSmoke(code: string): Promise<string> {
  const repoRoot = new URL("../../../../", import.meta.url);
  const runtimeArgs = process.versions.bun
    ? ["--tsconfig-override", fileURLToPath(new URL("tsconfig.json", repoRoot))]
    : resolveRuntimeWorkerArgv(updateUrl).slice(0, -1);
  const { stdout } = await promisify(execFile)(process.execPath, [...runtimeArgs, "-e", code], {
    cwd: fileURLToPath(repoRoot),
    env: Object.fromEntries(
      ["HOME", "NODE_OPTIONS", "NODE_PATH", "PATH", "TERM"].map((key) => [key, process.env[key]]),
    ),
    timeout: 40_000,
  });
  return stdout;
}

describe("matrix config update import boundary", () => {
  it("updates secret inputs without loading secret setup or resolution", async () => {
    const stdout = await runImportSmoke(String.raw`
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const canonical = (url) => pathToFileURL(realpathSync(fileURLToPath(url))).href;
const entryUrl = canonical(${JSON.stringify(updateUrl.href)});
const watchedUrls = new Map(${JSON.stringify([
      [updateUrl.href, "entry"],
      [setupUrl.href, "setup"],
      [resolverUrl.href, "resolver"],
    ])}
  .map(([url, owner]) => [canonical(url), owner]));
const observed = { entry: false, setup: false, resolver: false };
let deregister = () => {};
if (process.versions.bun) {
  const { plugin } = await import("bun");
  const paths = [...watchedUrls.keys()].map((url) => fileURLToPath(url));
  const escapedPaths = paths.map((path) => path.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&"));
  plugin({
    name: "matrix-config-import-observer",
    setup(build) {
      build.onLoad({ filter: new RegExp("^(?:" + escapedPaths.join("|") + ")$"), namespace: "file" }, async ({ path }) => {
        const owner = watchedUrls.get(pathToFileURL(realpathSync(path)).href);
        if (owner) observed[owner] = true;
        return { contents: new Uint8Array(await Bun.file(path).arrayBuffer()), loader: "ts" };
      });
    },
  });
} else {
  const { registerHooks } = await import("node:module");
  const hooks = registerHooks({
    load(url, context, nextLoad) {
      // Loader query parameters do not change which filesystem owner is loaded.
      const canonicalUrl = new URL(url);
      canonicalUrl.search = "";
      canonicalUrl.hash = "";
      const owner = watchedUrls.get(canonicalUrl.href);
      if (owner) observed[owner] = true;
      return nextLoad(url, context);
    },
  });
  deregister = () => hooks.deregister();
}
try {
  const { updateMatrixAccountConfig } = await import(entryUrl);
  const ref = { source: "env", provider: "default", id: "MATRIX_IMPORT_TEST_TOKEN" };
  const updated = updateMatrixAccountConfig({}, "default", {
    accessToken: ref,
    password: "  synthetic-password  ",
  });
  const { hasExplicitMatrixAccountConfig } = await import(${JSON.stringify(resolveRuntimeWorkerUrl(matrixConfigImportEntrypoints.account).href)});
  process.stdout.write(JSON.stringify({
    observed,
    account: updated.channels.matrix,
    explicitAccount: hasExplicitMatrixAccountConfig({ channels: { matrix: { accessToken: ref } } }, "default"),
  }));
} finally {
  deregister();
}
`);
    const result = JSON.parse(stdout);
    expect(result, "Matrix config updates must not load secret setup or resolver owners").toEqual({
      observed: { entry: true, setup: false, resolver: false },
      account: {
        enabled: true,
        accessToken: { source: "env", provider: "default", id: "MATRIX_IMPORT_TEST_TOKEN" },
        password: "synthetic-password",
      },
      explicitAccount: true,
    });
  }, 45_000);
});
