// Source-bound admission for the three intentionally uninstrumented helper modes.
// Keep tooling imports inside the host preparation function: the bare preload has
// no application dependencies and must not initialize a second product runtime.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { capturePackageTree, fileIdentity } from "./installed-recovery-observations.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const ordered = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const inside = (root, file) => file === root || file.startsWith(`${root}${path.sep}`);
const inputLimit = 32 * 1024 * 1024;
const fileLimit = 4 * 1024 * 1024;
const references = {
  current: "9bdbd59d6ad656ac4f6a6a44bed09ff41c86f2e2ead4cd0ba867ae84e463ddb8",
  historical: "5f2cc18f26292c6bcaf0cdaad22e25a872814865540d7e3a1311287b6812bca2",
};

// The host uses the canonical serializer; bare consumers hash those exact
// bytes, without loading lockfile tooling or trusting a freshly generated set.
export function readInstalledTerminalReference(role, encoded) {
  assert(Object.hasOwn(references, role));
  assert(typeof encoded === "string" && Buffer.byteLength(encoded) <= fileLimit);
  assert.equal(digest(encoded), references[role], "Unreviewed dependency reference");
  return JSON.parse(encoded);
}

// Reviewed emitted initialization and selected-call closures. These hashes are
// independent of carrier commits, fixture versions and unrelated UI/doc changes.
// A changed closure requires its source/dependency contract to be reviewed again.
const applications = {
  "sqlite-session": {
    entry: "dist/infra/sqlite-readonly-location.worker.js",
    entrySha256: "5c16ca8779c8cde25489941929a6081e50d4740c3c64b3f83ada314d7a58463f",
    sha256: "fabbcce4d6a766ffb247c1841c5fce8686e0330dc9e6426e602577555b1d1919",
    dynamic: {
      "dist/infra/sqlite-readonly-location.worker.js": {
        sha256: "5c16ca8779c8cde25489941929a6081e50d4740c3c64b3f83ada314d7a58463f",
        imports: [
          [
            98914,
            98988,
            "./sqlite-readonly-startup-metadata-live-read.worker-CAJEdt3q.mjs",
            "dist/infra/sqlite-readonly-startup-metadata-live-read.worker-CAJEdt3q.mjs",
          ],
          [
            99056,
            99143,
            "./sqlite-readonly-deferred-plugin-session-transcript-read.worker-Cw7_aWor.mjs",
            "dist/infra/sqlite-readonly-deferred-plugin-session-transcript-read.worker-Cw7_aWor.mjs",
          ],
          [
            99215,
            99296,
            "./sqlite-readonly-agent-delete-session-store-safety.kernel-Da09ux9g.mjs",
            "dist/infra/sqlite-readonly-agent-delete-session-store-safety.kernel-Da09ux9g.mjs",
          ],
          [
            99368,
            99433,
            "./sqlite-readonly-sqlite-page-cache.worker-Ddqve58B.mjs",
            "dist/infra/sqlite-readonly-sqlite-page-cache.worker-Ddqve58B.mjs",
          ],
          [
            99487,
            99559,
            "./sqlite-readonly-database-store-live-read.worker-Co9UaQzp.mjs",
            "dist/infra/sqlite-readonly-database-store-live-read.worker-Co9UaQzp.mjs",
          ],
          [
            99624,
            99700,
            "./sqlite-readonly-package-update-activation-immutable-DXhVRmP9.mjs",
            "dist/infra/sqlite-readonly-package-update-activation-immutable-DXhVRmP9.mjs",
          ],
          [
            105451,
            105519,
            "./sqlite-readonly-sqlite-snapshot-reclamation-DAzt4H0P.mjs",
            "dist/infra/sqlite-readonly-sqlite-snapshot-reclamation-DAzt4H0P.mjs",
          ],
          [
            110897,
            110949,
            "./sqlite-readonly-sqlite-json-BhVyM1Oj.mjs",
            "dist/infra/sqlite-readonly-sqlite-json-BhVyM1Oj.mjs",
          ],
          [
            110985,
            111048,
            "./sqlite-readonly-sqlite-snapshot-source-CVNc0uNZ.mjs",
            "dist/infra/sqlite-readonly-sqlite-snapshot-source-CVNc0uNZ.mjs",
          ],
        ],
      },
      "dist/infra/sqlite-readonly-startup-metadata-live-read.worker-CAJEdt3q.mjs": {
        sha256: "b80ae06a479949d8acd271739d6dd50123de2f2b14bd50759aa8758a1ecd8202",
        imports: [
          [
            2377,
            2443,
            "./sqlite-readonly-update-run-admission.read-BdB3R_Js.mjs",
            "dist/infra/sqlite-readonly-update-run-admission.read-BdB3R_Js.mjs",
          ],
        ],
      },
    },
  },
  "finalizer-check": {
    entry: "dist/infra/update-migrated-finalize.worker.js",
    entrySha256: "52196123897b02870b98e8c79d56b0ff18ed254b92b77ad148b5ea77128264ad",
    sha256: "7b1985377b286bb4c8225452a4a07a4965053d3b6f86c6cd55caacce91c3ef5f",
    dynamic: {
      "dist/infra/update-migrated-finalize.worker.js": {
        sha256: "52196123897b02870b98e8c79d56b0ff18ed254b92b77ad148b5ea77128264ad",
        imports: [[10616, 10646, "../cli/daemon-cli.js", "dist/cli/daemon-cli.js"]],
      },
    },
  },
  "heartbeat-sqlite": {
    entry: "dist/state/openclaw-state-lease-heartbeat.worker.js",
    entrySha256: "bd7e064434e6eb9b52823a6eaf6a661100f91673723d791cd3d687a5d447b8f4",
    sha256: "1d7c31ab2801102a9f14f64526052d47f719bcabbab431f6f08950f395b4a7d5",
    // The observed clone-safe SQLite selection excludes the PostgreSQL loader.
    // No nested Worker initiates the GC-profile request/response callback.
    dynamic: {},
  },
};

