import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { test } from "node:test";
import { stageInstalledPackage, stagePackage } from "./stage-package.mjs";

const commit = "a".repeat(40);
const write = (root, file, value) => {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value));
};
const read = (root, file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));

for (const platform of ["linux", "windows", "darwin"]) {
  test(`stages same-commit Codex and ${platform} dependencies as verified resources`, (t) => {
    // openclaw-temp-dir: allow verifies raw Tauri resource publication
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tauri-package-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const installed = path.join(root, "installed");
    const work = path.join(root, "work");
    const core = "node_modules/openclaw";
    const native = `node_modules/@openai/codex-${platform === "windows" ? "win32" : platform}-x64`;
    write(installed, `${core}/package.json`, { name: "openclaw" });
    write(installed, `${core}/openclaw.mjs`, "export {};\n");
    write(installed, `${core}/dist/build-info.json`, { commit });
    write(installed, `${core}/dist/plugin-sdk/index.d.ts`, "export declare const sdk: string;\n");
    write(installed, "node_modules/openai/package.json", { name: "openai", version: "7.30.1", main: "index.js" });
    write(installed, "node_modules/openai/index.js", "export {};\n");
    write(installed, "node_modules/openai/index.d.ts", "export {};\n");
    write(installed, "node_modules/openai/src/index.ts", "export {};\n");
    write(installed, "node_modules/openai/src/README.md", "Retain source documentation.\n");
    write(installed, `${core}/dist/extensions/codex/package.json`, {
      openclaw: { extensions: ["./index.js"] },
    });
    write(installed, `${core}/dist/extensions/codex/index.js`, "export {};\n");
    write(installed, `${native}/package.json`, { name: "@openai/codex" });
    write(installed, `${native}/vendor/codex`, "synthetic platform executable");
    write(work, "manifest.json", { runtime: { flavor: "jit", executable: "bin/bun" }, files: { "bin/bun": "existing-runtime-hash" } });
    const payloadWrites = [];
    const writeFileSync = fs.writeFileSync;
    t.mock.method(fs, "writeFileSync", (file, ...args) => {
      if (typeof file === "string" && file.startsWith(`${work}${path.sep}package${path.sep}`)) {
        payloadWrites.push(path.relative(work, file).split(path.sep).join("/"));
      }
      return writeFileSync(file, ...args);
    });
    const added = stageInstalledPackage(installed, work, { platform, arch: "x64" }, {
      commit, pluginIds: ["codex"],
    });
    const decode = (file) => {
      const bytes = fs.readFileSync(path.join(work, "package", file));
      return platform === "linux" ? bytes.subarray(Buffer.byteLength("OPENCLAW-BUN-RUNTIME-V1\n")) : bytes;
    };
    const build = JSON.parse(decode(`${core}/dist/build-info.json`));
    assert.deepEqual(build.stagedOfficialPlugins, { commit, pluginIds: ["codex"] });
    const owner = decode(`${core}/openclaw-install-owner.json`);
    assert.deepEqual(JSON.parse(owner), {
      schemaVersion: 1,
      owner: "desktop-app",
      displayName: "OpenClaw desktop",
      updateHint: "Rebuild or update the desktop app to update this Gateway.",
    });
    assert.equal(decode(`${native}/vendor/codex`).toString(), "synthetic platform executable");
    const manifest = read(work, "manifest.json");
    assert.deepEqual(manifest.runtime, { flavor: "jit", executable: "bin/bun", entry: "package/node_modules/openclaw/openclaw.mjs" });
    assert.deepEqual(payloadWrites.toSorted(), platform === "linux"
      ? Object.keys(manifest.files).filter((file) => file.startsWith("package/")).toSorted()
      : []);
    assert.equal(fs.existsSync(path.join(work, "package", core, "dist/plugin-sdk/index.d.ts")), false);
    assert.equal(fs.existsSync(path.join(work, "package/node_modules/openai/index.d.ts")), false);
    assert.equal(fs.existsSync(path.join(work, "package/node_modules/openai/src/index.ts")), false);
    assert.equal(decode("node_modules/openai/src/README.md").toString(), "Retain source documentation.\n");
    assert.equal(manifest.files["bin/bun"], "existing-runtime-hash");
    assert.equal(manifest.files[`package/${core}/openclaw-install-owner.json`],
      createHash("sha256").update(owner).digest("hex"));
    assert.equal(manifest.files[`package/${native}/vendor/codex`],
      createHash("sha256").update("synthetic platform executable").digest("hex"));
    assert.ok(added > 0);
    assert.throws(() => stageInstalledPackage(installed, work, { platform, arch: "arm64" }, {
      commit, pluginIds: ["codex"],
    }), /Cannot find module/);
  });
}

