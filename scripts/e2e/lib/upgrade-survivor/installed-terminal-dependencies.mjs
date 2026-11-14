// Driver-owned, offline attestation. Never imported by the product preload.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { capturePackageTree } from "./installed-recovery-observations.mjs";
import { readInstalledTerminalDependencyTree } from "./installed-terminal-contracts.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const inside = (root, file) => file === root || file.startsWith(`${root}${path.sep}`);
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const portable = (rows) =>
  rows.map(({ path: file, kind, mode, content }) => [file, kind, mode, content]);

function readInput(file) {
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4 * 1024 * 1024);
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.length, stat.size);
  return bytes;
}

export function installedTerminalNpmOwner(cli) {
  const actual = fs.realpathSync(cli);
  const root = path.dirname(path.dirname(actual));
  assert.equal(actual, path.join(root, "bin/npm-cli.js"));
  const manifest = JSON.parse(readInput(path.join(root, "package.json")).toString("utf8"));
  assert.equal(manifest.name, "npm");
  assert.equal(manifest.version, "11.19.1", "Unreviewed bare-image npm contract");
  return { cli: actual, version: manifest.version, sha256: digest(readInput(actual)) };
}

function absentOptional(edge) {
  assert(edge.optional && !edge.to && !edge.error, "Missing required native dependency edge");
  // Arborist reports optional absence without an error. Confirm Node cannot
  // resolve an ambient package omitted from this isolated native tree.
  const require = createRequire(path.join(edge.from.realpath, "package.json"));
  let missing = false;
  try {
    require.resolve(edge.name);
  } catch (error) {
    assert.equal(error.code, "MODULE_NOT_FOUND", "Unknown optional resolution failure");
    missing = true;
  }
  assert(missing, "Optional dependency resolves outside the native tree");
}

/** Project native placements/edges; do not infer a resolver from package manifests. */
export function inspectInstalledTerminalDependencyNodes(application, nodes, roots, reference) {
  const modules = path.join(application.realpath, "node_modules");
  const selected = new Map(nodes.map((node) => [node.target.realpath, node.target]));
  assert(selected.size > 0 && selected.size <= 4096);
  const edges = [];
  for (const name of roots) {
    const edge = application.edgesOut.get(name);
    assert(edge && !edge.error && edge.to && selected.has(edge.to.target.realpath));
    assert.equal(
      application.package.dependencies?.[name],
      reference.policy.dependencies[name],
      "Selected direct dependency spec changed",
    );
    assert.equal(edge.rawSpec, reference.policy.dependencies[name]);
    edges.push({
      from: ".",
      name,
      spec: edge.spec,
      type: edge.type,
      to: path.relative(modules, edge.to.target.realpath),
      optionalAbsent: false,
    });
  }
  for (const [name, version] of Object.entries(reference.requiredPackages)) {
    assert(
      [...selected.values()].some(
        (node) => node.package.name === name && node.package.version === version,
      ),
      `Required selected platform package is absent: ${name}@${version}`,
    );
  }
  const packages = [];
  const bins = new Map();
  for (const [root, node] of [...selected].toSorted(([left], [right]) => compare(left, right))) {
    assert(inside(modules, root) && fs.realpathSync(root) === root, "Foreign dependency root");
    assert.equal(node.errors.length, 0, "Native dependency metadata is incomplete");
    assert(!node.inBundle, "Selected bundled dependency needs its owning tarball contract");
    const key = `${node.package.name}@${node.package.version}`;
    const expected = reference.packages[key];
    assert(expected, `Dependency is outside the reviewed reference: ${key}`);
    const integrity = expected.resolution?.integrity;
    assert.match(integrity ?? "", /^sha512-[A-Za-z0-9+/]+={0,2}$/u);
    packages.push({ node, root, key, integrity, location: path.relative(modules, root) });
    const admittedBins = [];
    for (const bin of node.binPaths) {
      if (!inside(modules, bin) || !fs.existsSync(bin)) {
        continue;
      }
      assert(fs.lstatSync(bin).isSymbolicLink(), "Unexpected native bin wrapper");
      // npm maps each normalized bin key to that key's entry, not any other
      // executable in the package. Swapped links must not disappear from proof.
      const entry = node.package.bin?.[path.basename(bin)];
      assert(
        typeof entry === "string" && fs.realpathSync(bin) === path.resolve(root, entry),
        "Native bin link does not select its exact package entry",
      );
      admittedBins.push(bin);
    }
    bins.set(root, admittedBins);
    for (const edge of node.edgesOut.values()) {
      assert(
        !edge.error && !edge.peerConflicted,
        `Invalid native dependency edge: ${key} > ${edge.name}`,
      );
      const requiredVersion = reference.requiredPackages[edge.name];
      if (requiredVersion) {
        assert(
          edge.to?.target.package.name === edge.name &&
            edge.to.target.package.version === requiredVersion,
          "Required platform edge does not resolve from its selected importer",
        );
      }
      if (!edge.to) {
        absentOptional(edge);
      } else {
        assert(selected.has(edge.to.target.realpath), "Native dependency closure is incomplete");
      }
      edges.push({
        from: path.relative(modules, root),
        name: edge.name,
        spec: edge.spec,
        type: edge.type,
        to: edge.to ? path.relative(modules, edge.to.target.realpath) : null,
        optionalAbsent: !edge.to,
      });
    }
  }
  return { packages, edges, selected, bins };
}

