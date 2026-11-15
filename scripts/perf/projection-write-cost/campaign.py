import hashlib
import json
import pathlib
import re
import shutil
import statistics
import subprocess

from settings import environment, settings

OPTIONS = settings(actions=True)
ROOT = OPTIONS.root
MOUNT = ROOT / "mount"
NODE, PNPM = str(OPTIONS.node), str(OPTIONS.pnpm)
ENV = environment(OPTIONS)
HERE = pathlib.Path(__file__).parent
TOOLS = OPTIONS.tool_dir
(ROOT / "metrics").mkdir(exist_ok=True)
(ROOT / "logs").mkdir(exist_ok=True)


def run(args, **kwargs):
    return subprocess.check_output(
        [str(arg) for arg in args], env=ENV, text=True,
        stderr=subprocess.STDOUT, **kwargs,
    )


def sync():
    run(["btrfs", "filesystem", "sync", MOUNT])


def measure(label, stage, command, cwd, env=ENV):
    metric = ROOT / "metrics" / f"{label}-{stage}.json"
    with (ROOT / "logs" / f"{label}-{stage}.log").open("w") as log:
        result = subprocess.run(
            ["python3", str(HERE / "stage.py"), str(metric),
             *[str(item) for item in command]],
            cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT,
        )
    row = json.loads(metric.read_text())
    if result.returncode:
        raise RuntimeError(f"{label}/{stage} failed: {ROOT}/logs/{label}-{stage}.log")
    print(label, stage, row["wallMs"], row["writeBytes"], flush=True)
    return row


def extent(dest):
    sync()
    paths = [dest, dest / "src", dest / ".git", dest / "node_modules",
             dest / "dist", dest / ".cache"]
    return {
        str(path.relative_to(dest)) if path != dest else "total":
        run(["btrfs", "filesystem", "du", "-s", "--raw", path]).strip()
        for path in paths if path.exists()
    }


def remove(dest):
    run(["btrfs", "subvolume", "delete", dest])
    sync()
    run(["btrfs", "subvolume", "sync", MOUNT])


def cold_template():
    template = MOUNT / "template"
    stages = {}
    stages["create"] = measure(
        "cold", "create", [NODE, TOOLS / "clone.mjs", "create", template], ROOT,
    )
    stages["checkout"] = measure(
        "cold", "checkout",
        ["git", "clone", "--no-local", "--depth=1", "--branch", "main",
         "file://" + str(ROOT / "source"), template], ROOT,
    )
    stages["install"] = measure(
        "cold", "install",
        [NODE, PNPM, "install", "--offline", "--frozen-lockfile",
         "--config.optimistic-repeat-install=false", "--store-dir",
         ROOT / "store/builder"], template,
    )
    # Same publication rule as the owner: retain source and node_modules only.
    shutil.rmtree(template / ".cache")
    (ROOT / "cold.json").write_text(json.dumps(
        {"stages": stages, "extents": extent(template)}, indent=2,
    ))
    shutil.rmtree(ROOT / "store/builder")


