import argparse
import os
import pathlib
import subprocess


def settings(actions=False):
    parser = argparse.ArgumentParser(description="Synthetic btrfs projection write measurement")
    parser.add_argument("--root", type=pathlib.Path, required=True)
    parser.add_argument("--node", type=pathlib.Path, required=True)
    parser.add_argument("--pnpm", type=pathlib.Path, required=True)
    parser.add_argument("--owner", type=pathlib.Path)
    parser.add_argument("--tool-dir", type=pathlib.Path, default=pathlib.Path(__file__).parent)
    if actions:
        parser.add_argument("actions", nargs="+")
    options = parser.parse_args()
    options.root = options.root.resolve()
    options.node = options.node.resolve()
    options.pnpm = options.pnpm.resolve()
    assert (options.root / ".projection-write-fixture").read_text() == "projection-write-cost-v1\n"
    for name, kind in [("mount", "btrfs"), ("store", "tmpfs")]:
        actual = subprocess.check_output(
            ["findmnt", "-n", "-o", "FSTYPE", "-T", str(options.root / name)], text=True,
        ).strip()
        assert actual == kind, f"{name} must be a dedicated {kind} mount"
    return options


def environment(options):
    return {
        **os.environ,
        "PATH": str(options.node.parent) + ":" + os.environ["PATH"],
        "HOME": str(options.root / "home"),
        "TMPDIR": str(options.root / "tmp"),
        "CI": "1",
    }
