#!/usr/bin/env python3
"""Create a synthetic repository for sandbox-projection-fetch-measure.ts.

python3 scripts/perf/sandbox-projection-fetch-fixture.py --output /owned/fixture
Defaults: 62k files / 1.1 GiB current tree, about 1.56M objects, three branch heads.
No production data, network, dependencies, or existing directories are used.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--files", type=int, default=62000)
    parser.add_argument("--file-bytes", type=int, default=19050)
    parser.add_argument("--revisions", type=int, default=750)
    parser.add_argument("--updates", type=int, default=1000)
    args = parser.parse_args()
    if min(args.files, args.file_bytes, args.revisions, args.updates) < 1:
        parser.error("fixture dimensions must be positive")
    if args.updates > args.files or args.revisions < 3:
        parser.error("updates must not exceed files; at least three revisions are needed")
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=False)
    source = root / "source"
    source.mkdir()
    env = {
        "PATH": os.environ["PATH"],
        "HOME": str(root),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_SYSTEM": os.devnull,
        "GIT_TERMINAL_PROMPT": "0",
    }

    def git(*argv):
        return subprocess.check_output(["git", "-C", str(source), *argv], env=env).decode().strip()

    started = time.monotonic()
    git("init", "--quiet", "-b", "main")
    git("config", "uploadpack.allowFilter", "true")
    git("config", "remote.origin.url", "https://github.com/example/projection.git")
    git("config", "gc.auto", "0")
    git("config", "maintenance.auto", "false")
    # Keep synthetic output deterministic and bounded independently of host settings.
    git("config", "pack.threads", "1")
    with (root / "fast-import.log").open("wb") as log:
        process = subprocess.Popen(
            ["git", "-C", str(source), "fast-import", "--quiet"],
            stdin=subprocess.PIPE,
            stdout=log,
            stderr=log,
            env=env,
        )
        assert process.stdin is not None
        stream = process.stdin

        def write(value):
            stream.write(value.encode() if isinstance(value, str) else value)

        def commit(ref, mark, message, parent=None):
            write(f"commit refs/heads/{ref}\nmark :{mark}\n")
            write(f"committer Synthetic fixture <fixture@example.invalid> {1700000000 + mark} +0000\n")
            write(f"data {len(message)}\n{message}\n")
            if parent is not None:
                write(f"from :{parent}\n")

        def file(index, revision, size):
            header = f"// synthetic file {index}, revision {revision}\n".encode()
            # Unique source-like payload: history has real entropy, while current
            # files also include repetitive text, as ordinary source trees do.
            entropy = hashlib.shake_256(header).hexdigest(768).encode()
            body = header + entropy + b"\n"
            filler = b"export const syntheticFixture = 'workspace source only';\n"
            content = (body + filler * ((size // len(filler)) + 1))[:size]
            write(f"M 100644 inline src/d{index % args.updates:04d}/file{index:05d}.ts\n")
            write(f"data {len(content)}\n")
            write(content)
            write("\n")

        commit("main", 1, "initial synthetic source")
        for index in range(args.files):
            file(index, 0, args.file_bytes)
        write("\n")
        for revision in range(1, args.revisions + 1):
            commit("main", revision + 1, f"synthetic history {revision}")
            for index in range(args.updates):
                file(index, revision, 1536)
            write("\n")
            if revision % 100 == 0:
                print(f"streamed {revision}/{args.revisions} history commits", flush=True)
        commit("main", args.revisions + 2, "selected projection base")
        for index in range(args.updates):
            file(index, args.revisions + 1, args.file_bytes)
        write("\n")
        parents = [args.revisions // 3 + 1, args.revisions * 2 // 3 + 1, args.revisions + 1]
        for index, parent in enumerate(parents):
            commit(f"pr-{index + 1}", args.revisions + 3 + index, f"synthetic PR {index + 1}", parent)
            file(index, args.revisions + 2 + index, args.file_bytes)
            write("\n")
        write("done\n")
        stream.close()
        if process.wait() != 0:
            raise RuntimeError(f"fast-import failed; inspect {root / 'fast-import.log'}")
    git("checkout", "--quiet", "main")
    # Newly imported main is already HEAD; checkout explicitly populates its index/tree.
    git("read-tree", "--reset", "-u", "HEAD")
    report = {
        "source": str(source),
        "base": git("rev-parse", "main"),
        "heads": [git("rev-parse", f"pr-{index}") for index in range(1, 4)],
        "remote": "https://github.com/example/projection.git",
        "insteadOf": source.as_uri(),
        "files": args.files,
        "currentTreeBytes": args.files * args.file_bytes,
        "historyRevisions": args.revisions,
        "updatedPathsPerRevision": args.updates,
        "gitCountObjects": git("count-objects", "-v"),
        "elapsedSeconds": time.monotonic() - started,
    }
    (root / "fixture.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    main()
