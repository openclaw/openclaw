/**
 * Exact manifest equivalence through the real state-read and mutation workers.
 * Run only outside timing windows, with Node 26.12 and an unused scratch path:
 *   node --import ./scripts/tsx.mjs scripts/perf/local-workspace-manifest-equivalence.ts prepare .local/buf28/equivalence
 *   OPENCLAW_BENCH_BASELINE_DIR=$PWD/.local/buf28/baseline node --import ./scripts/tsx.mjs scripts/perf/local-workspace-manifest-equivalence.ts run .local/buf28/equivalence baseline
 *   node --import ./scripts/tsx.mjs scripts/perf/local-workspace-manifest-equivalence.ts run .local/buf28/equivalence candidate
 *   node --import ./scripts/tsx.mjs scripts/perf/local-workspace-manifest-equivalence.ts compare .local/buf28/equivalence
 * Both sides use the same immutable files and separate synthetic SQLite state.
 * Compare manifest bytes and public root/delta references; storage-only records,
 * fingerprints, preparation batches and compressed mutations intentionally differ.
 * Includes contained and escaping symlinks, and repeats scans after acceptance
 * to exercise each version's persisted stat reuse.
 * Behavioral equivalence is expected to pass on both versions; the companion
 * measurement script supplies the performance regression evidence.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { LocalWorkspaceManifestScan } from "../../src/gateway/worker-environments/local-workspace-manifest-scan.js";
import type { LocalWorkspaceStore } from "../../src/gateway/worker-environments/local-workspace-store.js";

const [mode, scratchArgument, label] = process.argv.slice(2);
assert.ok(["prepare", "run", "compare"].includes(mode ?? "") && scratchArgument);
const scratch = path.resolve(scratchArgument);
process.env.DEVELOPER_DIR = "/Applications/Xcode.app/Contents/Developer";
const baseCommit = "a".repeat(40);
const staged = "media/inbound/openclaw-staged-12345678-1234-4234-8234-123456789abc";
const marker = "# Raw task inputs remain private; copy outputs into the project to publish.\n*\n";
const initial = {
  ".gitignore": "private.txt\n",
  "source.txt": "original\n",
  "delete.txt": "old\n",
};
type Files = Record<string, string>;
type Fixture = {
  name: string;
  before: Files;
  after: Files;
  hostOnly?: Files;
  hostUntracked?: Files;
  beforeLinks?: Files;
  afterLinks?: Files;
  escapingLinks?: Files;
};
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const byPath = <T extends { path: string }>(a: T, b: T) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
const filesFor = (fixture: Fixture, target: "canonical" | "projection") =>
  path.join(scratch, "files", fixture.name, target);
function document(files: Files, links: Files = {}) {
  const directories = new Set<string>();
  const entries = [
    ...Object.entries(files).map(([entryPath, content]) => ({
      path: entryPath,
      type: "file" as const,
      mode: 0o644,
      size: Buffer.byteLength(content),
      sha256: digest(content),
    })),
    ...Object.entries(links).map(([entryPath, target]) => ({
      path: entryPath,
      type: "symlink" as const,
      mode: 0o777,
      target,
    })),
  ];
  for (const entry of entries) {
    let parent = path.posix.dirname(entry.path);
    while (parent !== ".") {
      directories.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  // Independent expected wire bytes: directories have mode 0700, files 0644,
  // and canonical JSON uses path order with directories in the entries array.
  return JSON.stringify({
    version: 1,
    baseCommit,
    entries: [
      ...[...directories].map((entryPath) => ({ path: entryPath, type: "directory", mode: 0o700 })),
      ...entries,
    ].toSorted(byPath),
  });
}
function scanForComparison(value: LocalWorkspaceManifestScan) {
  return {
    previousRoot: value.previousRoot,
    resultingRoot: value.resultingRoot,
    baseManifestRaw: value.baseManifestRaw,
    baseManifestRef: value.baseManifestRef,
    currentManifestRaw: value.currentManifestRaw,
    currentManifestRef: value.currentManifestRef,
    buildCacheInputs: value.buildCacheInputs,
  };
}
type ProjectionSeed = Parameters<LocalWorkspaceStore["create"]>[0];
type LegacyProjectionSeed = Omit<
  ProjectionSeed,
  "tree_root_digest" | "source_paths_digest" | "canonical_fingerprints" | "projection_fingerprints"
>;
const edited = { ...initial, "source.txt": "modified\n" };
const addedRemoved = {
  ".gitignore": initial[".gitignore"],
  "source.txt": initial["source.txt"],
  "added.txt": "added\n",
};
const stagedFiles = {
  ...initial,
  [`${staged}/.gitignore`]: marker,
  [`${staged}/node_modules/input.txt`]: "first input\n",
};
const stagedEdited = { ...stagedFiles, [`${staged}/node_modules/input.txt`]: "edited input\n" };
const fixtures: Fixture[] = [
  { name: "unchanged", before: initial, after: initial },
  { name: "edited", before: initial, after: edited },
  { name: "added-removed", before: initial, after: addedRemoved },
  { name: "staged-created", before: initial, after: stagedFiles },
  { name: "staged-edited", before: stagedFiles, after: stagedEdited },
  {
    name: "gitignore-host-index",
    before: initial,
    after: { ...initial, ".gitignore": "" },
    hostOnly: { "admitted.txt": "host-index input\n" },
    hostUntracked: { "private.txt": "host-only untracked\n" },
  },
  {
    name: "symlinks",
    before: initial,
    after: initial,
    beforeLinks: { link: "delete.txt" },
    afterLinks: {
      link: "source.txt",
      "nested/up": "../source.txt",
      dangling: "missing.txt",
    },
    escapingLinks: { escape: "../outside.txt" },
  },
];

if (mode === "prepare") {
  await fs.mkdir(scratch);
  for (const fixture of fixtures) {
    for (const target of ["canonical", "projection"] as const) {
      const root = filesFor(fixture, target);
      await fs.mkdir(root, { recursive: true });
      const files =
        target === "projection"
          ? fixture.after
          : {
              ...fixture.after,
              ...fixture.hostOnly,
              ...fixture.hostUntracked,
            };
      for (const [entryPath, content] of Object.entries(files)) {
        const filename = path.join(root, entryPath);
        await fs.mkdir(path.dirname(filename), { recursive: true });
        await fs.writeFile(filename, content, { mode: 0o644 });
      }
      const links = { ...fixture.afterLinks, ...fixture.escapingLinks };
      for (const [entryPath, destination] of Object.entries(links)) {
        const filename = path.join(root, entryPath);
        await fs.mkdir(path.dirname(filename), { recursive: true });
        await fs.symlink(destination, filename);
      }
      if (target === "canonical") {
        execFileSync("git", ["init", "--quiet", root]);
        execFileSync("git", [
          "-C",
          root,
          "add",
          "--force",
          "--",
          ...Object.keys({ ...fixture.after, ...fixture.hostOnly, ...links }),
        ]);
      }
    }
  }
  console.log(JSON.stringify({ prepared: fixtures.map((fixture) => fixture.name) }));
} else if (mode === "compare") {
  const baseline = JSON.parse(await fs.readFile(path.join(scratch, "baseline.json"), "utf8"));
  const candidate = JSON.parse(await fs.readFile(path.join(scratch, "candidate.json"), "utf8"));
  assert.deepEqual(candidate, baseline);
  console.log(
    JSON.stringify({
      equivalent: true,
      cases: candidate.length,
      actionsPerCase: [
        "scan",
        "materialize",
        "scan with accepted stat hints",
        "replace",
        "materialize after replace",
      ],
    }),
  );
} else {
  assert.ok(label === "baseline" || label === "candidate");
  const state = path.join(scratch, label);
  assert.equal(await fs.stat(state).catch(() => null), null, "run requires unused side state");
  const env = {
    PATH: process.env.PATH,
    HOME: path.join(state, "home"),
    OPENCLAW_HOME: path.join(state, "home"),
    OPENCLAW_STATE_DIR: path.join(state, "state"),
    OPENCLAW_CONFIG_PATH: path.join(state, "config.json"),
    TMPDIR: path.join(state, "tmp"),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  };
  Object.assign(process.env, env, { DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer" });
  for (const directory of [env.HOME, env.TMPDIR]) {
    await fs.mkdir(directory, { recursive: true });
  }
  if (label === "baseline") {
    assert.ok(process.env.OPENCLAW_BENCH_BASELINE_DIR, "baseline source overlay is required");
    await import("./worker-retained-heap-preload.js");
  } else {
    assert.equal(
      process.env.OPENCLAW_BENCH_BASELINE_DIR,
      undefined,
      "candidate must use current source",
    );
  }
  const { openOpenClawStateDatabase, closeOpenClawStateDatabaseAsync } =
    await import("../../src/state/openclaw-state-db.js");
  const { withLocalWorkspaceStore } =
    await import("../../src/gateway/worker-environments/local-workspace-store.js");
  const { drainGlobalSingletonLifecycleState } =
    await import("../../src/shared/global-singleton.js");
  openOpenClawStateDatabase({ env });
  const outputs: unknown[] = [];
  try {
    for (const fixture of fixtures) {
      for (const target of ["canonical", "projection"] as const) {
        const id = `${fixture.name}-${target}`;
        const expectedRaw = document(
          target === "canonical"
            ? fixture.after
            : {
                ...fixture.after,
                ...fixture.hostOnly,
              },
          fixture.afterLinks,
        );
        const result = await withLocalWorkspaceStore({ worktreeId: id, env }, async (store) => {
          const rawManifest = document(fixture.before, fixture.beforeLinks);
          const baseline = {
            rawManifest,
            manifestRef: `sha256:${digest(rawManifest)}`,
            buildCacheInputs: [],
          };
          const row: LegacyProjectionSeed = {
            worktree_id: id,
            agent_id: "main",
            session_key: "agent:main:synthetic",
            session_id: "synthetic",
            lifecycle_revision: null,
            projection_path: filesFor(fixture, "projection"),
            base_commit: baseCommit,
            source_paths_json: JSON.stringify(
              Object.keys({ ...fixture.before, ...fixture.beforeLinks }),
            ),
            baseline_json: null,
            baseline_ref: null,
            checkpoint_json: null,
            pending_ref: null,
            pending_target: null,
            journal_json: null,
            journal_pack: null,
            paused_runtimes_json: null,
            created_at_ms: 1,
          };
          // The explicit historical overlay supplies the v31 create contract, without CAS columns.
          const createLegacy = store.create as (
            row: LegacyProjectionSeed,
          ) => ReturnType<LocalWorkspaceStore["create"]>;
          const created =
            label === "baseline"
              ? await createLegacy(row)
              : await store.create({
                  ...row,
                  tree_root_digest: null,
                  source_paths_digest: null,
                  canonical_fingerprints: null,
                  projection_fingerprints: null,
                });
          await store.update(created, {}, undefined, baseline);
          const scanned = await store.manifest(store.get()!, {
            kind: "scan",
            target,
            canonicalRoot: filesFor(fixture, "canonical"),
          });
          assert.ok(scanned.kind === "scan");
          if (scanned.observation) {
            await store.accept(scanned.observation);
          }
          await store.update(store.get()!, {}, undefined, scanned);
          if (label === "candidate") {
            assert.ok(scanned.treeRoot, `${id}: scan omitted its immutable root`);
            assert.equal(
              Buffer.from(store.get()!.tree_root_digest!).toString("hex"),
              scanned.treeRoot.slice("sha256:".length),
              `${id}: acceptance did not publish its tree root`,
            );
            const fingerprints =
              target === "canonical"
                ? store.get()!.projection_fingerprints
                : store.get()!.canonical_fingerprints;
            assert.ok(fingerprints, `${id}: acceptance omitted its target fingerprints`);
          }
          const accepted = await store.manifest(store.get()!, { kind: "materialize" });
          assert.ok(accepted.kind === "materialize");
          assert.equal(accepted.rawManifest, expectedRaw, `${id}: accepted file inventory differs`);
          assert.equal(accepted.manifestRef, `sha256:${digest(expectedRaw)}`);
          const reused = await store.manifest(store.get()!, {
            kind: "scan",
            target,
            canonicalRoot: filesFor(fixture, "canonical"),
          });
          assert.ok(reused.kind === "scan");
          assert.equal(reused.resultingRoot, scanned.resultingRoot, `${id}: repeat root differs`);
          assert.deepEqual(reused.records, [], `${id}: repeat scan changes records`);
          assert.deepEqual(reused.removed, [], `${id}: repeat scan removes records`);
          assert.equal(reused.observation, undefined, `${id}: repeat scan changes stat hints`);
          assert.equal(
            reused.currentManifestRaw,
            reused.baseManifestRaw,
            `${id}: repeat scan reports a content delta`,
          );
          const replacement = await store.manifest(store.get()!, {
            kind: "replace",
            rawManifest: accepted.rawManifest,
            manifestRef: accepted.manifestRef,
            buildCacheInputs: [],
            patch: {},
          });
          assert.ok(replacement.kind === "replace");
          await store.accept(replacement.update);
          assert.equal(
            store.get()!.baseline_ref,
            scanned.resultingRoot,
            `${id}: replace changes accepted root`,
          );
          const replacementRoot = store.get()!.baseline_ref;
          const replaced = await store.manifest(store.get()!, { kind: "materialize" });
          assert.deepEqual(
            replaced,
            accepted,
            `${id}: replacing the accepted manifest changes its bytes`,
          );
          await store.delete(store.get()!);
          return {
            id,
            scan: scanForComparison(scanned),
            reusedScan: scanForComparison(reused),
            accepted,
            replacement: {
              resultingRoot: replacementRoot,
            },
          };
        });
        outputs.push(result);
      }
    }
    await fs.writeFile(path.join(scratch, `${label}.json`), JSON.stringify(outputs, null, 2));
    console.log(JSON.stringify({ label, verified: outputs.length }));
  } finally {
    await closeOpenClawStateDatabaseAsync();
    await drainGlobalSingletonLifecycleState();
  }
}
