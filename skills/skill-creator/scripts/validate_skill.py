#!/usr/bin/env python3
"""
Validate a SKILL.md against OpenClaw skill quality checklist.

Usage:
    python3 validate_skill.py --skill path/to/SKILL.md
    python3 validate_skill.py --dir path/to/skills/   # validate all skills in dir
"""

import argparse
import re
import sys
from pathlib import Path


def parse_frontmatter(text: str) -> tuple[dict, str]:
    """Parse YAML frontmatter and return (fields, body)."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, text

    try:
        end = lines.index("---", 1)
    except ValueError:
        return {}, text

    fields = {}
    for line in lines[1:end]:
        if ":" in line:
            key, _, val = line.partition(":")
            fields[key.strip()] = val.strip().strip('"\'')

    body = "\n".join(lines[end + 1:])
    return fields, body


def validate_skill(skill_path: Path) -> list[str]:
    """Validate a SKILL.md. Returns list of error/warning strings."""
    issues = []

    if not skill_path.exists():
        return [f"❌ File not found: {skill_path}"]

    text = skill_path.read_text(encoding="utf-8")
    fields, body = parse_frontmatter(text)

    # 1. Frontmatter fields
    if "name" not in fields or not fields["name"]:
        issues.append("❌ Missing frontmatter field: name")
    if "description" not in fields or not fields["description"]:
        issues.append("❌ Missing frontmatter field: description")

    name = fields.get("name", "")
    description = fields.get("description", "")

    # 2. Name format: kebab-case, ≤ 64 chars
    if name:
        if len(name) > 64:
            issues.append(f"❌ name too long ({len(name)} chars, max 64): {name}")
        if not re.match(r'^[a-z0-9]+(-[a-z0-9]+)*$', name):
            issues.append(f"❌ name must be lowercase kebab-case (letters, digits, hyphens): {name!r}")

    # 3. Directory name should match skill name
    skill_dir = skill_path.parent
    if name and skill_dir.name != name:
        issues.append(f"⚠️  Directory name '{skill_dir.name}' doesn't match skill name '{name}'")

    # 4. Description quality
    if description:
        desc_lower = description.lower()
        if "use when" not in desc_lower:
            issues.append("⚠️  description missing 'Use when' clause (triggers may be inaccurate)")
        if "not for" not in desc_lower:
            issues.append("⚠️  description missing 'NOT for' clause (may cause false positives)")
        if len(description) < 50:
            issues.append(f"⚠️  description is very short ({len(description)} chars) — may under-trigger")

    # 5. Body length
    body_lines = [l for l in body.splitlines() if l.strip()]
    if len(body_lines) > 300:
        issues.append(f"⚠️  Body is {len(body_lines)} non-empty lines (recommended ≤ 300) — consider splitting into references/")

    # 6. No auxiliary docs
    skill_dir = skill_path.parent
    bad_files = ["README.md", "CHANGELOG.md", "INSTALLATION.md", "QUICK_REFERENCE.md"]
    for bad in bad_files:
        if (skill_dir / bad).exists():
            issues.append(f"⚠️  Found auxiliary doc '{bad}' — remove it (keep skill lean)")

    # 7. scripts/ actually linked but doesn't exist
    # Match real links/paths like: {baseDir}/scripts/, (scripts/foo.py), `scripts/foo`
    scripts_ref = re.search(r'(\{baseDir\}/scripts/|[\(\`]scripts/)', text)
    if scripts_ref:
        scripts_dir = skill_dir / "scripts"
        if not scripts_dir.exists():
            issues.append("⚠️  SKILL.md links to 'scripts/' but directory doesn't exist")

    # 8. references/ actually linked but doesn't exist
    refs_ref = re.search(r'(\{baseDir\}/references/|[\(\[]references/)', text)
    if refs_ref:
        refs_dir = skill_dir / "references"
        if not refs_dir.exists():
            issues.append("⚠️  SKILL.md links to 'references/' but directory doesn't exist")

    return issues


def main():
    parser = argparse.ArgumentParser(description="Validate OpenClaw SKILL.md files")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--skill", help="Path to a SKILL.md file")
    group.add_argument("--dir", help="Path to a directory containing skill subdirectories")
    args = parser.parse_args()

    results = {}

    if args.skill:
        path = Path(args.skill)
        results[path] = validate_skill(path)
    else:
        skills_dir = Path(args.dir)
        for skill_dir in sorted(skills_dir.iterdir()):
            skill_md = skill_dir / "SKILL.md"
            if skill_dir.is_dir() and skill_md.exists():
                results[skill_md] = validate_skill(skill_md)

    total_skills = len(results)
    passed = 0
    failed = 0

    for path, issues in results.items():
        skill_name = path.parent.name
        errors = [i for i in issues if i.startswith("❌")]
        warnings = [i for i in issues if i.startswith("⚠️")]

        if not issues:
            print(f"✅ {skill_name}: OK")
            passed += 1
        else:
            status = "❌" if errors else "⚠️ "
            print(f"{status} {skill_name}:")
            for issue in issues:
                print(f"   {issue}")
            if errors:
                failed += 1
            else:
                passed += 1  # warnings only = still passes

    if total_skills > 1:
        print(f"\n{'='*50}")
        print(f"Results: {passed}/{total_skills} passed" + (f", {failed} with errors" if failed else ""))

    sys.exit(1 if failed > 0 else 0)


if __name__ == "__main__":
    main()
