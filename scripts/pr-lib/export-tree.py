"""Export exact revision blobs without archive's whole-tree index/hydration."""

import os
from pathlib import Path
import re
import subprocess
import sys


# Bootstrapped directly from the authenticated revision; no local imports.
binary, repository, revision, destination, *paths = sys.argv[1:]
git = [binary, "-C", repository]
listing = subprocess.check_output(
    [*git, "--literal-pathspecs", "ls-tree", "-r", "-z", "--full-tree", revision, "--", *paths]
)
rows = listing.split(b"\0")
if rows.pop() != b"":
    raise ValueError("Incomplete export listing")
entries = []
for row in rows:
    match = re.fullmatch(rb"(100644|100755|120000) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)", row, re.S)
    if not match:
        raise ValueError("Invalid export entry")
    mode, oid, name = match.groups()
    if any(part in (b"", b".", b"..") for part in name.split(b"/")):
        raise ValueError("Invalid export path")
    entries.append((mode, oid, name))
for path in paths:
    encoded = os.fsencode(path)
    if not any(name == encoded or name.startswith(encoded + b"/") for _, _, name in entries):
        raise ValueError("Missing export component: " + path)

# One batch process, exactly one request per selected file. Missing blobs may
# hydrate through Git's existing promisor remote; unrelated blobs are never asked for.
with subprocess.Popen([*git, "cat-file", "--batch"], stdin=subprocess.PIPE, stdout=subprocess.PIPE) as child:
    try:
        for mode, oid, name in entries:
            child.stdin.write(oid + b"\n")
            child.stdin.flush()
            header = child.stdout.readline().split()
            if len(header) != 3 or header[:2] != [oid, b"blob"]:
                raise ValueError("Unavailable export blob: " + os.fsdecode(name))
            size = int(header[2])
            data = child.stdout.read(size)
            if len(data) != size or child.stdout.read(1) != b"\n":
                raise ValueError("Incomplete export blob")
            path = Path(destination) / os.fsdecode(name)
            path.parent.mkdir(parents=True, exist_ok=True)
            if mode == b"120000":
                os.symlink(data, os.fsencode(path))
            else:
                with path.open("xb") as output:
                    output.write(data)
                path.chmod(0o755 if mode == b"100755" else 0o644)
        child.stdin.close()
        if child.wait() != 0:
            raise RuntimeError("Git export failed")
    finally:
        if child.poll() is None:
            child.kill()
