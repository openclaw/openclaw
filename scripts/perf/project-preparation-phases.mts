// node --import ./scripts/tsx.mjs scripts/perf/project-preparation-phases.mts <scratch-root> <baseline-checkout>
// Five counterbalanced A-to-B refresh pairs, real owner modules and warm local disk.
// Content-stream/Git observers leave decisions intact; manifest clocks advance past
// the ctime safety window without sleeps. Incoming object bytes are not wire bytes.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as candidate from "../../src/gateway/worker-environments/project-preparation.js";

assert(process.argv[2] && process.argv[3], "Supply scratch root and pinned baseline checkout");
const baselineRoot = fs.realpathSync(process.argv[3]);
const baseline: typeof candidate = await import(
  pathToFileURL(path.join(baselineRoot, "src/gateway/worker-environments/project-preparation.ts"))
    .href
);
const owners = { baseline, candidate };
type Variant = keyof typeof owners;
type Event = {
  kind: "manifest" | "transfer" | "fsck";
  tree: "seed" | "workspace";
  hashes?: number;
  files?: number;
  bytes?: number;
  objects?: number;
};
const root = fs.realpathSync(fs.mkdtempSync(path.join(path.resolve(process.argv[2]), "phases-")));
const repository = path.join(root, "repository");
const bin = path.join(root, "bin");
fs.mkdirSync(repository);
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
const env = {
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: "1",
};
const gitAt = (directory: string, ...args: string[]) =>
  execFileSync("git", ["-C", directory, ...args], { env, encoding: "utf8" }).trim();
const git = (...args: string[]) => gitAt(repository, ...args);
git("init", "--quiet");
git("config", "user.name", "Preparation Benchmark");
git("config", "user.email", "benchmark@example.invalid");
git("config", "commit.gpgsign", "false");
fs.mkdirSync(path.join(repository, ".openclaw"));
fs.writeFileSync(path.join(repository, ".gitignore"), "node_modules/\n");
fs.writeFileSync(
  path.join(repository, ".openclaw/worktree-setup.sh"),
  "#!/bin/sh\nmkdir -p node_modules/cache\nprintf cached > node_modules/cache/input\n",
  { mode: 0o755 },
);
for (let i = 0; i < 1_000; i++) {
  fs.writeFileSync(path.join(repository, `${i}.txt`), randomBytes(32 * 1024));
}
git("add", ".");
git("commit", "--quiet", "-m", "A");
const projectA = { key: "a".repeat(64), root: repository, baseCommit: git("rev-parse", "HEAD") };
const eventsFile = path.join(root, "events.jsonl");
const observer = path.join(root, "observer.cjs");
fs.writeFileSync(
  observer,
  `
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const emit = (value) => fs.appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify(value) + "\\n");
const tree = (root) => root.endsWith("/workspace") ? "workspace" : "seed";
const inventory = (root) => {
  const result = new Map(), objects = path.join(root, ".git", "objects");
  if (!fs.existsSync(objects)) return result;
  for (const directory of fs.readdirSync(objects)) {
    if (!/^(pack|[a-f0-9]{2})$/.test(directory)) continue;
    for (const name of fs.readdirSync(path.join(objects, directory))) {
      if (directory === "pack" && !name.endsWith(".pack")) continue;
      const file = path.join(objects, directory, name), stat = fs.statSync(file);
      let count = 1;
      if (directory === "pack") {
        const idx = fs.readFileSync(file.replace(/\\.pack$/, ".idx"));
        count = idx.readUInt32BE((idx.readUInt32BE(0) === 0xff744f63 ? 8 : 0) + 255 * 4);
      }
      result.set(file, { bytes: stat.size, objects: count });
    }
  }
  return result;
};
const spawn = cp.spawnSync;
cp.spawnSync = (command, args, options) => {
  if (command === process.execPath) args = ["--require", __filename, ...args];
  const rootIndex = command === "git" ? args.indexOf("-C") : -1;
  const root = rootIndex >= 0 ? args[rootIndex + 1] : undefined;
  const transfer = root && (args.includes("fetch") || args.includes("index-pack"));
  const before = transfer && inventory(root);
  const result = spawn(command, args, options);
  if (root && args.includes("fsck")) emit({ kind: "fsck", tree: tree(root) });
  if (transfer) {
    const added = [...inventory(root)].filter(([file]) => !before.has(file)).map(([, value]) => value);
    emit({ kind: "transfer", tree: tree(root), objects: added.reduce((sum, row) => sum + row.objects, 0), bytes: added.reduce((sum, row) => sum + row.bytes, 0) });
  }
  return result;
};
if (process.argv.includes("eligible")) {
  Date.now = () => ${Date.now() + 3_600_000};
  let files = 0, hashes = 0;
  const open = fs.promises.open;
  fs.promises.open = async (...args) => {
    const handle = await open(...args), stream = handle.createReadStream.bind(handle);
    files++;
    handle.createReadStream = (...args) => { hashes++; return stream(...args); };
    return handle;
  };
  process.once("exit", () => emit({ kind: "manifest", tree: tree(process.argv[1]), files, hashes }));
}
`,
);

