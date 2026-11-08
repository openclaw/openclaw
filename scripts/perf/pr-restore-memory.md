# PR restore memory measurement

`pr-restore-memory.mjs` runs the actual journaled recovery function from two tooling roots. It copies a cold partial-clone fixture for every arm, alternates AB/BA order, and verifies HEAD, index tree, and tracked worktree before removing each copy. Keep both tooling roots fixed throughout the run. They need `scripts/pr-lib/` and its unchanged `scripts/lib/direct-run.mjs` dependency; no application build is needed.

```sh
node scripts/perf/pr-restore-memory.mjs \
  --fixture /scratch/cold-checkout \
  --base /scratch/base-tooling --candidate /scratch/candidate-tooling \
  --source SOURCE_SHA --target TARGET_SHA \
  --output /scratch/restore-results --pairs 5
```

The fixture must be clean at `SOURCE_SHA`, with target trees present and target blobs missing. Each arm retains timing and Git Trace2 logs beside `results.json`. CPU is child user plus system time; RSS is the largest process RSS reported by `time`, **not** simultaneous aggregate process-tree memory. Allocation bytes are not measured. Host load is recorded before and after each arm.

For a separate Git-only attribution pass, add `--git-metrics`. This wraps the selected Git executable with `time`, excluding the Node containment validator from Git peak RSS. With a `file://` origin, these measurements include the locally spawned upload-pack server. To measure client descendants as on a network clone, serve the object repository through a separate loopback `git daemon`, point the fixture's origin at it, and use a fresh results directory. Do not mix these instrumentation or transport modes in one before/after comparison.

## A bounded fixture using real repository blobs

Use a private scratch object repository containing both revisions and their blobs. For the original investigation the revisions were `a12736320cf4e0578429895aa1ec9de35199dbf7` and `de6ac4ff02b1839c7af1816ddce12f7490ded83d`. The following creates two synthetic commits containing only the first 2,048 changed regular files under `src/gateway/`, retaining their actual paths, modes, and bytes. It does not claim to reproduce the entire repository's history or production peak memory.

```sh
python3 - /scratch/objects SOURCE_SHA TARGET_SHA <<'PY'
import os, pathlib, subprocess, sys
repo, source, target = sys.argv[1:]
repo = pathlib.Path(repo).resolve()
env = dict(os.environ, GIT_INDEX_FILE=str(repo / "benchmark-index"),
           GIT_AUTHOR_NAME="OpenClaw Benchmark", GIT_AUTHOR_EMAIL="benchmark@openclaw.invalid",
           GIT_COMMITTER_NAME="OpenClaw Benchmark", GIT_COMMITTER_EMAIL="benchmark@openclaw.invalid")
def git(*args, **kwargs):
    return subprocess.check_output(["git", "-C", str(repo), *args], env=env, **kwargs)
rows = git("diff-tree", "--no-commit-id", "--raw", "--no-abbrev", "--no-renames", "-r", "-z", source, target).split(b"\0")
selected = [(meta.removeprefix(b":").split(), name) for meta, name in zip(rows[::2], rows[1::2])
            if name.startswith(b"src/gateway/") and meta.split()[1] in (b"100644", b"100755")][:2048]
commits = []
for side in (0, 1):
    git("read-tree", "--empty")
    entries = b"".join(p[side] + b" " + p[side + 2] + b"\t" + name + b"\0"
                       for p, name in selected if p[side] in (b"100644", b"100755"))
    git("update-index", "-z", "--index-info", input=entries)
    tree = git("write-tree").decode().strip()
    commit = git("commit-tree", tree, *(["-p", commits[0]] if commits else []),
                 "-m", f"restore benchmark side {side}").decode().strip()
    commits.append(commit)
    git("update-ref", f"refs/heads/bench-{side}", commit)
print("source", commits[0], "target", commits[1], "paths", len(selected))
PY
git -C /scratch/objects config uploadpack.allowFilter true
git -C /scratch/objects config uploadpack.allowAnySHA1InWant true
git clone --filter=blob:none --no-checkout --single-branch --branch bench-1 \
  file:///scratch/objects /scratch/cold-checkout
git -C /scratch/cold-checkout checkout --detach SOURCE_PRINTED_ABOVE
```

Keep the object server outside the fixture: the runner copies and removes only its own per-arm checkouts. For full-repository proof, prepare a separate ordinary partial clone at the original source commit and pass the original target SHA; do not describe the bounded fixture as that proof. Slow or interrupted arms are incomplete observations, not completed benchmark samples.
