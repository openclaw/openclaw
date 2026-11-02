#!/usr/bin/env python3
"""Manual proof source admission; reads public Git checkouts, never fetches."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

IDENTITIES = {
    "before": ("0b584645a34242f72b0566f8cf3acebd9ac63a73", "685b7e59c940a055b0e998276c13ab19a110d6e8"),
    "after": ("adcfa7ca4a204860ff67b5e1db4f45bd7d5c8a17", "12fe3ed2d4c8dfd6757dd54fd6220ba9b74162a3"),
    "core": ("7830780292c95ac7f2e96ecee19cdfb1639393bb", "adba24522319c79af72e3632b4e5483b90af53a4"),
}
DELTA = {
    "apps/macos/Sources/OpenClaw/OnboardingProviderArtwork.swift",
    "apps/macos/Tests/OpenClawIPCTests/OnboardingProviderIconTests.swift",
}

def git(source, *args):
    return subprocess.check_output(["git", "-C", str(source), *args])

def tree(source, stage):
    commit, expected_tree = IDENTITIES[stage]
    assert git(source, "rev-parse", "HEAD").decode().strip() == commit, stage
    assert git(source, "rev-parse", "HEAD^{tree}").decode().strip() == expected_tree, stage
    entries = {}
    for item in git(source, "ls-tree", "-rz", "--full-tree", "HEAD").split(b"\0"):
        if not item:
            continue
        meta, raw_name = item.split(b"\t", 1)
        mode, kind, oid = meta.decode().split()
        name = raw_name.decode()
        assert kind == "blob" and mode in ("100644", "100755", "120000"), (name, kind)
        assert not Path(name).is_absolute() and ".." not in Path(name).parts, name
        entries[name] = (mode, oid)
    return entries

def verify(source, root, stage, output):
    entries = tree(source, stage)
    rows = []
    for name, (mode, oid) in sorted(entries.items()):
        target = root / name
        if mode == "120000":
            assert target.is_symlink(), name
            data = os.readlink(target).encode()
        else:
            assert not target.is_symlink() and target.is_file(), name
            assert bool(target.stat().st_mode & 0o111) == (mode == "100755"), name
            data = target.read_bytes()
        actual = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
        assert actual == oid, f"Source mismatch: {stage}/{name}"
        rows.append({"path": name, "mode": mode, "gitBlob": oid, "sha256": hashlib.sha256(data).hexdigest()})
    output.write_text("".join(json.dumps(row, sort_keys=True) + "\n" for row in rows))
    return {"stage": stage, "commit": IDENTITIES[stage][0], "tree": IDENTITIES[stage][1],
            "matchedBlobs": len(rows), "manifestSha256": hashlib.sha256(output.read_bytes()).hexdigest()}

def main():
    mode, *args = sys.argv[1:]
    if mode == "verify":
        source, root, stage, output = args
        print(json.dumps(verify(Path(source), Path(root), stage, Path(output)), indent=2))
    elif mode == "advance":
        before, after, work = map(Path, args)
        old, new = tree(before, "before"), tree(after, "after")
        changed = {name for name in old.keys() | new.keys() if old.get(name) != new.get(name)}
        assert changed == DELTA, sorted(changed)
        for name in sorted(changed):
            assert name in new, "This capture only admits the reviewed two-file identity delta"
            target = work / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((after / name).read_bytes())
            target.chmod(0o755 if new[name][0] == "100755" else 0o644)
        print(json.dumps({"reviewedDelta": sorted(changed)}))
    else:
        raise ValueError("Use verify or advance")

if __name__ == "__main__":
    main()
