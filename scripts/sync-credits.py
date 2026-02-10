#!/usr/bin/env python3
"""
Sync maintainers and contributors in docs/reference/credits.md from git/GitHub.

- Maintainers: people who have merged PRs (via GitHub API) + direct pushes to main
- Contributors: all unique commit authors on main with commit counts

Usage: python scripts/sync-credits.py
"""

import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
CREDITS_FILE = REPO_ROOT / "docs" / "reference" / "credits.md"
REPO = "openclaw/openclaw"

# Exclude bot accounts from maintainer list
EXCLUDED_MAINTAINERS = {
    "app/clawdinator",
    "clawdinator",
    "github-actions",
    "dependabot",
}

# Exclude bot/system names from contributor list
EXCLUDED_CONTRIBUTORS = {
    "GitHub",
    "github-actions[bot]",
    "dependabot[bot]",
    "clawdinator[bot]",
    "blacksmith-sh[bot]",
    "google-labs-jules[bot]",
    "Maude Bot",
    "Pocket Clawd",
    "Ghost",
    "Gregor's Bot",
    "Jarvis",
    "Jarvis Deploy",
    "CI",
    "Ubuntu",
    "user",
    "Developer",
    # Bot names that appear in git history
    "CLAWDINATOR Bot",
    "Clawd",
    "Clawdbot",
    "Clawdbot Maintainers",
    "Claude Code",
    "L36 Server",
    "seans-openclawbot",
    "therealZpoint-bot",
    "Vultr-Clawd Admin",
    "hyf0-agent",
}

# Minimum merged PRs to be considered a maintainer
MIN_MERGES = 2


# Regex to extract GitHub username from noreply email
# Matches: [redacted-email] or [redacted-email]
GITHUB_NOREPLY_RE = re.compile(r"^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$", re.I)


def extract_github_username(email: str) -> str | None:
    """Extract GitHub username from noreply email, or return None."""
    match = GITHUB_NOREPLY_RE.match(email)
    return match.group(1).lower() if match else None


def sanitize_name(name: str) -> str:
    """Sanitize name for MDX by removing curly braces (which MDX interprets as JS)."""
    return name.replace("{", "").replace("}", "").strip()


def run_git(*args: str) -> str:
    """Run git command and return stdout."""
    result = subprocess.run(
        ["git", *args],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=True,
    )
    return result.stdout.strip()


def run_gh(*args: str) -> str:
    """Run gh CLI command and return stdout."""
    result = subprocess.run(
        ["gh", *args],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=True,
    )
    return result.stdout.strip()


def categorize_commit_files(files: list[str]) -> str:
    """Categorize a commit based on its changed files.

    Returns: 'ci', 'docs only', 'docs', or 'other'
    - 'ci': any commit with CI files (.github/, scripts/ci*)
    - 'docs only': only documentation files (docs/ or any .md)
    - 'docs': docs + other files mixed
    - 'other': code without CI or docs
    """
    has_ci = False
    has_docs = False
    has_other = False

    for f in files:
        f_lower = f.lower()
        if f_lower.startswith(".github/") or f_lower.startswith("scripts/ci"):
            has_ci = True
        elif f_lower.startswith("docs/") or f_lower.endswith(".md"):
            has_docs = True
        else:
            has_other = True

    # CI takes priority if present
    if has_ci:
        return "ci"
    if has_other:
        if has_docs:
            return "docs"  # Mixed: docs + other
        return "other"  # Pure code
    if has_docs:
        return "docs only"  # Pure docs
    return "other"