test("never installs a loose package into an AOT payload", (t) => {
  // openclaw-temp-dir: allow verifies rejection before any package mutation
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "tauri-aot-package-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const manifest = { runtime: { flavor: "aot", executable: "standalone/openclaw" }, files: {} };
  write(work, "manifest.json", manifest);
  assert.throws(() => stageInstalledPackage(path.join(work, "absent"), work, { platform: "linux", arch: "x64" }, {}), /only be staged for the JIT/);
  assert.deepEqual(read(work, "manifest.json"), manifest);
  assert.equal(fs.existsSync(path.join(work, "package")), false);
});

test("rejects an installed package with the wrong identity before staging", (t) => {
  // openclaw-temp-dir: allow verifies the fresh archive identity before mutation
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tauri-package-identity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installed = path.join(root, "installed");
  const work = path.join(root, "work");
  write(installed, "node_modules/openclaw/package.json", { name: "unexpected-package" });
  write(installed, "node_modules/openclaw/dist/build-info.json", { commit });
  write(installed, "node_modules/openclaw/dist/extensions/codex/package.json", {
    openclaw: { extensions: ["./index.js"] },
  });
  write(installed, "node_modules/openclaw/dist/extensions/codex/index.js", "export {};\n");
  write(installed, "node_modules/@openai/codex-win32-x64/package.json", { name: "@openai/codex" });
  write(work, "manifest.json", { runtime: { flavor: "jit", executable: "bin/bun" }, files: { "bin/bun": "original" } });
  assert.throws(() => stageInstalledPackage(installed, work, { platform: "windows", arch: "x64" }, {
    commit, pluginIds: ["codex"],
  }), /Expected the OpenClaw package/);
  assert.deepEqual(read(installed, "node_modules/openclaw/package.json"), { name: "unexpected-package" });
  assert.deepEqual(read(installed, "node_modules/openclaw/dist/build-info.json"), { commit });
  assert.equal(fs.existsSync(path.join(installed, "node_modules/openclaw/openclaw-install-owner.json")), false);
  assert.deepEqual(read(work, "manifest.json"), { runtime: { flavor: "jit", executable: "bin/bun" }, files: { "bin/bun": "original" } });
  assert.equal(fs.existsSync(path.join(work, "package")), false);
});

test("exact release builds still stage their source package", (t) => {
  // openclaw-temp-dir: allow exercises the exact Git release boundary
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tauri-release-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "--allow-empty", "-qm", "fixture"]);
  execFileSync("git", ["-C", root, "tag", "v2026.10.2"]);
  write(root, "package.json", { version: "2026.10.2" });
  write(root, "scripts/package-openclaw-for-docker.mjs", 'import fs from "node:fs"; fs.writeFileSync("package-builder-reached", "yes"); process.exit(42);');
  const work = path.join(root, "resources");
  write(work, "manifest.json", { runtime: { flavor: "jit", executable: "bin/bun" }, files: { "bin/bun": "original" } });
  assert.throws(() => stagePackage(root, work, { platform: "linux", arch: "x64" }), { status: 42 });
  assert.equal(fs.readFileSync(path.join(root, "package-builder-reached"), "utf8"), "yes");
  assert.deepEqual(fs.readdirSync(work), ["manifest.json"]);
  assert.deepEqual(read(work, "manifest.json"), { runtime: { flavor: "jit", executable: "bin/bun" }, files: { "bin/bun": "original" } });
});

