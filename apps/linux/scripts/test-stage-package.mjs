import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { stageInstalledPackage, stagePackage } from "./stage-package.mjs";

const commit = "a".repeat(40);
const write = (root, file, value) => {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value));
};
const read = (root, file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));

for (const platform of ["linux", "windows"]) {
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
    write(work, "manifest.json", { files: { "bin/bun": "existing-runtime-hash" } });
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

test("exact release builds leave runtime resources unchanged without building or installing core", (t) => {
  // openclaw-temp-dir: allow exercises the exact Git release boundary
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tauri-release-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "--allow-empty", "-qm", "fixture"]);
  execFileSync("git", ["-C", root, "tag", "v2026.10.2"]);
  write(root, "package.json", { version: "2026.10.2" });
  const work = path.join(root, "resources");
  write(work, "manifest.json", { files: { "bin/bun": "original" } });
  stagePackage(root, work, { platform: "linux", arch: "x64" });
  assert.deepEqual(fs.readdirSync(work), ["manifest.json"]);
  assert.deepEqual(read(work, "manifest.json"), { files: { "bin/bun": "original" } });
});

for (const platform of ["linux", "windows"]) {
  test(`tagless ${platform} release builds preserve Bun-only resources`, (t) => {
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
    const work = path.join(root, "resources");
    write(work, "manifest.json", { files: { "bin/bun": "original" } });
    execFileSync(process.execPath, ["--input-type=module", "--eval",
      "const { stagePackage } = await import(process.argv[1]); stagePackage(process.argv[2], process.argv[3], { platform: process.argv[4], arch: 'x64' });",
      new URL("./stage-package.mjs", import.meta.url).href, clone, work, platform], {
      env: { ...process.env, RELEASE_TAG: "v2026.10.2", RELEASE_SHA: source },
    });
    assert.deepEqual(fs.readdirSync(work), ["manifest.json"]);
    assert.deepEqual(read(work, "manifest.json"), { files: { "bin/bun": "original" } });
  });
}