function installedPackageContent(node, selected, admittedBins) {
  const rows = capturePackageTree(node.realpath);
  const delegated = [];
  const bins = new Set();
  for (const child of node.children.values()) {
    assert(selected.has(child.target.realpath), "Unqualified nested package placement");
    assert(inside(node.realpath, child.path));
    delegated.push(path.relative(node.realpath, child.path));
    for (const bin of admittedBins.get(child.target.realpath)) {
      if (!inside(node.realpath, bin)) {
        continue;
      }
      bins.add(path.relative(node.realpath, bin));
    }
  }
  // npm owns nested package placement and bin links; each delegated child is
  // independently compared below. All other extra files remain mismatches.
  const boundaries = [...delegated, ...bins];
  return portable(
    rows.filter(
      (row) =>
        !delegated.some(
          (child) => row.path === child || row.path.startsWith(`${child}${path.sep}`),
        ) &&
        !bins.has(row.path) &&
        !(
          row.kind === "directory" &&
          row.path !== "" &&
          boundaries.some((child) => child.startsWith(`${row.path}${path.sep}`))
        ),
    ),
  );
}

/** The caller binds npmCli to the install owner; no registry metadata is needed. */
export async function extractInstalledTerminalCachedPackage({
  npmCli,
  cache,
  integrity,
  directory,
}) {
  const require = createRequire(npmCli);
  const { flatten } = require("@npmcli/config/lib/definitions");
  const cacache = require("cacache");
  const pacote = require("pacote");
  // npm's configured cache root differs from pacote's content-cache path.
  // Read the reviewed SRI directly so absent packument metadata cannot trigger resolution.
  const options = { ...flatten({ cache }), offline: true, ignoreScripts: true, integrity };
  const content = await cacache.get.hasContent(options.cache, integrity);
  assert(content && content.stat.isFile(), "Canonical package content is absent from npm cache");
  assert(content.size <= 32 * 1024 * 1024, "Canonical package archive exceeds 32 MiB");
  const archive = path.join(directory, "package.tgz");
  const unpacked = path.join(directory, "package");
  await cacache.get.copy.byDigest(options.cache, integrity, archive);
  const stat = fs.lstatSync(archive);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 32 * 1024 * 1024);
  assert.equal(stat.size, content.size);
  // cacache's byDigest copy only copies bytes; verify them before extraction.
  const hash = createHash("sha512");
  let count = 0;
  for await (const chunk of fs.createReadStream(archive)) {
    count += chunk.length;
    assert(count <= 32 * 1024 * 1024);
    hash.update(chunk);
  }
  assert.equal(count, stat.size);
  assert.equal(`sha512-${hash.digest("base64")}`, integrity, "Canonical package SRI changed");
  await pacote.extract(archive, unpacked, options);
  return unpacked;
}