for (const platform of ["linux", "windows"]) {
  test(`tagless ${platform} release builds still stage their source package`, (t) => {
    // openclaw-temp-dir: allow exercises release staging through a shallow Git checkout
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tauri-release-identity-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const origin = path.join(root, "origin");
    execFileSync("git", ["init", "--quiet", origin]);
    write(origin, "package.json", { version: "2026.10.2" });
    execFileSync("git", ["-C", origin, "add", "."]);
    execFileSync("git", ["-C", origin, "-c", "user.name=Fixture", "-c",
      "user.email=fixture@example.invalid", "commit", "-qm", "release"]);
    execFileSync("git", ["-C", origin, "tag", "v2026.10.2"]);
    const clone = path.join(root, "clone");
    execFileSync("git", ["clone", "--quiet", "--depth=1", "--no-tags", pathToFileURL(origin).href, clone]);
    assert.equal(execFileSync("git", ["-C", clone, "tag", "--list"], { encoding: "utf8" }), "");
    const source = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    write(clone, "scripts/package-openclaw-for-docker.mjs", 'import fs from "node:fs"; fs.writeFileSync("package-builder-reached", "yes"); process.exit(42);');
    const work = path.join(root, "resources");
    write(work, "manifest.json", { runtime: { flavor: "jit", executable: "bin/bun" }, files: { "bin/bun": "original" } });
    assert.throws(() => execFileSync(process.execPath, ["--input-type=module", "--eval",
      "const { stagePackage } = await import(process.argv[1]); stagePackage(process.argv[2], process.argv[3], { platform: process.argv[4], arch: 'x64' });",
      new URL("./stage-package.mjs", import.meta.url).href, clone, work, platform], {
      env: { ...process.env, RELEASE_TAG: "v2026.10.2", RELEASE_SHA: source },
      stdio: "pipe",
    }), /Command failed/);
    assert.equal(fs.readFileSync(path.join(clone, "package-builder-reached"), "utf8"), "yes");
    assert.deepEqual(fs.readdirSync(work), ["manifest.json"]);
    assert.deepEqual(read(work, "manifest.json"), { runtime: { flavor: "jit", executable: "bin/bun" }, files: { "bin/bun": "original" } });
  });
}

