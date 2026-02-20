#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = ["tiktoken"]
# ///
"""
Codebase Scanner for Cartographer
Scans a directory tree, respects .gitignore, and outputs file paths with token counts.
Uses tiktoken for accurate Claude-compatible token estimation.

Run with: uv run scan-codebase.py [path]
UV will automatically install tiktoken in an isolated environment.
"""

import argparse
import json
import sys
from pathlib import Path

try:
    import tiktoken
except ImportError:
    print("ERROR: tiktoken not installed.", file=sys.stderr)
    print("", file=sys.stderr)
    print("Recommended: Install UV for automatic dependency handling:", file=sys.stderr)
    print("  curl -LsSf https://astral.sh/uv/install.sh | sh", file=sys.stderr)
    print("  Then run: uv run scan-codebase.py", file=sys.stderr)
    print("", file=sys.stderr)
    print("Or install tiktoken manually: pip install tiktoken", file=sys.stderr)
    sys.exit(1)

# Default patterns to always ignore (common non-code files)
DEFAULT_IGNORE = {
    # Directories
    ".git", ".svn", ".hg", "node_modules", "__pycache__", ".pytest_cache",
    ".mypy_cache", ".ruff_cache", "venv", ".venv", "env", ".env", "dist",
    "build", ".next", ".nuxt", ".output", "coverage", ".coverage", ".nyc_output",
    "target", "vendor", ".bundle", ".cargo",
    # Files
    ".DS_Store", "Thumbs.db", "*.pyc", "*.pyo", "*.so", "*.dylib", "*.dll",
    "*.exe", "*.o", "*.a", "*.lib", "*.class", "*.jar", "*.war", "*.egg",
    "*.whl", "*.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "bun.lockb", "Cargo.lock", "poetry.lock", "Gemfile.lock", "composer.lock",
    # Binary/media
    "*.png", "*.jpg", "*.jpeg", "*.gif", "*.ico", "*.svg", "*.webp",
    "*.mp3", "*.mp4", "*.wav", "*.avi", "*.mov", "*.pdf", "*.zip",
    "*.tar", "*.gz", "*.rar", "*.7z", "*.woff", "*.woff2", "*.ttf", "*.eot", "*.otf",
    # Large generated files
    "*.min.js", "*.min.css", "*.map", "*.chunk.js", "*.bundle.js",
}

