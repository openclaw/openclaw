#!/usr/bin/env python3
from __future__ import annotations

import pathlib
import sys


def iter_workflow_files(root: pathlib.Path) -> list[pathlib.Path]:
    files = list(root.glob("*.yml")) + list(root.glob("*.yaml"))
    return sorted(files)


def find_top_level_permissions_line(lines: list[str]) -> tuple[int, str] | None:
    for index, line in enumerate(lines, start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if line.startswith(" ") or line.startswith("\t"):
            continue
        if stripped.startswith("permissions:"):
            return (index, stripped)
    return None


def main() -> int:
    workflows_root = pathlib.Path(".github/workflows")
    files = iter_workflow_files(workflows_root)
    violations: list[str] = []

    for workflow_path in files:
        lines = workflow_path.read_text(encoding="utf-8").splitlines()
        top_level_permissions = find_top_level_permissions_line(lines)
        if top_level_permissions is None:
            violations.append(f"{workflow_path}: missing top-level permissions declaration")
            continue

        line_no, declaration = top_level_permissions
        if declaration == "permissions: write-all":
            violations.append(f"{workflow_path}:{line_no}: top-level permissions must not be write-all")

    if violations:
        print("Workflow permissions policy violations:")
        for violation in violations:
            print(f"- {violation}")
        print("Add an explicit top-level `permissions:` block to every workflow.")
        return 1

    print("All workflows declare explicit top-level permissions.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
