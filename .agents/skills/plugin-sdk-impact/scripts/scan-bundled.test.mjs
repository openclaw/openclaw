import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { captureSource, verifySource } from "./scan-bundled.mjs";

const exec = promisify(execFile);

async function commit(root, message) {
  await exec("git", ["-C", root, "add", "."]);
  await exec("git", [
    "-C",
    root,
    "-c",
    "commit.gpgsign=false",
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    message,
  ]);
}

async function checkout(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sdk-bundled-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "extensions", "local"), { recursive: true });
  await writeFile(path.join(root, "extensions/local/openclaw.plugin.json"), '{"id":"local"}');
  await writeFile(
    path.join(root, "extensions/local/package.json"),
    '{"name":"@example/local","openclaw":{"extensions":["./index.ts"]}}',
  );
  await writeFile(path.join(root, "extensions/local/index.ts"), "export default {};\n");
  await exec("git", ["init", "--quiet", root]);
  await commit(root, "fixture");
  return root;
}

test("bundled source receipts reject stale commits, changed plugin code, and omitted plugins", async (t) => {
  const root = await checkout(t);
  const { source, plugins } = await captureSource(root);
  assert.equal(source.dirty, false);
  assert.deepEqual(plugins, [
    { pluginId: "local", packageName: "@example/local", relativeRoot: "extensions/local" },
  ]);
  await verifySource(source, plugins);
  await assert.rejects(verifySource(source, []), /roster/);
  await writeFile(
    path.join(root, "extensions/local/index.ts"),
    "export default { changed: true };\n",
  );
  await assert.rejects(verifySource(source, plugins), /uncommitted/);
  await commit(root, "changed");
  await assert.rejects(verifySource(source, plugins), /commit/);
});

test("untracked bundled code prevents a clean receipt while unrelated notes do not", async (t) => {
  const root = await checkout(t);
  await writeFile(path.join(root, "notes.md"), "unrelated\n");
  await captureSource(root);
  await writeFile(path.join(root, "extensions/local/new.ts"), "export default {};\n");
  await assert.rejects(captureSource(root), /uncommitted/);
});

test("malformed plugin metadata stays visible and symlinked plugins cannot disappear", async (t) => {
  const root = await checkout(t);
  await rm(path.join(root, "extensions/local/package.json"));
  await commit(root, "manifest-only plugin");
  const manifestOnly = await captureSource(root);
  assert.equal(manifestOnly.plugins[0].packageName, null);
  assert.match(manifestOnly.plugins[0].error, /cannot establish the implicit host entrypoint/);
  await assert.rejects(
    verifySource(manifestOnly.source, [{ ...manifestOnly.plugins[0], error: undefined }]),
    /metadata failure/,
  );
  await writeFile(path.join(root, "extensions/local/package.json"), "{}");
  await commit(root, "missing package identity");
  const { source, plugins } = await captureSource(root);
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].packageName, null);
  assert.match(plugins[0].error, /missing its name/);
  await verifySource(source, plugins);
  await assert.rejects(
    verifySource(source, [{ ...plugins[0], error: undefined }]),
    /metadata failure/,
  );
  await symlink("local", path.join(root, "extensions/linked"), "dir");
  await commit(root, "linked plugin");
  await assert.rejects(captureSource(root), /symlink/);
});

test("ignored generated SDK declarations and plugin code invalidate a source receipt", async (t) => {
  const root = await checkout(t);
  await writeFile(path.join(root, ".gitignore"), "dist/\n*.generated.ts\n");
  await commit(root, "generated inputs");
  const before = await captureSource(root);
  await mkdir(path.join(root, "dist/plugin-sdk"), { recursive: true });
  await writeFile(path.join(root, "dist/plugin-sdk/core.d.ts"), "export type Host = {};\n");
  await assert.rejects(verifySource(before.source, before.plugins), /fingerprint/);
  const withDeclarations = await captureSource(root);
  await writeFile(path.join(root, "extensions/local/extra.generated.ts"), "export default {};\n");
  await assert.rejects(
    verifySource(withDeclarations.source, withDeclarations.plugins),
    /fingerprint/,
  );
});

test("CLI runs through a symlinked skill installation", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sdk-bundled-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const link = path.join(directory, "scanner.mjs");
  await symlink(fileURLToPath(new URL("scan-bundled.mjs", import.meta.url)), link);
  const { stdout } = await exec(process.execPath, [link, "--help"]);
  assert.match(stdout, /Usage: node scan-bundled.mjs/);
});
