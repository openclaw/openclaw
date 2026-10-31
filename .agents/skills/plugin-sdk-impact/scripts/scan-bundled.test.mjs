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
const write = (root, file, content) => writeFile(path.join(root, file), content);
const identity = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"];
const git = (root, ...args) => exec("git", ["-C", root, ...identity, ...args]);
const verify = (receipt, plugins = receipt.plugins) => verifySource(receipt.source, plugins);

async function commit(root, message) {
  await git(root, "add", ".");
  await git(root, "commit", "--no-gpg-sign", "--quiet", "-m", message);
}

async function checkout(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sdk-bundled-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "extensions", "local"), { recursive: true });
  const local = (file, content) => write(root, `extensions/local/${file}`, content);
  await local("openclaw.plugin.json", '{"id":"local"}');
  await local("package.json", '{"name":"@example/local","openclaw":{"extensions":["./index.ts"]}}');
  await local("index.ts", "export default {};\n");
  await git(root, "init", "--quiet");
  await commit(root, "fixture");
  return root;
}

test("receipts ignore notes but reject stale commits, changed/untracked code, and omitted plugins", async (t) => {
  const root = await checkout(t);
  await write(root, "notes.md", "unrelated\n");
  const { source, plugins } = await captureSource(root);
  assert.deepEqual(plugins, [
    { pluginId: "local", packageName: "@example/local", relativeRoot: "extensions/local" },
  ]);
  await verifySource(source, plugins);
  await assert.rejects(verifySource(source, []), /roster/);
  await write(root, "extensions/local/index.ts", "export default { changed: true };\n");
  await assert.rejects(verifySource(source, plugins), /uncommitted/);
  await commit(root, "changed");
  await assert.rejects(verifySource(source, plugins), /commit/);
  await write(root, "extensions/local/new.ts", "export default {};\n");
  await assert.rejects(captureSource(root), /uncommitted/);
});

test("malformed plugin metadata stays visible and symlinked plugins cannot disappear", async (t) => {
  const root = await checkout(t);
  const packageFile = path.join(root, "extensions/local/package.json");
  for (const [change, error] of [
    [() => rm(packageFile), /cannot establish the implicit host entrypoint/],
    [() => writeFile(packageFile, "{}"), /missing its name/],
  ]) {
    await change();
    await commit(root, "malformed metadata");
    const receipt = await captureSource(root);
    const [plugin] = receipt.plugins;
    assert.equal(receipt.plugins.length, 1);
    assert.equal(plugin.packageName, null);
    assert.match(plugin.error, error);
    await verify(receipt);
    await assert.rejects(verify(receipt, [{ ...plugin, error: undefined }]), /metadata failure/);
  }
  await symlink("local", path.join(root, "extensions/linked"), "dir");
  await commit(root, "linked plugin");
  await assert.rejects(captureSource(root), /symlink/);
});

test("ignored generated SDK declarations and plugin code invalidate a source receipt", async (t) => {
  const root = await checkout(t);
  await write(root, ".gitignore", "dist/\n*.generated.ts\n");
  await commit(root, "generated inputs");
  const before = await captureSource(root);
  await mkdir(path.join(root, "dist/plugin-sdk"), { recursive: true });
  await write(root, "dist/plugin-sdk/core.d.ts", "export type Host = {};\n");
  await assert.rejects(verify(before), /fingerprint/);
  const withDeclarations = await captureSource(root);
  await write(root, "extensions/local/extra.generated.ts", "export default {};\n");
  await assert.rejects(verify(withDeclarations), /fingerprint/);
});

test("CLI runs through a symlinked skill installation", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sdk-bundled-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const link = path.join(directory, "scanner.mjs");
  await symlink(fileURLToPath(new URL("scan-bundled.mjs", import.meta.url)), link);
  const { stdout } = await exec(process.execPath, [link, "--help"]);
  assert.match(stdout, /Usage: node scan-bundled.mjs/);
});