def parse_gitignore(root: Path) -> list[str]:
    """Parse .gitignore file and return patterns."""
    gitignore_path = root / ".gitignore"
    patterns = []
    if gitignore_path.exists():
        with open(gitignore_path, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#"):
                    patterns.append(line)
    return patterns

def matches_pattern(path: Path, pattern: str, root: Path) -> bool:
    """Check if a path matches a gitignore-style pattern."""
    rel_path = str(path.relative_to(root))
    name = path.name

    if pattern.startswith("!"):
        return False
    if pattern.endswith("/"):
        if not path.is_dir():
            return False
        pattern = pattern[:-1]
    if "/" in pattern:
        if pattern.startswith("/"):
            pattern = pattern[1:]
        import fnmatch
        return fnmatch.fnmatch(rel_path, pattern) or fnmatch.fnmatch(rel_path, pattern + "/**")
    else:
        import fnmatch
        return fnmatch.fnmatch(name, pattern)

def should_ignore(path: Path, root: Path, gitignore_patterns: list[str]) -> bool:
    """Check if a path should be ignored."""
    name = path.name
    for pattern in DEFAULT_IGNORE:
        if "*" in pattern:
            import fnmatch
            if fnmatch.fnmatch(name, pattern):
                return True
        elif name == pattern:
            return True
    for pattern in gitignore_patterns:
        if matches_pattern(path, pattern, root):
            return True
    return False

def count_tokens(text: str, encoding: tiktoken.Encoding) -> int:
    """Count tokens in text using tiktoken."""
    try:
        return len(encoding.encode(text))
    except Exception:
        return len(text) // 4

def is_text_file(path: Path) -> bool:
    """Check if a file is likely a text file."""
    text_extensions = {
        ".py", ".js", ".ts", ".jsx", ".tsx", ".vue", ".svelte", ".html", ".htm",
        ".css", ".scss", ".sass", ".less", ".json", ".yaml", ".yml", ".toml",
        ".xml", ".md", ".mdx", ".txt", ".rst", ".sh", ".bash", ".zsh", ".fish",
        ".ps1", ".bat", ".cmd", ".sql", ".graphql", ".gql", ".proto", ".go",
        ".rs", ".rb", ".php", ".java", ".kt", ".kts", ".scala", ".clj", ".cljs",
        ".edn", ".ex", ".exs", ".erl", ".hrl", ".hs", ".lhs", ".ml", ".mli",
        ".fs", ".fsx", ".fsi", ".cs", ".vb", ".swift", ".m", ".mm", ".h", ".hpp",
        ".c", ".cpp", ".cc", ".cxx", ".r", ".R", ".jl", ".lua", ".vim", ".el",
        ".lisp", ".scm", ".rkt", ".zig", ".nim", ".d", ".dart", ".v", ".sv",
        ".vhd", ".vhdl", ".tf", ".hcl", ".dockerfile", ".containerfile",
        ".makefile", ".cmake", ".gradle", ".groovy", ".rake", ".gemspec",
        ".podspec", ".cabal", ".nix", ".dhall", ".jsonc", ".json5", ".cson",
        ".ini", ".cfg", ".conf", ".config", ".env", ".gitignore", ".gitattributes",
        ".editorconfig", ".prettierrc", ".eslintrc", ".stylelintrc", ".babelrc",
        ".nvmrc", ".ruby-version", ".python-version", ".node-version", ".tool-versions",
    }
    suffix = path.suffix.lower()
    if suffix in text_extensions:
        return True
    name = path.name.lower()
    text_names = {
        "readme", "license", "licence", "changelog", "authors", "contributors",
        "copying", "dockerfile", "containerfile", "makefile", "rakefile",
        "gemfile", "procfile", "brewfile", "vagrantfile", "justfile", "taskfile",
    }
    if name in text_names:
        return True
    try:
        with open(path, "rb") as f:
            chunk = f.read(8192)
            if b"\x00" in chunk:
                return False
            try:
                chunk.decode("utf-8")
                return True
            except UnicodeDecodeError:
                return False
    except Exception:
        return False

def scan_directory(root: Path, encoding: tiktoken.Encoding, max_file_tokens: int = 50000) -> dict:
    """Scan a directory and return file information with token counts."""
    root = root.resolve()
    gitignore_patterns = parse_gitignore(root)
    files = []
    directories = []
    skipped = []
    total_tokens = 0

    def walk(current: Path, depth: int = 0):
        nonlocal total_tokens
        if should_ignore(current, root, gitignore_patterns):
            return
        if current.is_dir():
            rel_path = str(current.relative_to(root))
            if rel_path != ".":
                directories.append(rel_path)
            try:
                entries = sorted(current.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
                for entry in entries:
                    walk(entry, depth + 1)
            except PermissionError:
                skipped.append({"path": str(current.relative_to(root)), "reason": "permission_denied"})
        elif current.is_file():
            rel_path = str(current.relative_to(root))
            size_bytes = current.stat().st_size
            if size_bytes > 1_000_000:
                skipped.append({"path": rel_path, "reason": "too_large", "size_bytes": size_bytes})
                return
            if not is_text_file(current):
                skipped.append({"path": rel_path, "reason": "binary"})
                return
            try:
                with open(current, "r", encoding="utf-8", errors="ignore") as f:
                    content = f.read()
                tokens = count_tokens(content, encoding)
                if tokens > max_file_tokens:
                    skipped.append({"path": rel_path, "reason": "too_many_tokens", "tokens": tokens})
                    return
                files.append({"path": rel_path, "tokens": tokens, "size_bytes": size_bytes})
                total_tokens += tokens
            except Exception as e:
                skipped.append({"path": rel_path, "reason": f"read_error: {str(e)}"})

    walk(root)
    return {
        "root": str(root),
        "files": files,
        "directories": directories,
        "total_tokens": total_tokens,
        "total_files": len(files),
        "skipped": skipped,
    }

def format_tree(scan_result: dict, show_tokens: bool = True) -> str:
    """Format scan results as a tree structure."""
    lines = []
    root_name = Path(scan_result["root"]).name
    lines.append(f"{root_name}/")
    lines.append(f"Total: {scan_result['total_files']} files, {scan_result['total_tokens']:,} tokens")
    lines.append("")
    tree: dict = {}
    for f in scan_result["files"]:
        parts = Path(f["path"]).parts
        current = tree
        for part in parts[:-1]:
            if part not in current:
                current[part] = {}
            current = current[part]
        current[parts[-1]] = f

    def print_tree(node: dict, prefix: str = "", is_last: bool = True):
        items = sorted(node.items(), key=lambda x: (not isinstance(x[1], dict) or "tokens" in x[1], x[0].lower()))
        for i, (name, value) in enumerate(items):
            is_last_item = i == len(items) - 1
            connector = "└── " if is_last_item else "├── "
            if isinstance(value, dict) and "tokens" not in value:
                lines.append(f"{prefix}{connector}{name}/")
                extension = "    " if is_last_item else "│   "
                print_tree(value, prefix + extension, is_last_item)
            else:
                if show_tokens:
                    tokens = value.get("tokens", 0)
                    lines.append(f"{prefix}{connector}{name} ({tokens:,} tokens)")
                else:
                    lines.append(f"{prefix}{connector}{name}")

    print_tree(tree)
    return "\n".join(lines)

def main():
    parser = argparse.ArgumentParser(description="Scan a codebase and output file paths with token counts")
    parser.add_argument("path", nargs="?", default=".", help="Path to scan (default: current directory)")
    parser.add_argument("--format", choices=["json", "tree", "compact"], default="json", help="Output format")
    parser.add_argument("--max-tokens", type=int, default=50000, help="Skip files with more than this many tokens")
    parser.add_argument("--encoding", default="cl100k_base", help="Tiktoken encoding to use")
    args = parser.parse_args()
    path = Path(args.path).resolve()

    if not path.exists():
        print(f"ERROR: Path does not exist: {path}", file=sys.stderr)
        sys.exit(1)
    if not path.is_dir():
        print(f"ERROR: Path is not a directory: {path}", file=sys.stderr)
        sys.exit(1)

    try:
        encoding = tiktoken.get_encoding(args.encoding)
    except Exception as e:
        print(f"ERROR: Failed to load encoding '{args.encoding}': {e}", file=sys.stderr)
        sys.exit(1)

    result = scan_directory(path, encoding, args.max_tokens)

    if args.format == "json":
        print(json.dumps(result, indent=2))
    elif args.format == "tree":
        print(format_tree(result, show_tokens=True))
    elif args.format == "compact":
        files_sorted = sorted(result["files"], key=lambda x: x["tokens"], reverse=True)
        print(f"# {result['root']}")
        print(f"# Total: {result['total_files']} files, {result['total_tokens']:,} tokens")
        print()
        for f in files_sorted:
            print(f"{f['tokens']:>8} {f['path']}")

if __name__ == "__main__":
    main()