def get_maintainers() -> list[tuple[str, int, dict[str, int]]]:
    """Get maintainers with (login, merge_count, push_counts_by_category).

    - Merges: from GitHub API (who clicked "merge")
    - Direct pushes: non-merge commits to main (by committer name matching login)
      categorized into 'ci', 'docs', 'other'
    """
    # 1. Fetch ALL merged PRs using gh pr list (handles pagination automatically)
    print("  Fetching merged PRs from GitHub API...")
    output = run_gh(
        "pr",
        "list",
        "--repo",
        REPO,
        "--state",
        "merged",
        "--limit",
        "10000",
        "--json",
        "mergedBy",
        "--jq",
        ".[].mergedBy.login",
    )

    merge_counts: dict[str, int] = {}
    if output:
        for login in output.strip().splitlines():
            login = login.strip()
            if login and login not in EXCLUDED_MAINTAINERS:
                merge_counts[login] = merge_counts.get(login, 0) + 1

    print(
        f"  Found {sum(merge_counts.values())} merged PRs by {len(merge_counts)} users"
    )

    # 2. Count direct pushes (non-merge commits by committer) with categories
    # Use GitHub username from noreply emails, or committer name as fallback
    print("  Counting direct pushes from git history...")
    # push_counts[key] = {"ci": N, "docs only": N, "docs": N, "other": N}
    push_counts: dict[str, dict[str, int]] = {}

    # Get commits with files using a delimiter to parse
    output = run_git(
        "log", "main", "--no-merges", "--format=COMMIT|%cN|%cE", "--name-only"
    )

    current_key: str | None = None
    current_files: list[str] = []

    def flush_commit() -> None:
        nonlocal current_key, current_files
        if current_key and current_files:
            category = categorize_commit_files(current_files)
            if current_key not in push_counts:
                push_counts[current_key] = {
                    "ci": 0,
                    "docs only": 0,
                    "docs": 0,
                    "other": 0,
                }
            push_counts[current_key][category] += 1
        current_key = None
        current_files = []

    for line in output.splitlines():
        line = line.strip()
        if not line:
            continue

        if line.startswith("COMMIT|"):
            # Flush previous commit
            flush_commit()
            # Parse new commit
            parts = line.split("|", 2)
            if len(parts) < 3:
                continue
            _, name, email = parts
            name = name.strip()
            email = email.strip().lower()
            if not name or name in EXCLUDED_CONTRIBUTORS:
                current_key = None
                continue

            # Use GitHub username from noreply email if available
            gh_user = extract_github_username(email)
            current_key = gh_user if gh_user else name.lower()
        else:
            # This is a file path
            if current_key:
                current_files.append(line)

    # Flush last commit
    flush_commit()

    # 3. Build maintainer list: anyone with merges >= MIN_MERGES
    maintainers: list[tuple[str, int, dict[str, int]]] = []

    for login, merges in merge_counts.items():
        if merges >= MIN_MERGES:
            # Try to find matching push count (case-insensitive)
            pushes = push_counts.get(
                login.lower(), {"ci": 0, "docs only": 0, "docs": 0, "other": 0}
            )
            maintainers.append((login, merges, pushes))

    # Sort by total activity (merges + sum of pushes) descending
    maintainers.sort(key=lambda x: (-(x[1] + sum(x[2].values())), x[0].lower()))
    return maintainers


def get_contributors() -> list[tuple[str, int]]:
    """Get all unique commit authors on main with commit counts.

    Merges authors by:
    1. GitHub username (extracted from noreply emails)
    2. Author name matching a known GitHub username
    3. Display name (case-insensitive) as final fallback
    """
    output = run_git("log", "main", "--format=%aN|%aE")
    if not output:
        return []

    # First pass: collect all known GitHub usernames from noreply emails
    known_github_users: set[str] = set()

    for line in output.splitlines():
        line = line.strip()
        if not line or "|" not in line:
            continue
        _, email = line.rsplit("|", 1)
        email = email.strip().lower()
        if not email:
            continue
        gh_user = extract_github_username(email)
        if gh_user:
            known_github_users.add(gh_user)

    # Second pass: count commits and pick canonical names
    # Key priority: gh:username > name:lowercasename
    counts: dict[str, int] = {}
    canonical: dict[str, str] = {}  # key -> preferred display name

    for line in output.splitlines():
        line = line.strip()
        if not line or "|" not in line:
            continue
        name, email = line.rsplit("|", 1)
        name = name.strip()
        email = email.strip().lower()
        if not name or not email or name in EXCLUDED_CONTRIBUTORS:
            continue

        # Sanitize name for MDX safety and consistent deduplication
        sanitized = sanitize_name(name)
        if not sanitized:
            continue

        # Determine the merge key:
        # 1. If email is a noreply email, use the extracted GitHub username
        # 2. If the author name matches a known GitHub username, use that
        # 3. Otherwise use the sanitized display name (case-insensitive)
        gh_user = extract_github_username(email)
        if gh_user:
            key = f"gh:{gh_user}"
        elif sanitized.lower() in known_github_users:
            key = f"gh:{sanitized.lower()}"
        else:
            key = f"name:{sanitized.lower()}"

        counts[key] = counts.get(key, 0) + 1

        # Prefer capitalized version, or longer name (more specific)
        if key not in canonical or (
            (sanitized[0].isupper() and not canonical[key][0].isupper())
            or (
                sanitized[0].isupper() == canonical[key][0].isupper()
                and len(sanitized) > len(canonical[key])
            )
        ):
            canonical[key] = sanitized

    # Build list with counts, sorted by count descending then name
    contributors = [(canonical[key], count) for key, count in counts.items()]
    contributors.sort(key=lambda x: (-x[1], x[0].lower()))
    return contributors