def sample(label, kind):
    assert re.fullmatch("[a-z0-9-]{1,40}", label)
    assert kind in ["mismatched", "matching", "default", "owner"]
    dest = MOUNT / label
    assert not dest.exists()
    template = MOUNT / "template"
    stages, extents = {}, {}
    # One representative default/owner pair records extents; all samples record IO.
    inspect = kind in ["mismatched", "matching"] or label in ["default1", "owner1"]
    stages["clone"] = measure(
        label, "clone", [NODE, TOOLS / "clone.mjs", "copy", template, dest], ROOT,
    )
    if inspect:
        extents["clone"] = extent(dest)
    stages["fetch"] = measure(
        label, "fetch",
        ["git", "fetch", "--no-tags", "--depth=64", "--filter=blob:none",
         "file://" + str(ROOT / "source"), "fork-review"], dest,
    )
    stages["checkout"] = measure(
        label, "checkout", ["git", "checkout", "--quiet", "-B", "review", "FETCH_HEAD"],
        dest,
    )
    if inspect:
        extents["checkout"] = extent(dest)
    package = dest / "node_modules/fixture-dep-000/lib/file-000.txt"
    inode_before = package.stat().st_ino
    env = dict(ENV)
    owner = None
    command = [NODE, PNPM, "install", "--offline", "--frozen-lockfile",
               "--config.optimistic-repeat-install=false"]
    if kind in ["default", "owner"]:
        for key in ["PNPM_CONFIG_STORE_DIR", "npm_config_store_dir", "NPM_CONFIG_STORE_DIR"]:
            env.pop(key, None)
        if kind == "owner":
            assert OPTIONS.owner is not None
            config = json.loads(subprocess.check_output(
                [NODE, HERE / "owner-config.mjs", OPTIONS.owner], env=ENV, text=True,
            ))
            for key in ["PNPM_CONFIG_STORE_DIR", "npm_config_store_dir"]:
                assert config["env"][key] == "/tmp/openclaw-deps/data/pnpm/store"
                env[key] = str(ROOT / "store/builder")
            owner = {
                "sha256": hashlib.sha256(OPTIONS.owner.read_bytes()).hexdigest(),
                "config": config,
            }
    else:
        store = ROOT / "store" / ("builder" if kind == "matching" else "runtime")
        assert not store.exists(), "Every consumer starts with an absent store"
        command += ["--store-dir", str(store)]
    stages["install"] = measure(label, "install", command, dest, env)
    store = pathlib.Path(json.loads(
        (dest / "node_modules/.modules.yaml").read_text(),
    )["storeDir"])
    assert store.is_relative_to(ROOT) and store != ROOT
    assert store.name == "v11"
    assert store.parent.name in ["store", ".pnpm-store", "builder", "runtime"]
    inode_after = package.stat().st_ino
    if inspect:
        extents["install"] = extent(dest)
    stages["test"] = measure(label, "test", [NODE, PNPM, "test"], dest, env)
    stages["build"] = measure(label, "build", [NODE, PNPM, "build"], dest, env)
    stages["diff"] = measure(
        label, "diff", ["git", "diff", "main...HEAD", "--", "version.cjs"], dest,
    )
    diff = (ROOT / "logs" / f"{label}-diff.log").read_text()
    assert '+module.exports = "fork";' in diff
    if inspect:
        extents["build"] = extent(dest)
    assert (template / "version.cjs").read_text() == 'module.exports = "base";\n'
    assert not (template / "dist").exists()
    assert package.read_bytes() == (
        template / "node_modules/fixture-dep-000/lib/file-000.txt"
    ).read_bytes()
    assert (inode_before == inode_after) == (kind in ["matching", "owner"])
    total = {
        key: sum(row[key] for row in stages.values())
        for key in ["wallMs", "cpuMs", "writeBytes", "blockOutputBytes", "cancelledWriteBytes"]
    }
    total["maxRssKiB"] = max(row["maxRssKiB"] for row in stages.values())
    row = {
        "label": label, "kind": kind, "stages": stages, "extents": extents,
        "total": total, "dependencyInodePreserved": inode_before == inode_after,
        "checks": {"forkCheckout": True, "test": True, "diff": True, "templateIsolation": True},
        "store": str(store), "owner": owner,
    }
    with (ROOT / "results.jsonl").open("a") as out:
        out.write(json.dumps(row) + "\n")
    remove(dest)
    # pnpm's version suffix is part of the recorded store identity; parent is private.
    if store.parent.exists():
        shutil.rmtree(store.parent)
    print(json.dumps({"label": label, "kind": kind, "total": total}), flush=True)


def summarize():
    rows = [json.loads(line) for line in (ROOT / "results.jsonl").read_text().splitlines()]
    summary = {}
    for kind in ["mismatched", "matching", "default", "owner"]:
        values = [row for row in rows
                  if row["kind"] == kind and not row["label"].startswith("aa")]
        if not values:
            continue
        summary[kind] = {"samples": len(values), "stages": {}}
        for stage in ["total", "clone", "fetch", "checkout", "install", "test", "build", "diff"]:
            selected = [row["total"] if stage == "total" else row["stages"][stage]
                        for row in values]
            summary[kind]["stages"][stage] = {
                key: {
                    "median": statistics.median(row[key] for row in selected),
                    "min": min(row[key] for row in selected),
                    "max": max(row[key] for row in selected),
                    "p95": max(row[key] for row in selected),
                }
                for key in ["wallMs", "cpuMs", "writeBytes", "maxRssKiB"]
            }
    summary["AA"] = [{"label": row["label"], "total": row["total"]}
                     for row in rows if row["label"].startswith("aa")]
    (ROOT / "summary.json").write_text(json.dumps(summary, indent=2))


if OPTIONS.actions[0] == "cold":
    cold_template()
elif OPTIONS.actions[0] == "summarize":
    summarize()
else:
    for spec in OPTIONS.actions:
        sample(*spec.split(":"))