async function prepare(home: string, project: typeof projectA, variant: Variant) {
  fs.writeFileSync(eventsFile, "");
  const run = async (script: string) => {
    const result = spawnSync(
      "sh",
      ["-c", script.replace(/node <<'PROJECT_/g, `node --require '${observer}' <<'PROJECT_`)],
      {
        env: { ...env, HOME: home },
        encoding: "utf8",
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const recipe = await owners[variant].readWorkerProjectEnvironmentRecipe(project);
  const operation = owners[variant].createWorkerProjectPreparation({
    project,
    namespace: "benchmark",
    requireCurrent: () => {},
    setupAuthorized: true,
    preparation: {
      key: "b".repeat(64),
      cacheKey: "c".repeat(64),
      purpose: "session",
      demandAtMs: 1,
      recipe,
      setupRecipe: recipe.identity,
    },
  });
  let uploadedBytes = 0;
  const started = performance.now();
  try {
    const result = await operation.project.prepare({
      runScript: run,
      runScriptWithBudget: (create) => run(create(120_000)),
      upload: async (source, destination) => {
        uploadedBytes += fs.statSync(source).size;
        fs.copyFileSync(source, destination);
      },
    });
    const ms = performance.now() - started;
    const events = fs
      .readFileSync(eventsFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Event);
    return {
      ms,
      uploadedBytes,
      phases: result.recipePreparation!.phaseDurationsMs!,
      workspace: result.preparedWorkspace!,
      events,
    };
  } finally {
    operation.close();
  }
}

// Preparing independent homes keeps the original inode/stat identities intact.
const prepared = new Map<string, Awaited<ReturnType<typeof prepare>>>();
for (let sample = 0; sample < 5; sample++) {
  for (const variant of ["baseline", "candidate"] as const) {
    const home = path.join(root, `${variant}-${sample}`);
    fs.mkdirSync(home);
    prepared.set(home, await prepare(home, projectA, variant));
  }
}
fs.writeFileSync(path.join(repository, "changed.txt"), "B\n");
git("add", ".");
git("commit", "--quiet", "-m", "B");
const projectB = { ...projectA, baseCommit: git("rev-parse", "HEAD") };
// file:// runs upload-pack negotiation, unlike a local clone's hard-link shortcut.
const publicFetch = path.join(root, "public-fetch");
fs.mkdirSync(publicFetch);
gitAt(publicFetch, "init", "--quiet");
gitAt(publicFetch, "config", "gc.auto", "0");
gitAt(publicFetch, "config", "maintenance.auto", "false");
const fetch = (directory: string, commit: string, retained = false) =>
  gitAt(
    directory,
    "-c",
    "fetch.fsckObjects=true",
    "-c",
    "fetch.unpackLimit=0",
    "fetch",
    "--depth=1",
    "--no-tags",
    "--no-write-fetch-head",
    "--no-recurse-submodules",
    ...(retained ? ["--negotiation-tip=HEAD"] : []),
    pathToFileURL(repository).href,
    commit,
  );
const packStats = (directory: string) =>
  fs
    .readdirSync(path.join(directory, ".git/objects/pack"))
    .filter((name) => name.endsWith(".pack"))
    .map((name) => {
      const file = path.join(directory, ".git/objects/pack", name);
      const index = fs.readFileSync(file.replace(/\.pack$/, ".idx"));
      return { name, bytes: fs.statSync(file).size, objects: index.readUInt32BE(8 + 255 * 4) };
    });
fetch(publicFetch, projectA.baseCommit);
gitAt(publicFetch, "checkout", "--detach", "--force", projectA.baseCommit);
const fullPacks = packStats(publicFetch);
const publicWithoutTip = path.join(root, "public-fetch-without-tip");
fs.mkdirSync(publicWithoutTip);
fs.cpSync(path.join(publicFetch, ".git"), path.join(publicWithoutTip, ".git"), {
  recursive: true,
  mode: fs.constants.COPYFILE_FICLONE,
});
fetch(publicWithoutTip, projectB.baseCommit);
fetch(publicFetch, projectB.baseCommit, true);
const addedPacks = (directory: string) =>
  packStats(directory).filter((pack) => !fullPacks.some((old) => old.name === pack.name));
const deltaPacks = addedPacks(publicFetch);
const publicTransport = {
  negotiationTip: "HEAD",
  full: fullPacks,
  withoutTip: addedPacks(publicWithoutTip),
  delta: deltaPacks,
};
assert(
  deltaPacks.reduce((sum, pack) => sum + pack.bytes, 0) <
    fullPacks.reduce((sum, pack) => sum + pack.bytes, 0) / 100,
  JSON.stringify(publicTransport),
);
const seedPath = (home: string) => path.join(home, ".openclaw-worker/git-seeds/benchmark");
const seed = (home: string) =>
  fs
    .readdirSync(seedPath(home))
    .filter((name) => /^[a-f0-9]{64}$/.test(name))
    .map((name) => path.join(seedPath(home), name));
type Row = Awaited<ReturnType<typeof prepare>> & {
  seedInodePreserved: boolean;
  workspaceInodePreserved: boolean;
};
const samples: Record<Variant, Row[]> = { baseline: [], candidate: [] };
for (let sample = 0; sample < 5; sample++) {
  for (const variant of (sample % 2
    ? ["candidate", "baseline"]
    : ["baseline", "candidate"]) as Variant[]) {
    const home = path.join(root, `${variant}-${sample}`),
      previous = prepared.get(home)!;
    const seedInode = fs.statSync(path.join(seed(home)[0]!, "0.txt")).ino;
    const workspaceInode = fs.statSync(path.join(previous.workspace.workspaceDir, "0.txt")).ino;
    const row = await prepare(home, projectB, variant);
    const currentSeed = seed(home).find(
      (directory) => gitAt(directory, "rev-parse", "HEAD") === projectB.baseCommit,
    )!;
    gitAt(row.workspace.workspaceDir, "diff-files", "--quiet");
    gitAt(currentSeed, "diff-files", "--quiet");
    samples[variant].push({
      ...row,
      seedInodePreserved: fs.statSync(path.join(currentSeed, "0.txt")).ino === seedInode,
      workspaceInodePreserved:
        fs.statSync(path.join(row.workspace.workspaceDir, "0.txt")).ino === workspaceInode,
    });
    fs.appendFileSync(
      path.join(root, "refresh-samples.jsonl"),
      JSON.stringify({ variant, sample, ...samples[variant].at(-1) }) + "\n",
    );
  }
}
assert.equal(
  new Set(
    Object.values(samples)
      .flat()
      .map((row) => row.workspace.sourceManifestRef),
  ).size,
  1,
);
assert.equal(
  new Set(
    Object.values(samples)
      .flat()
      .map((row) => row.workspace.preparedManifestRef),
  ).size,
  1,
);
assert(samples.candidate.every((row) => row.seedInodePreserved && row.workspaceInodePreserved));
assert(
  samples.candidate.every((row) =>
    ["seed", "workspace"].every(
      (tree) =>
        row.events
          .filter((event) => event.kind === "manifest" && event.tree === tree)
          .reduce((sum, event) => sum + event.hashes!, 0) <= 1,
    ),
  ),
);
function summary(rows: number[]) {
  const sorted = rows.toSorted((a, b) => a - b);
  return { median: sorted[2], p95: sorted[4], min: sorted[0] };
}
const report = Object.fromEntries(
  Object.entries(samples).map(([variant, rows]) => [
    variant,
    {
      totalMs: summary(rows.map((row) => row.ms)),
      phases: Object.fromEntries(
        [...new Set(rows.flatMap((row) => Object.keys(row.phases)))].map((phase) => [
          phase,
          summary(rows.map((row) => (row.phases as Record<string, number>)[phase] ?? 0)),
        ]),
      ),
      samples: rows.map(({ workspace, events, ...row }) => ({
        ...row,
        sourceManifest: workspace.sourceManifestRef,
        preparedManifest: workspace.preparedManifestRef,
        work: ["seed", "workspace"].map((tree) => ({
          tree,
          fscks: events.filter((event) => event.kind === "fsck" && event.tree === tree).length,
          contentHashes: events
            .filter((event) => event.kind === "manifest" && event.tree === tree)
            .reduce((sum, event) => sum + event.hashes!, 0),
          memoHits: events
            .filter((event) => event.kind === "manifest" && event.tree === tree)
            .reduce((sum, event) => sum + event.files! - event.hashes!, 0),
          incomingObjects: events
            .filter((event) => event.kind === "transfer" && event.tree === tree)
            .reduce((sum, event) => sum + event.objects!, 0),
          incomingBytes: events
            .filter((event) => event.kind === "transfer" && event.tree === tree)
            .reduce((sum, event) => sum + event.bytes!, 0),
        })),
      })),
    },
  ]),
);
const sourceIdentity = (directory: string) => ({
  head: gitAt(directory, "rev-parse", "HEAD"),
  ownerSha256: createHash("sha256")
    .update(
      fs.readFileSync(
        path.join(directory, "src/gateway/worker-environments/project-preparation.ts"),
      ),
    )
    .digest("hex"),
});
console.log(
  JSON.stringify(
    {
      workload: { files: 1_000, bytesPerFile: 32 * 1024, changes: 1 },
      platform: process.platform,
      node: process.version,
      loadAverage: os.loadavg(),
      baseline: sourceIdentity(baselineRoot),
      candidate: sourceIdentity(process.cwd()),
      measurement:
        "Warm local disk, five counterbalanced pairs; observer adds equal overhead. Incoming counts are newly stored Git objects/bytes, not network wire bytes. Toolchain follows host platform; live Linux Node/Corepack cost remains AWS proof.",
      publicTransport,
      report,
    },
    null,
    2,
  ),
);
fs.rmSync(root, { recursive: true });