const schemas = {
  agent: "2fe012a21b77e818eafab3b7a31d2be2cc822c7852475f42ea18e9105a32a18f",
  client: "961a307699f42a614abd5a5abcccf5df3a6d3c1ad660a8c8072372aef856a729",
  daemon: "2ae987e7ab0f92db7c248fc7da3acd6ef80050b52302a037fbaf71f6b3602ba4",
  memory: "ba6a348ded1aa0f141926fa848a0c867bc31eeeab388fda927cdde85e0f34219",
  state: "6a298f4a1a48e121652d13c4bb562b8e201b5d94e3538c68c171381ecaf58f1c",
};

/** Rebind host-prepared code identities to each stamped application's inventory. */
export function assertInstalledTerminalApplication(identity, prepared) {
  const roles = {};
  for (const [role, contract] of Object.entries(applications)) {
    const files = prepared.roles[role].files;
    assert(Array.isArray(files) && files.length <= 4096);
    assert.equal(digest(JSON.stringify(files)), contract.sha256, `Unreviewed ${role} closure`);
    assert.equal(identity.files[contract.entry]?.sha256, contract.entrySha256);
    for (const [file, size, sha256] of files) {
      assert.deepEqual(identity.files[file], { size, sha256 }, "Application closure changed");
    }
    roles[role] = contract.sha256;
  }
  assert.equal(prepared.assets.length, Object.keys(schemas).length);
  for (const [name, sha256] of Object.entries(schemas)) {
    const file = `dist/assets/sqlite-schema/sqlite-${name}-catalogs.json`;
    const asset = prepared.assets.find(([relative]) => relative === file);
    assert(asset && asset[2] === sha256);
    assert.deepEqual(identity.files[file], { size: asset[1], sha256 });
  }
  return { roles, assetsSha256: digest(JSON.stringify(prepared.assets)) };
}

/** Compare independent installs by content; physical custody stays in the receipt. */
export function readInstalledTerminalDependencyTree(root) {
  assert.equal(fs.realpathSync(root), root, "Dependency root must be physical");
  assert(fs.lstatSync(root).isDirectory(), "Dependency root must be a directory");
  const identity = fileIdentity(root);
  const rows = capturePackageTree(root);
  const content = rows.map((row) => {
    if (row.kind === "link") {
      const link = path.join(root, row.path);
      assert(
        inside(root, path.resolve(path.dirname(link), row.content)),
        "Dependency link leaves its admitted tree before resolving",
      );
      assert(inside(root, fs.realpathSync(link)), "Dependency link escapes its admitted tree");
    }
    return [row.path, row.kind, row.mode, row.content];
  });
  assert.equal(fileIdentity(root), identity, "Dependency root changed during capture");
  return { identity, entries: rows.length, sha256: digest(JSON.stringify(content)) };
}

/** First-main checkpoint: a separately reified stage must match qualified bytes. */
export function assertInstalledTerminalDependencyTree(root, expected) {
  const actual = readInstalledTerminalDependencyTree(path.join(root, "node_modules"));
  assert.equal(actual.entries, expected.entries, "Staged dependency tree changed");
  assert.equal(actual.sha256, expected.sha256, "Staged dependency tree changed");
  return actual;
}