def update_credits(
    maintainers: list[tuple[str, int, dict[str, int]]],
    contributors: list[tuple[str, int]],
) -> None:
    """Update the credits.md file with maintainers and contributors."""
    content = CREDITS_FILE.read_text(encoding="utf-8")

    # Build maintainers section (GitHub usernames with profile links)
    maintainer_lines = []
    for login, merges, push_cats in maintainers:
        total_pushes = sum(push_cats.values())
        if total_pushes > 0:
            # Build categorized push breakdown
            push_parts = []
            if push_cats.get("ci", 0) > 0:
                push_parts.append(f"{push_cats['ci']} ci")
            if push_cats.get("docs only", 0) > 0:
                push_parts.append(f"{push_cats['docs only']} docs only")
            if push_cats.get("docs", 0) > 0:
                push_parts.append(f"{push_cats['docs']} docs")
            if push_cats.get("other", 0) > 0:
                push_parts.append(f"{push_cats['other']} other")
            push_str = ", ".join(push_parts)
            line = f"- [@{login}](https://github.com/{login}) ({merges} merges, {total_pushes} direct changes: {push_str})"
        else:
            line = f"- [@{login}](https://github.com/{login}) ({merges} merges)"
        maintainer_lines.append(line)

    maintainer_section = (
        "\n".join(maintainer_lines)
        if maintainer_lines
        else "_No maintainers detected._"
    )

    # Build contributors section with commit counts
    # Sanitize names to avoid MDX interpreting special characters (like {}) as JS
    contributor_lines = [
        f"{sanitize_name(name)} ({count})" for name, count in contributors
    ]
    contributor_section = (
        ", ".join(contributor_lines)
        if contributor_lines
        else "_No contributors detected._"
    )
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    contributor_section = f"{len(contributors)} contributors: {contributor_section}\n\n_Last updated: {timestamp}_"

    # Replace sections by finding markers and rebuilding
    lines = content.split("\n")
    result = []
    skip_until_next_section = False
    i = 0

    while i < len(lines):
        line = lines[i]

        if line == "## Maintainers":
            result.append(line)
            result.append("")
            result.append(maintainer_section)
            skip_until_next_section = True
            i += 1
            continue

        if line == "## Contributors":
            result.append("")
            result.append(line)
            result.append("")
            result.append(contributor_section)
            skip_until_next_section = True
            i += 1
            continue

        # Check if we hit the next section
        if skip_until_next_section and (
            line.startswith("## ") or line.startswith("> ")
        ):
            skip_until_next_section = False
            result.append("")  # blank line before next section

        if not skip_until_next_section:
            result.append(line)

        i += 1

    content = "\n".join(result)
    CREDITS_FILE.write_text(content, encoding="utf-8")
    print(f"Updated {CREDITS_FILE}")
    print(f"  Maintainers: {len(maintainers)}")
    print(f"  Contributors: {len(contributors)}")


def main() -> None:
    print("Syncing credits from git/GitHub...")
    maintainers = get_maintainers()
    contributors = get_contributors()
    update_credits(maintainers, contributors)


if __name__ == "__main__":
    main()