test("reuses npm tarballs across isolated same-commit package installs", async (t) => {
  // openclaw-temp-dir: allow verifies staging with tiny real npm artifacts
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tauri package cache-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const core = path.join(root, "core");
  const native = path.join(root, "native");
  const cache = path.join(root, "cache");
  const nativeArchive = path.join(root, "codex.tgz");
  const coreArchive = path.join(root, "openclaw.tgz");
  write(native, "package/package.json", { name: "@openai/codex-win32-x64", version: "1.0.0" });
  write(native, "package/vendor/codex.exe", "synthetic Windows executable\n");
  execFileSync("tar", ["-czf", nativeArchive, "-C", native, "package"]);

  // Keep the fixture server responsive while stagePackage synchronously runs npm.
  const registry = new Worker(`
    const fs = require("node:fs");
    const http = require("node:http");
    const { parentPort, workerData } = require("node:worker_threads");
    const archive = fs.readFileSync(workerData);
    let tarballFetches = 0;
    parentPort.on("message", () => parentPort.postMessage({ tarballFetches }));
    const server = http.createServer((request, response) => {
      if (request.url === "/codex.tgz") {
        tarballFetches++;
        response.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": archive.length,
          "Cache-Control": "public, max-age=31536000, immutable",
        });
        response.end(archive);
      } else {
        response.writeHead(404).end();
      }
    });
    server.listen(0, "127.0.0.1", () => parentPort.postMessage(server.address().port));
  `, { eval: true, workerData: nativeArchive });
  t.after(() => registry.terminate());
  const [port] = await once(registry, "message");
  const origin = `http://127.0.0.1:${port}`;
  const manifest = {
    name: "openclaw", version: "0.0.0",
    files: ["!dist/extensions/codex/**"],
    scripts: { postinstall: `node -e "require('node:fs').writeFileSync('installed.txt', 'fresh install')"` },
    dependencies: { "@openai/codex-win32-x64": `${origin}/codex.tgz` },
  };
  write(source, "package.json", manifest);
  write(source, "extensions/codex/package.json", { name: "@openclaw/codex" });
  write(source, "scripts/lib/official-external-plugin-catalog.json", {
    entries: [{ name: "@openclaw/codex" }],
  });
  execFileSync("git", ["init", "--quiet", source]);
  execFileSync("git", ["-C", source, "-c", "user.name=Fixture", "-c",
    "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"]);
  const sourceCommit = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  write(source, "dist/build-info.json", { commit: sourceCommit });
  write(core, "package/package.json", manifest);
  write(core, "package/openclaw.mjs", "export {};\n");
  fs.chmodSync(path.join(core, "package/openclaw.mjs"), 0o755);
  write(core, "package/dist/build-info.json", { commit: sourceCommit });
  write(core, "package/dist/extensions/codex/package.json", { openclaw: { extensions: ["./index.js"] } });
  write(core, "package/dist/extensions/codex/index.js", "export {};\n");
  execFileSync("tar", ["-czf", coreArchive, "-C", core, "package"]);
  // Supply independent package input without building the real OpenClaw workspace.
  write(source, "scripts/package-openclaw-for-docker.mjs", `
    import fs from "node:fs";
    import path from "node:path";
    fs.copyFileSync(${JSON.stringify(coreArchive)}, path.join(process.argv[process.argv.indexOf("--output-dir") + 1], "openclaw.tgz"));
  `);

  const inherited = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^npm_config_/i.test(key) && !/^RELEASE_(?:TAG|SHA)$/.test(key)));
  let expected;
  const cases = [
    ["npm_config_cache", { npm_config_cache: cache, NPM_CONFIG_CACHE: "" }],
    ["NPM_CONFIG_CACHE", { npm_config_cache: path.join(root, "unused-cache"), NPM_CONFIG_CACHE: cache }],
    ["NpM_cOnFiG_cAcHe", { NpM_cOnFiG_cAcHe: cache }],
  ];
  for (const [index, [alias, cacheEnv]] of cases.entries()) {
    const entry = index === 2 ? "export const fresh = true;\n" : "export {};\n";
    if (index === 2) {
      write(core, "package/openclaw.mjs", entry);
      execFileSync("tar", ["-czf", coreArchive, "-C", core, "package"]);
    }
    const work = path.join(root, `resources-${index}`);
    write(work, "manifest.json", { runtime: { flavor: "jit", executable: "bin/bun.exe" }, files: { "bin/bun.exe": "existing-runtime-hash" } });
    execFileSync(process.execPath, ["--input-type=module", "--eval", `
      import assert from "node:assert/strict";
      import childProcess from "node:child_process";
      import { syncBuiltinESMExports } from "node:module";
      // A plain object preserves alias order on Windows as well as POSIX.
      process.env = { ...process.env, ...JSON.parse(process.argv[4]) };
      const original = childProcess.execFileSync;
      let installs = 0;
      childProcess.execFileSync = (command, args, options) => {
        if (options?.env?.HOME) {
          installs++;
          assert.deepEqual(Object.keys(options.env).filter((key) => /^npm_config_/i.test(key)), ["npm_config_cache"]);
          assert.equal(options.env.npm_config_cache, process.argv[5]);
          assert.equal(options.env.HOME, options.env.USERPROFILE);
          assert.notEqual(options.env.HOME, process.env.HOME);
          assert.equal(options.env.LOCALAPPDATA, undefined);
          assert.ok(args.some((arg) => arg.includes("openclaw@file:" + process.env.TMPDIR)));
        }
        return original(command, args, options);
      };
      syncBuiltinESMExports();
      const { stagePackage } = await import(process.argv[1]);
      stagePackage(process.argv[2], process.argv[3], { platform: "windows", arch: "x64" });
      assert.equal(installs, 1);
    `, new URL("./stage-package.mjs", import.meta.url).href, source, work, JSON.stringify(cacheEnv), cache], {
      env: { ...inherited, npm_config_registry: "https://registry.example.invalid", LOCALAPPDATA: root,
        TMPDIR: root, TEMP: root, TMP: root },
      stdio: "pipe",
    });
    assert.ok(fs.existsSync(path.join(cache, "_cacache")), `${alias} did not populate the reusable npm cache`);
    // Synchronous npm can outlive an idle HTTP socket; read the worker-owned counter over IPC.
    const counted = once(registry, "message");
    registry.postMessage("requests");
    const [requests] = await counted;
    assert.equal(requests.tarballFetches, 1, `${alias} downloaded the already cached tarball`);
    const staged = read(work, "manifest.json");
    const stagedCore = path.join(work, "package/node_modules/openclaw");
    assert.equal(fs.readFileSync(path.join(stagedCore, "openclaw.mjs"), "utf8"), entry);
    assert.equal(fs.readFileSync(path.join(stagedCore, "installed.txt"), "utf8"), "fresh install");
    if (process.platform !== "win32") assert.equal(fs.statSync(path.join(stagedCore, "openclaw.mjs")).mode & 0o777, 0o755);
    assert.ok(staged.files["package/node_modules/@openai/codex-win32-x64/vendor/codex.exe"]);
    if (index === 2) assert.notDeepEqual(staged, expected);
    else if (expected) assert.deepEqual(staged, expected);
    else expected = staged;
  }
});
