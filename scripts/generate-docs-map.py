"""Generate docs/docs_map.md — a nested outline of all documentation pages."""
import os
import re

DOCS_DIR = "docs"
OUTPUT = "docs/docs_map.md"
EXCLUDE_DIRS = {".generated", ".i18n", "security"}


def extract_headings(filepath: str) -> list[tuple[int, str]]:
    headings = []
    try:
        with open(filepath, encoding="utf-8") as f:
            for line in f:
                m = re.match(r"^(#{1,4})\s+(.+)$", line)
                if m:
                    level = len(m.group(1))
                    text = m.group(2).strip()
                    headings.append((level, text))
    except Exception:
        pass
    return headings


def build_tree() -> dict[str, list[tuple[int, str]]]:
    tree = {}
    for root, dirs, files in os.walk(DOCS_DIR):
        dirs[:] = [d for d in dirs if not d.startswith(".") and d not in EXCLUDE_DIRS]
        for f in sorted(files):
            if not f.endswith(".md"):
                continue
            rel = os.path.relpath(os.path.join(root, f), DOCS_DIR).replace("\\", "/")
            headings = extract_headings(os.path.join(root, f))
            if headings:
                tree[rel] = headings
    return tree


def generate_map(tree: dict) -> str:
    lines = [
        "# OpenClaw Documentation Map",
        "",
        "Auto-generated outline of all documentation pages and their headings.",
        "Use this file to quickly discover what concepts live on which page.",
        "",
        "---",
        "",
    ]

    by_dir: dict[str, list[tuple[str, list[tuple[int, str]]]]] = {}
    for path, headings in sorted(tree.items()):
        parts = path.split("/")
        prefix = parts[0] if len(parts) > 1 else "(root)"
        if prefix not in by_dir:
            by_dir[prefix] = []
        by_dir[prefix].append((path, headings))

    for section in sorted(by_dir.keys()):
        lines.append(f"## {section}")
        lines.append("")
        for path, headings in sorted(by_dir[section]):
            url = f"https://docs.openclaw.ai/{path.replace('.md', '')}"
            title = path.replace(".md", "").replace("-", " ").title()
            for level, text in headings:
                if level == 1:
                    title = text
                    break
            lines.append(f"### [{title}]({url})")
            lines.append(f"`{path}`")
            lines.append("")
            for level, text in headings:
                if level >= 2:
                    indent = "  " * (level - 2)
                    lines.append(f"{indent}- {text}")
            lines.append("")

    return "\n".join(lines)


if __name__ == "__main__":
    tree = build_tree()
    content = generate_map(tree)
    with open(OUTPUT, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"Generated {OUTPUT} with {len(tree)} pages")