/** Package metadata is consumed during VERSION initialization, not omitted code. */
export function readInstalledTerminalMetadata(root, identity) {
  const files = {};
  const contents = {};
  // Exact VERSION and loaded-commit candidates in the three emitted root depths.
  // An earlier foreign candidate must not override the tarball's provenance.
  for (const relative of [
    "package.json",
    "dist/package.json",
    "dist/infra/package.json",
    "dist/state/package.json",
    "../package.json",
    "../../package.json",
    "dist/build-info.json",
    "dist/infra/build-info.json",
    "dist/state/build-info.json",
    "build-info.json",
    "../build-info.json",
    ".buildstamp",
    ".runtime-postbuildstamp",
    "dist/.buildstamp",
    "dist/.runtime-postbuildstamp",
    "dist/infra/.buildstamp",
    "dist/infra/.runtime-postbuildstamp",
    "dist/state/.buildstamp",
    "dist/state/.runtime-postbuildstamp",
  ]) {
    const file = path.resolve(root, relative);
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      files[relative] = null;
      continue;
    }
    assert(inside(root, file) && identity.files[relative], "Uninventoried version metadata");
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= fileLimit);
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.length, stat.size);
    assert.equal(digest(bytes), identity.files[relative].sha256);
    files[relative] = digest(bytes);
    contents[relative] = bytes;
  }
  const manifest = JSON.parse(contents["package.json"].toString("utf8"));
  const build = JSON.parse(contents["dist/build-info.json"].toString("utf8"));
  assert.equal(manifest.name, "openclaw");
  assert.equal(manifest.version, identity.version);
  assert.deepEqual(build, identity.buildInfo);
  return { version: manifest.version, build, files };
}

/** Host-only: the established packaging parser supplies edges, never a new resolver. */
export async function prepareInstalledTerminalApplication(root, identity) {
  const { collectPackageDistImports } = await import("../../../lib/package-dist-imports.mjs");
  let bytesRead = 0;
  const sources = new Map();
  const read = (relative) => {
    if (sources.has(relative)) {
      return sources.get(relative);
    }
    const expected = identity.files[relative];
    assert(expected && !expected.symlink, "Missing regular application contract input");
    const file = path.resolve(root, relative);
    assert(inside(root, file) && fs.realpathSync(file) === file);
    const stat = fs.lstatSync(file);
    assert(stat.isFile() && stat.size <= fileLimit && sources.size < 4096);
    bytesRead += stat.size;
    assert(bytesRead <= inputLimit, "Application contract input limit exceeded");
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.length, expected.size);
    assert.equal(digest(bytes), expected.sha256);
    const source = bytes.toString("utf8");
    assert(bytes.equals(Buffer.from(source)), "Application source is not exact UTF-8");
    sources.set(relative, source);
    return source;
  };
  const roles = {};
  for (const [role, contract] of Object.entries(applications)) {
    assert.equal(identity.files[contract.entry]?.sha256, contract.entrySha256);
    const pending = [contract.entry];
    const selected = new Set();
    while (pending.length) {
      const file = pending.pop();
      if (selected.has(file)) {
        continue;
      }
      selected.add(file);
      const calls = contract.dynamic[file];
      if (calls) {
        assert.equal(identity.files[file]?.sha256, calls.sha256, "Selected importer changed");
      }
      const observedCalls = new Set();
      collectPackageDistImports({
        files: [file],
        packageJsons: new Map([["package.json", read("package.json")]]),
        readText: read,
        onImportOccurrence(occurrence) {
          const eager = ["static-import", "static-export"].includes(occurrence.kind);
          const selectedCall = calls?.imports.find(([start]) => start === occurrence.start);
          if (selectedCall) {
            assert.deepEqual(
              [occurrence.kind, occurrence.end, occurrence.specifier, occurrence.importedPath],
              ["dynamic-import", ...selectedCall.slice(1)],
              "Selected dynamic edge changed",
            );
            observedCalls.add(occurrence.start);
          }
          if ((eager || selectedCall) && occurrence.importedPath) {
            pending.push(occurrence.importedPath);
          }
        },
      });
      assert.equal(observedCalls.size, calls?.imports.length ?? 0, "Selected call is absent");
    }
    assert(Object.keys(contract.dynamic).every((file) => selected.has(file)));
    const files = [...selected]
      .toSorted(ordered)
      .map((file) => [file, identity.files[file].size, identity.files[file].sha256]);
    assert.equal(digest(JSON.stringify(files)), contract.sha256, `Unreviewed ${role} closure`);
    roles[role] = { sha256: contract.sha256, files };
  }
  const assets = Object.entries(schemas).map(([name, sha256]) => {
    const relative = `dist/assets/sqlite-schema/sqlite-${name}-catalogs.json`;
    read(relative);
    assert.equal(identity.files[relative].sha256, sha256);
    return [relative, identity.files[relative].size, sha256];
  });
  return { roles, assets, metadata: readInstalledTerminalMetadata(root, identity) };
}
