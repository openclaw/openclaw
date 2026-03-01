#!/usr/bin/env python3
from __future__ import annotations

import pathlib
import re
import sys


USES_RE = re.compile(r"^\s*uses:\s*(\S+)\s*$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")


def iter_workflow_files(root: pathlib.Path) -> list[pathlib.Path]:
    files = list(root.glob("*.yml")) + list(root.glob("*.yaml"))
    return sorted(files)


def is_external_action(reference: str) -> bool:
    if reference.startswith("./"):
        return False
    if reference.startswith("docker://"):
        return False
    return "/" in reference


def main() -> int:
    workflows_root = pathlib.Path(".github/workflows")
    violations: list[str] = []

    for workflow_path in iter_workflow_files(workflows_root):
        for line_no, raw_line in enumerate(workflow_path.read_text(encoding="utf-8").splitlines(), start=1):
            line = raw_line.split("#", 1)[0].rstrip()
            match = USES_RE.match(line)
            if not match:
                continue

            reference = match.group(1)
            if not is_external_action(reference):
                continue

            if "@" not in reference:
                violations.append(f"{workflow_path}:{line_no}: missing @ref in `{reference}`")
                continue

            _, ref = reference.rsplit("@", 1)
            if not SHA_RE.fullmatch(ref):
                violations.append(
                    f"{workflow_path}:{line_no}: action ref must be SHA-pinned (found `{reference}`)"
                )

    if violations:
        print("Workflow action pinning violations:")
        for violation in violations:
            print(f"- {violation}")
        print("Pin external GitHub Actions to immutable commit SHAs.")
        return 1

    print("All external workflow actions are SHA-pinned.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
