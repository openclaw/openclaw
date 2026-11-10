// Normal enabled plugin fixture. No product imports, preload, or product-only test seam.
export const ID = 'hosted-data-proof';
export const ORIGINAL = 'operator asset: keep this exact text\n';
export const PRIVATE = 'private rehearsal write\n';
export const SETTINGS = { label: 'retained operator setting', retained: 177869 };
function register(api) {
  assert.deepEqual(api.pluginConfig, spec.settings, 'plugin settings were not retained');
  const state = process.env.OPENCLAW_STATE_DIR;
  const root = api.rootDir;
  assert(state && root, 'plugin API omitted state/root');
  const asset = path.join(root, 'config.txt');
  const alias = path.join(root, 'second.txt');
  assert.equal(fs.readFileSync(spec.sourceAsset, 'utf8'), spec.original, 'live asset changed');
  if (state === spec.liveState) {
    assert.equal(fs.readFileSync(asset, 'utf8'), spec.original);
    console.error('HOSTED_LIVE_REGISTER ' + JSON.stringify({ root, node: process.versions.node, bun: process.versions.bun ?? null }));
    return;
  }
  // Restrict our intentional fixture write to the updater-projected regular file.
  // Do not resolve through an unsafe symlink just to demonstrate a corruption.
  assert.equal(fs.lstatSync(asset).isSymbolicLink(), false, 'private data alias still a symlink');
  assert.equal(fs.statSync(asset).nlink, 1, 'private asset is hard linked');
  assert(fs.realpathSync(asset).startsWith(fs.realpathSync(state) + path.sep), 'private alias escaped state');
  assert.equal(fs.readFileSync(alias, 'utf8'), spec.original, 'second alias changed');
  const before = fs.readFileSync(asset, 'utf8');
  assert([spec.original, spec.privateText].includes(before));
  fs.writeFileSync(asset, spec.privateText);
  assert.equal(fs.readFileSync(asset, 'utf8'), spec.privateText);
  assert.equal(fs.readFileSync(alias, 'utf8'), spec.original, 'private aliases share writes');
  assert.equal(fs.readFileSync(spec.sourceAsset, 'utf8'), spec.original, 'private write escaped to live source');
  const receipt = { kind: 'private-register-write', state, root, asset, alias,
    sourceAsset: spec.sourceAsset, before, after: spec.privateText, settings: api.pluginConfig,
    node: process.versions.node, bun: process.versions.bun ?? null,
    mode: spec.mode, pid: process.pid, time: Date.now(), argv: process.argv };
  fs.writeFileSync(path.join(state, 'hosted-proof-private.json'), JSON.stringify(receipt));
  console.error('HOSTED_PRIVATE_REGISTER ' + JSON.stringify(receipt));
  if (spec.mode === 'failure') {
    console.error('HOSTED_EXPECTED_FAILURE_AFTER_PRIVATE_WRITE');
    process.exit(42);
  }
  // Slow plugin registration is a public runtime behavior. No updater instrumentation.
  // Gives the external observer a bounded opportunity to cancel *after* projection/write.
  if (spec.mode === 'cancel') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
}
export function pluginSource({ liveState, sourceAsset, mode }) {
  const spec = { liveState, sourceAsset, mode, original: ORIGINAL, privateText: PRIVATE, settings: SETTINGS };
  return 'import fs from "node:fs";\nimport path from "node:path";\nimport assert from "node:assert/strict";\n'
    + 'const spec = ' + JSON.stringify(spec) + ';\n'
    + 'export default { id: ' + JSON.stringify(ID) + ', register: ' + register.toString() + ' };\n';
}