/** Run only after install joins, before initialize; no selected package is executed. */
async function attestInstalledTerminalDependencies({ root, npmCli, cache, scratch, reference }) {
  const owner = installedTerminalNpmOwner(npmCli);
  const require = createRequire(owner.cli);
  const Arborist = require("@npmcli/arborist");
  assert.equal(fs.realpathSync(root), root);
  assert.equal(path.basename(path.dirname(root)), "node_modules");
  const modules = path.join(root, "node_modules");
  const before = readInstalledTerminalDependencyTree(modules);
  const manifestBefore = digest(readInput(path.join(root, "package.json")));
  const arb = new Arborist({
    path: path.dirname(path.dirname(root)),
    global: true,
    forceActual: true,
    ignoreScripts: true,
  });
  const tree = await arb.loadActual();
  assert(tree.inventory.size <= 4096, "Native package inventory limit exceeded");
  const application = tree.children.get("openclaw");
  assert(application && application.target.realpath === root && !application.isLink);
  const roots = Object.keys(reference.policy.dependencies).toSorted(compare);
  assert(roots.length > 0 && roots.length <= 32);
  for (const name of roots) {
    assert.match(name, /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/u);
  }
  const direct = `:scope > :is(${roots.map((name) => `[name="${name}"]`).join(",")})`;
  const nodes = await application.querySelectorAll(`${direct}, ${direct} *`, { offline: true });
  const inspected = inspectInstalledTerminalDependencyNodes(application, nodes, roots, reference);
  fs.mkdirSync(scratch, { mode: 0o700 });
  const packages = [];
  for (const entry of inspected.packages) {
    const directory = path.join(scratch, String(packages.length));
    fs.mkdirSync(directory, { mode: 0o700 });
    const unpacked = await extractInstalledTerminalCachedPackage({
      npmCli: owner.cli,
      cache,
      integrity: entry.integrity,
      directory,
    });
    assert(
      !fs.existsSync(path.join(unpacked, "node_modules")),
      "Unreviewed bundled package content",
    );
    const expected = portable(capturePackageTree(unpacked));
    const actual = installedPackageContent(entry.node, inspected.selected, inspected.bins);
    assert.deepEqual(actual, expected, `Installed package content differs: ${entry.key}`);
    packages.push({
      key: entry.key,
      location: entry.location,
      integrity: entry.integrity,
      entries: actual.length,
      contentSha256: digest(JSON.stringify(actual)),
    });
    fs.rmSync(directory, { recursive: true });
  }
  const after = readInstalledTerminalDependencyTree(modules);
  assert.deepEqual(after, before, "Dependency tree changed during attestation");
  assert.equal(digest(readInput(path.join(root, "package.json"))), manifestBefore);
  return { npm: owner, packages, edges: inspected.edges, tree: after };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, npmCli, cache, scratch, referenceFile, output] = process.argv.slice(2);
  try {
    assert.equal(process.platform, "linux");
    assert.equal(process.version, "v24.22.1");
    const bytes = readInput(referenceFile);
    const reference = JSON.parse(bytes);
    const result = await attestInstalledTerminalDependencies({
      root,
      npmCli,
      cache,
      scratch,
      reference,
    });
    const encoded = `${JSON.stringify(result)}\n`;
    assert(Buffer.byteLength(encoded) <= 4 * 1024 * 1024);
    fs.writeFileSync(output, encoded, { mode: 0o600, flag: "wx" });
  } catch (error) {
    process.stderr.write(
      `${String(error).slice(0, 4096)}\n[installed-terminal-dependencies] FAILED (exit 1)\n`,
    );
    process.exitCode = 1;
  }
}
