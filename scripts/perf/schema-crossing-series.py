"""Serial synthetic WAL-update A/A and A/B proof; retire fixture copies after every arm.

Run from the candidate checkout with pinned, built baseline/candidate worktrees.
The seed must be produced by schema-crossing-measure.ts. Staging must use a private,
non-reflinking volume with room for the recovery payload and a full agent image.
No operator state is accepted.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import sqlite3
import subprocess
import sys
import time

parser = argparse.ArgumentParser(description=__doc__)
for name in ("baseline", "candidate", "seed", "staging", "output", "node"):
    parser.add_argument("--" + name, type=Path, required=True)
parser.add_argument("--compact-image", type=Path, help="Task-owned sparse image mounted at --staging")
args = parser.parse_args()
assert sys.platform == "darwin", "This runner uses macOS /usr/bin/time -l"
for name in vars(args):
    if getattr(args, name) is not None:
        setattr(args, name, getattr(args, name).resolve())
if args.compact_image:
    images = plistlib.loads(subprocess.check_output(["hdiutil", "info", "-plist"]))["images"]
    assert any(Path(image["image-path"]).resolve() == args.compact_image and
               any(entity.get("mount-point") == str(args.staging) for entity in image["system-entities"])
               for image in images), "Compaction image must own the staging mount"
assert args.seed.is_relative_to(args.candidate / ".local")
fixture = json.loads((args.seed / "fixture.json").read_text())
assert fixture["walBytes"] > 0 and fixture["sourceAgentSchema"] == 41
args.output.mkdir(parents=True, exist_ok=True)
identity = {
    "baseline": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=args.baseline, text=True).strip(),
    "candidate": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=args.candidate, text=True).strip(),
    "node": subprocess.check_output([str(args.node), "--version"], text=True).strip(),
    "fixture": fixture,
    "compactImage": str(args.compact_image) if args.compact_image else None,
    "benchmarkSha256": hashlib.sha256((args.candidate / "scripts/perf/schema-crossing-measure.ts").read_bytes()).hexdigest(),
}
manifest = args.output / "series.json"
if manifest.exists():
    assert json.loads(manifest.read_text()) == identity, "Proof inputs changed; use a new series"
else:
    manifest.write_text(json.dumps(identity, indent=2))
for filename in ("schema-crossing-measure.ts", "schema-crossing-observer.ts", "schema-crossing-child-observer.cjs"):
    shutil.copy2(args.candidate / "scripts/perf" / filename, args.baseline / "scripts/perf" / filename)
sequence = ["AA1", "AA2", "A1", "B1", "A2", "B2", "AA3", "AA4", "A3", "B3", "A4", "B4", "A5", "B5"]
reference = None
for label in sequence:
    result = args.output / (label + ".json")
    if result.exists():
        previous = json.loads(result.read_text())
        reference = reference or previous["outcomes"]
        assert previous["outcomes"] == reference
        continue
    tree = args.baseline if label.startswith("A") else args.candidate
    run = tree / ".local/lane2456/qualifying-run"
    staging = args.staging / label
    assert not run.exists() and not staging.exists(), "Reconcile an interrupted arm before resuming"
    run.parent.mkdir(parents=True, exist_ok=True)
    staging.mkdir(mode=0o700)
    observations = args.output / (label + "-children")
    observations.mkdir()
    profiles = args.output / (label + "-profiles")
    profiles.mkdir()
    print("PREPARE", label, time.strftime("%FT%T%z"), flush=True)
    command = ["cp", "-cR"]
    subprocess.run(command + [str(args.seed), str(run)], check=True)
    env = dict(os.environ, SCHEMA_CROSSING_TEMP_ROOT=str(staging),
               SCHEMA_CROSSING_CHILD_OBSERVATIONS=str(observations),
               SCHEMA_CROSSING_CHILD_ALLOCATIONS="1", FS_SAFE_NATIVE_MODE="auto",
               NODE_OPTIONS="--require=" + str(tree / "scripts/perf/schema-crossing-child-observer.cjs") +
               " --cpu-prof --cpu-prof-dir=" + str(profiles))
    # Native safety checks stay enabled; the staging filesystem cannot reflink.
    # APFS clone preparation is outside timing.
    command = ["/usr/bin/time", "-l", str(args.node), "--import", "./scripts/tsx.mjs",
               "scripts/perf/schema-crossing-measure.ts", "run", str(run), "allocation"]
    print("START", label, time.strftime("%FT%T%z"), flush=True)
    with (args.output / (label + ".log")).open("w") as output:
        completed = subprocess.run(command, cwd=tree, env=env, stdout=output, stderr=subprocess.STDOUT)
    try:
        assert completed.returncode == 0, f"{label} failed: inspect its log before another arm"
        summary = json.loads((run / "summary.json").read_text())
        outcomes = []
        for database in sorted((run / "state/agents").glob("*/agent/openclaw-agent.sqlite")):
            connection = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)
            digest = hashlib.sha256()
            counts = {}
            for table, order in [("session_nodes", "session_key"), ("session_windows", "session_id"),
                                 ("transcript_events", "session_id,seq")]:
                rows = connection.execute("SELECT * FROM " + table + " ORDER BY " + order).fetchall()
                counts[table] = len(rows)
                digest.update(json.dumps(rows, sort_keys=True,
                    default=lambda value: hashlib.sha256(value).hexdigest()).encode())
            # Include committed WAL padding bytes as well as the real session-row update.
            if database.parent.parent.name.startswith("synthetic-"):
                for row in connection.execute("SELECT substr(payload,1,64) FROM synthetic_payload ORDER BY rowid LIMIT 128"):
                    digest.update(row[0])
            outcomes.append(dict(agent=database.parent.parent.name,
                schema=connection.execute("PRAGMA user_version").fetchone()[0],
                counts=counts, contentSha256=digest.hexdigest()))
            connection.close()
        reference = reference or outcomes
        assert outcomes == reference, f"{label} changed session/migration outcomes"
        receipt = json.loads((staging / "recovery/native.receipt.json").read_text())
        assert receipt["status"] == "migrated"
        summary.update(outcomes=outcomes, receiptStatus=receipt["status"],
            backupBytes=sum(row["sizeBytes"] for row in receipt["backup"]["databases"]))
        result.write_text(json.dumps(summary, indent=2))
        shutil.copy2(staging / "recovery/native.receipt.json", args.output / (label + "-receipt.json"))
        print("DONE", label, round(summary["elapsedMs"] / 1000, 3), "seconds", flush=True)
    finally:
        assert (run / "fixture.json").is_file()
        shutil.rmtree(run)
        shutil.rmtree(staging)
        if args.compact_image:
            # Deleted HFS+ files leave sparse backing bands allocated. Reclaim them
            # outside timing so later arms have the same real capacity admission.
            subprocess.run(["hdiutil", "detach", str(args.staging)], check=True)
            subprocess.run(["hdiutil", "compact", str(args.compact_image)], check=True)
            subprocess.run(["hdiutil", "attach", str(args.compact_image),
                            "-mountpoint", str(args.staging), "-nobrowse"], check=True)
        print("CLEANED", label, flush=True)
print("COMPLETE", flush=True)
