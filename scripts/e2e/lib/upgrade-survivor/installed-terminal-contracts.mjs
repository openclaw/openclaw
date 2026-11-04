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
  current: "b5ce3884115051d91e715f4d44458442847213843cd52f8dee7a741ac0e74a3c",
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
    entrySha256: "3567231dc54d04a5b8a22df640cfff43f5b202ebd4a772db7f75bb6fdbb075b3",
    sha256: "4f98f670025bac6c3991bdad503319724b7ae10a6518d5ebd7c0b4366e35ee63",
    dynamic: {
      "dist/infra/sqlite-readonly-location.worker.js": {
        sha256: "3567231dc54d04a5b8a22df640cfff43f5b202ebd4a772db7f75bb6fdbb075b3",
        imports: [
          [
            29982,
            30056,
            "./sqlite-readonly-startup-metadata-live-read.worker-qR6iY__p.mjs",
            "dist/infra/sqlite-readonly-startup-metadata-live-read.worker-qR6iY__p.mjs",
          ],
          [
            30143,
            30230,
            "./sqlite-readonly-deferred-plugin-session-transcript-read.worker-CGdhZqwB.mjs",
            "dist/infra/sqlite-readonly-deferred-plugin-session-transcript-read.worker-CGdhZqwB.mjs",
          ],
          [
            30321,
            30402,
            "./sqlite-readonly-agent-delete-session-store-safety.kernel-DaCFk0MH.mjs",
            "dist/infra/sqlite-readonly-agent-delete-session-store-safety.kernel-DaCFk0MH.mjs",
          ],
          [
            30493,
            30558,
            "./sqlite-readonly-sqlite-page-cache.worker-CXR43xtW.mjs",
            "dist/infra/sqlite-readonly-sqlite-page-cache.worker-CXR43xtW.mjs",
          ],
          [
            30634,
            30710,
            "./sqlite-readonly-package-update-activation-immutable-CAPWIInM.mjs",
            "dist/infra/sqlite-readonly-package-update-activation-immutable-CAPWIInM.mjs",
          ],
          [
            37443,
            37511,
            "./sqlite-readonly-sqlite-snapshot-reclamation-DKDr8AXw.mjs",
            "dist/infra/sqlite-readonly-sqlite-snapshot-reclamation-DKDr8AXw.mjs",
          ],
          [
            47433,
            47485,
            "./sqlite-readonly-sqlite-json-C7fKJvoB.mjs",
            "dist/infra/sqlite-readonly-sqlite-json-C7fKJvoB.mjs",
          ],
          [
            47562,
            47625,
            "./sqlite-readonly-sqlite-snapshot-source-CbiWomKB.mjs",
            "dist/infra/sqlite-readonly-sqlite-snapshot-source-CbiWomKB.mjs",
          ],
        ],
      },
      "dist/infra/sqlite-readonly-startup-metadata-live-read.worker-qR6iY__p.mjs": {
        sha256: "d5278adfb366e1acb80ed10f98bb252ce4fb9ba3af5aaa33dd32e23e18a73c80",
        imports: [
          [
            5885,
            5951,
            "./sqlite-readonly-update-run-admission.read-CTz0dcoy.mjs",
            "dist/infra/sqlite-readonly-update-run-admission.read-CTz0dcoy.mjs",
          ],
        ],
      },
    },
  },
  "finalizer-check": {
    entry: "dist/infra/update-migrated-finalize.worker.js",
    entrySha256: "b7781dbb5039c37c3b72bf3f1bea6cd1e13954e3881e953e7a9acdebbb2d1e1c",
    sha256: "4115d02171e53ff4868d36ba117bee8149fa0bd626d01beb878badfb20fb17e3",
    dynamic: {
      "dist/infra/update-migrated-finalize.worker.js": {
        sha256: "b7781dbb5039c37c3b72bf3f1bea6cd1e13954e3881e953e7a9acdebbb2d1e1c",
        imports: [[10739, 10769, "../cli/daemon-cli.js", "dist/cli/daemon-cli.js"]],
      },
    },
  },
  "heartbeat-sqlite": {
    entry: "dist/state/openclaw-state-lease-heartbeat.worker.js",
    entrySha256: "2316d7d37ab745598aa49fcfcdb1d999fc9a75bc510a1d1507001b57f00dd2f8",
    sha256: "c4c7200db2052f13d8cb60bf6e7c76bf5e0323c35010b000b508c5c6a8768c4e",
    // The observed clone-safe SQLite selection excludes the PostgreSQL loader.
    // No nested Worker initiates the GC-profile request/response callback.
    dynamic: {},
  },
};

const schemas = {
  agent: "0dfe3020147043dd0d80ec9c982ef7e8824883e35ba95f6fa75a7ad0cca7a791",
  client: "961a307699f42a614abd5a5abcccf5df3a6d3c1ad660a8c8072372aef856a729",
  daemon: "2ae987e7ab0f92db7c248fc7da3acd6ef80050b52302a037fbaf71f6b3602ba4",
  memory: "ba6a348ded1aa0f141926fa848a0c867bc31eeeab388fda927cdde85e0f34219",
  state: "ba14bfc01da973b6282a55b6dde7cc5465f5fe1b8b9f0ad8c4b44240849ae4fb",
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
