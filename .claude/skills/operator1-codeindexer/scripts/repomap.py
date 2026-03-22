#!/usr/bin/env python3
"""
repomap.py — Tree-sitter + PageRank codebase indexer for Claude Code.

Parses a codebase, extracts symbols (functions, classes, methods, types),
builds a file dependency graph, ranks by importance using PageRank,
and outputs a compact repo map that fits within a token budget.

Usage:
    # Index and generate map (default 2048 tokens)
    python repomap.py /path/to/project

    # Custom token budget
    python repomap.py /path/to/project --tokens 4096

    # Focus on specific files (higher priority in ranking)
    python repomap.py /path/to/project --focus src/main.py src/auth.py

    # Search symbols in an existing index
    python repomap.py /path/to/project --search "authenticate"

    # Show full source of a specific symbol
    python repomap.py /path/to/project --symbol "src/auth.py::UserService.login#method"

    # Force re-index (ignore cache)
    python repomap.py /path/to/project --force

    # Output index as JSON (for programmatic use)
    python repomap.py /path/to/project --json
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Language registry
# ---------------------------------------------------------------------------

LANG_REGISTRY = {}

def _try_register(name, module_name, ext_list):
    """Attempt to register a tree-sitter language."""
    try:
        mod = __import__(module_name)
        LANG_REGISTRY[name] = {
            "module": mod,
            "extensions": ext_list,
        }
    except ImportError:
        pass

_try_register("python",     "tree_sitter_python",     [".py"])
_try_register("javascript", "tree_sitter_javascript",  [".js", ".jsx", ".mjs"])
_try_register("typescript", "tree_sitter_typescript",   [".ts", ".tsx"])
_try_register("go",         "tree_sitter_go",          [".go"])
_try_register("rust",       "tree_sitter_rust",        [".rs"])
_try_register("java",       "tree_sitter_java",        [".java"])
_try_register("c",          "tree_sitter_c",           [".c", ".h"])
_try_register("cpp",        "tree_sitter_cpp",         [".cpp", ".cc", ".cxx", ".hpp", ".hxx"])
_try_register("ruby",       "tree_sitter_ruby",        [".rb"])
_try_register("php",        "tree_sitter_php",         [".php"])
_try_register("swift",      "tree_sitter_swift",       [".swift"])
_try_register("kotlin",     "tree_sitter_kotlin",      [".kt", ".kts"])
_try_register("csharp",     "tree_sitter_c_sharp",     [".cs"])
_try_register("elixir",     "tree_sitter_elixir",      [".ex", ".exs"])
_try_register("haskell",    "tree_sitter_haskell",     [".hs"])
_try_register("lua",        "tree_sitter_lua",         [".lua"])
_try_register("scala",      "tree_sitter_scala",       [".scala", ".sc"])
_try_register("bash",       "tree_sitter_bash",        [".sh", ".bash"])
_try_register("zig",        "tree_sitter_zig",         [".zig"])
_try_register("objc",       "tree_sitter_objc",        [".m", ".mm"])
_try_register("html",       "tree_sitter_html",        [".html", ".htm"])
_try_register("css",        "tree_sitter_css",         [".css"])

# Build extension -> language lookup
EXT_TO_LANG = {}
for lang_name, info in LANG_REGISTRY.items():
    for ext in info["extensions"]:
        EXT_TO_LANG[ext] = lang_name

# TypeScript needs special handling (tsx vs ts)
TS_LANG_VARIANT = {}

# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass
class Symbol:
    name: str
    qualified_name: str
    kind: str  # function, class, method, type, constant
    file_path: str
    start_line: int
    end_line: int
    start_byte: int
    end_byte: int
    signature: str  # first line / declaration
    parent: Optional[str] = None

    @property
    def symbol_id(self):
        return f"{self.file_path}::{self.qualified_name}#{self.kind}"

@dataclass
class FileInfo:
    path: str
    language: str
    symbols: list = field(default_factory=list)
    references: set = field(default_factory=set)  # identifiers referenced
    mtime: float = 0.0
    content_hash: str = ""

@dataclass
class RepoIndex:
    root_path: str
    files: dict = field(default_factory=dict)      # path -> FileInfo
    symbols: dict = field(default_factory=dict)     # symbol_id -> Symbol
    indexed_at: str = ""
    version: int = 2

# ---------------------------------------------------------------------------
# Ignore patterns
# ---------------------------------------------------------------------------

DEFAULT_IGNORE_DIRS = {
    ".git", ".svn", ".hg", "node_modules", "__pycache__", ".venv", "venv",
    "env", ".env", ".tox", ".mypy_cache", ".pytest_cache", "dist", "build",
    ".next", ".nuxt", "target", "vendor", ".idea", ".vscode",
    "coverage", ".coverage", "htmlcov", ".eggs", "*.egg-info",
}

DEFAULT_IGNORE_FILES = {
    ".DS_Store", "Thumbs.db", "package-lock.json", "yarn.lock",
    "pnpm-lock.yaml", "Cargo.lock", "poetry.lock", "Gemfile.lock",
    "composer.lock",
}

BINARY_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg",
    ".woff", ".woff2", ".ttf", ".eot", ".otf",
    ".zip", ".tar", ".gz", ".bz2", ".rar", ".7z",
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".pptx",
    ".exe", ".dll", ".so", ".dylib", ".o", ".a",
    ".pyc", ".pyo", ".class", ".jar", ".war",
    ".mp3", ".mp4", ".wav", ".avi", ".mov", ".mkv",
    ".db", ".sqlite", ".sqlite3",
}

MAX_FILE_SIZE = 500_000  # 500KB

# ---------------------------------------------------------------------------
# Tree-sitter parsing
# ---------------------------------------------------------------------------

def _get_parser(lang_name):
    """Create a tree-sitter parser for the given language."""
    import tree_sitter as ts
    info = LANG_REGISTRY.get(lang_name)
    if not info:
        return None

    mod = info["module"]

    # TypeScript module has .language_tsx() and .language_typescript()
    if lang_name == "typescript":
        # Check if we need tsx
        lang_func = getattr(mod, "language_tsx", None) or getattr(mod, "language", None)
    else:
        lang_func = getattr(mod, "language", None)

    if not lang_func:
        return None

    try:
        language = ts.Language(lang_func())
        parser = ts.Parser(language)
        return parser
    except Exception:
        return None


def _extract_symbols_from_tree(tree, source_bytes, file_path, lang_name):
    """Walk the AST and extract symbol definitions."""
    symbols = []
    lines = source_bytes.split(b"\n")

    def line_text(line_num):
        if 0 <= line_num < len(lines):
            return lines[line_num].decode("utf-8", errors="replace").rstrip()
        return ""

    def walk(node, parent_name=None):
        ntype = node.type

        sym = None

        # Python
        if lang_name == "python":
            if ntype == "function_definition":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    kind = "method" if parent_name else "function"
                    qname = f"{parent_name}.{name}" if parent_name else name
                    sig = line_text(node.start_point[0])
                    sym = Symbol(name=name, qualified_name=qname, kind=kind,
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig, parent=parent_name)
            elif ntype == "class_definition":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    sig = line_text(node.start_point[0])
                    sym = Symbol(name=name, qualified_name=name, kind="class",
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig, parent=parent_name)

        # JavaScript / TypeScript
        elif lang_name in ("javascript", "typescript"):
            if ntype in ("function_declaration", "generator_function_declaration"):
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    kind = "method" if parent_name else "function"
                    qname = f"{parent_name}.{name}" if parent_name else name
                    sig = line_text(node.start_point[0])
                    sym = Symbol(name=name, qualified_name=qname, kind=kind,
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig, parent=parent_name)
            elif ntype == "class_declaration":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    sig = line_text(node.start_point[0])
                    sym = Symbol(name=name, qualified_name=name, kind="class",
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig, parent=parent_name)
            elif ntype == "method_definition":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    qname = f"{parent_name}.{name}" if parent_name else name
                    sig = line_text(node.start_point[0])
                    sym = Symbol(name=name, qualified_name=qname, kind="method",
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig, parent=parent_name)
            # Arrow functions assigned to variables
            elif ntype == "lexical_declaration" or ntype == "variable_declaration":
                for decl in node.children:
                    if decl.type == "variable_declarator":
                        name_node = decl.child_by_field_name("name")
                        value_node = decl.child_by_field_name("value")
                        if name_node and value_node and value_node.type == "arrow_function":
                            name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                            kind = "method" if parent_name else "function"
                            qname = f"{parent_name}.{name}" if parent_name else name
                            sig = line_text(node.start_point[0])
                            sym = Symbol(name=name, qualified_name=qname, kind=kind,
                                         file_path=file_path, start_line=node.start_point[0]+1,
                                         end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                         end_byte=node.end_byte, signature=sig, parent=parent_name)
            elif ntype in ("type_alias_declaration", "interface_declaration"):
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    sig = line_text(node.start_point[0])
                    sym = Symbol(name=name, qualified_name=name, kind="type",
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig, parent=parent_name)

        # Go
        elif lang_name == "go":
            if ntype == "function_declaration":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    sig = line_text(node.start_point[0])
                    sym = Symbol(name=name, qualified_name=name, kind="function",
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig)
            elif ntype == "method_declaration":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    # Try to get receiver type
                    recv = node.child_by_field_name("receiver")
                    recv_name = ""
                    if recv:
                        for c in recv.named_children:
                            type_node = c.child_by_field_name("type")
                            if type_node:
                                recv_name = source_bytes[type_node.start_byte:type_node.end_byte].decode()
                                recv_name = recv_name.lstrip("*")
                                break
                    qname = f"{recv_name}.{name}" if recv_name else name
                    sig = line_text(node.start_point[0])
                    sym = Symbol(name=name, qualified_name=qname, kind="method",
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig, parent=recv_name or None)
            elif ntype == "type_declaration":
                for spec in node.named_children:
                    if spec.type == "type_spec":
                        name_node = spec.child_by_field_name("name")
                        if name_node:
                            name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                            sig = line_text(spec.start_point[0])
                            sym = Symbol(name=name, qualified_name=name, kind="type",
                                         file_path=file_path, start_line=spec.start_point[0]+1,
                                         end_line=spec.end_point[0]+1, start_byte=spec.start_byte,
                                         end_byte=spec.end_byte, signature=sig)

        # Rust
        elif lang_name == "rust":
            if ntype == "function_item":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    kind = "method" if parent_name else "function"
                    qname = f"{parent_name}.{name}" if parent_name else name
                    sig = line_text(node.start_point[0])
                    sym = Symbol(name=name, qualified_name=qname, kind=kind,
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig, parent=parent_name)
            elif ntype in ("struct_item", "enum_item", "trait_item"):
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    sig = line_text(node.start_point[0])
                    sym = Symbol(name=name, qualified_name=name, kind="type",
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig)
            elif ntype == "impl_item":
                # Get the type being implemented
                type_node = node.child_by_field_name("type")
                impl_name = None
                if type_node:
                    impl_name = source_bytes[type_node.start_byte:type_node.end_byte].decode()
                body = node.child_by_field_name("body")
                if body and impl_name:
                    for child in body.named_children:
                        walk(child, parent_name=impl_name)
                return  # Don't recurse normally

        # Java
        elif lang_name == "java":
            if ntype == "method_declaration":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    qname = f"{parent_name}.{name}" if parent_name else name
                    sig = line_text(node.start_point[0]).strip()
                    sym = Symbol(name=name, qualified_name=qname, kind="method",
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig, parent=parent_name)
            elif ntype == "class_declaration" or ntype == "interface_declaration":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    kind = "class" if ntype == "class_declaration" else "type"
                    sig = line_text(node.start_point[0]).strip()
                    sym = Symbol(name=name, qualified_name=name, kind=kind,
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig, parent=parent_name)

        # C / C++
        elif lang_name in ("c", "cpp"):
            if ntype == "function_definition":
                declarator = node.child_by_field_name("declarator")
                if declarator:
                    # Navigate to the actual function name
                    name_node = declarator
                    while name_node and name_node.type != "identifier":
                        name_node = name_node.child_by_field_name("declarator") or \
                                    (name_node.named_children[0] if name_node.named_children else None)
                    if name_node and name_node.type == "identifier":
                        name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                        kind = "method" if parent_name else "function"
                        qname = f"{parent_name}::{name}" if parent_name else name
                        sig = line_text(node.start_point[0]).strip()
                        sym = Symbol(name=name, qualified_name=qname, kind=kind,
                                     file_path=file_path, start_line=node.start_point[0]+1,
                                     end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                     end_byte=node.end_byte, signature=sig, parent=parent_name)
            elif ntype == "class_specifier" and lang_name == "cpp":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    sig = line_text(node.start_point[0]).strip()
                    sym = Symbol(name=name, qualified_name=name, kind="class",
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig)
            elif ntype == "struct_specifier":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    sig = line_text(node.start_point[0]).strip()
                    sym = Symbol(name=name, qualified_name=name, kind="type",
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig)

        # Ruby
        elif lang_name == "ruby":
            if ntype == "method":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    kind = "method" if parent_name else "function"
                    qname = f"{parent_name}.{name}" if parent_name else name
                    sig = line_text(node.start_point[0]).strip()
                    sym = Symbol(name=name, qualified_name=qname, kind=kind,
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig, parent=parent_name)
            elif ntype == "class":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    sig = line_text(node.start_point[0]).strip()
                    sym = Symbol(name=name, qualified_name=name, kind="class",
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig)
            elif ntype == "module":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    sig = line_text(node.start_point[0]).strip()
                    sym = Symbol(name=name, qualified_name=name, kind="type",
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig)

        # PHP
        elif lang_name == "php":
            if ntype == "function_definition":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    kind = "method" if parent_name else "function"
                    qname = f"{parent_name}.{name}" if parent_name else name
                    sig = line_text(node.start_point[0]).strip()
                    sym = Symbol(name=name, qualified_name=qname, kind=kind,
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig, parent=parent_name)
            elif ntype == "class_declaration":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    sig = line_text(node.start_point[0]).strip()
                    sym = Symbol(name=name, qualified_name=name, kind="class",
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig)
            elif ntype == "method_declaration":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    qname = f"{parent_name}.{name}" if parent_name else name
                    sig = line_text(node.start_point[0]).strip()
                    sym = Symbol(name=name, qualified_name=qname, kind="method",
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig, parent=parent_name)

        # Swift — class_declaration covers class/struct/enum/extension; protocol_declaration for protocols
        elif lang_name == "swift":
            if ntype == "function_declaration":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    kind = "method" if parent_name else "function"
                    qname = f"{parent_name}.{name}" if parent_name else name
                    sig = line_text(node.start_point[0]).strip()
                    sym = Symbol(name=name, qualified_name=qname, kind=kind,
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig, parent=parent_name)
            elif ntype == "class_declaration":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    # Detect struct/enum/extension vs class from first child keyword
                    first_kw = node.children[0].type if node.children else ""
                    kind = "class" if first_kw in ("class", "") else "type"
                    sig = line_text(node.start_point[0]).strip()
                    sym = Symbol(name=name, qualified_name=name, kind=kind,
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig, parent=parent_name)
            elif ntype == "protocol_declaration":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    sig = line_text(node.start_point[0]).strip()
                    sym = Symbol(name=name, qualified_name=name, kind="type",
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig)
            elif ntype == "protocol_function_declaration":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    qname = f"{parent_name}.{name}" if parent_name else name
                    sig = line_text(node.start_point[0]).strip()
                    sym = Symbol(name=name, qualified_name=qname, kind="method",
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig, parent=parent_name)
            elif ntype == "property_declaration":
                name_node = node.child_by_field_name("name")
                if name_node and parent_name:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    qname = f"{parent_name}.{name}"
                    sig = line_text(node.start_point[0]).strip()
                    sym = Symbol(name=name, qualified_name=qname, kind="constant",
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig, parent=parent_name)

        # Kotlin
        elif lang_name == "kotlin":
            if ntype == "function_declaration":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    kind = "method" if parent_name else "function"
                    qname = f"{parent_name}.{name}" if parent_name else name
                    sig = line_text(node.start_point[0]).strip()
                    sym = Symbol(name=name, qualified_name=qname, kind=kind,
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig, parent=parent_name)
            elif ntype == "class_declaration":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    sig = line_text(node.start_point[0]).strip()
                    sym = Symbol(name=name, qualified_name=name, kind="class",
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig, parent=parent_name)
            elif ntype == "object_declaration":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    sig = line_text(node.start_point[0]).strip()
                    sym = Symbol(name=name, qualified_name=name, kind="class",
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig, parent=parent_name)

        # C#
        elif lang_name == "csharp":
            if ntype == "method_declaration":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    qname = f"{parent_name}.{name}" if parent_name else name
                    sig = line_text(node.start_point[0]).strip()
                    sym = Symbol(name=name, qualified_name=qname, kind="method",
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig, parent=parent_name)
            elif ntype == "class_declaration":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    sig = line_text(node.start_point[0]).strip()
                    sym = Symbol(name=name, qualified_name=name, kind="class",
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig, parent=parent_name)
            elif ntype == "interface_declaration":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    sig = line_text(node.start_point[0]).strip()
                    sym = Symbol(name=name, qualified_name=name, kind="type",
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig, parent=parent_name)
            elif ntype in ("struct_declaration", "enum_declaration"):
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    sig = line_text(node.start_point[0]).strip()
                    sym = Symbol(name=name, qualified_name=name, kind="type",
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig, parent=parent_name)
            elif ntype == "namespace_declaration":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    sig = line_text(node.start_point[0]).strip()
                    sym = Symbol(name=name, qualified_name=name, kind="type",
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig)

        # Elixir — uses call nodes with identifiers like defmodule/def/defp
        elif lang_name == "elixir":
            if ntype == "call":
                # Check if it's a defmodule/def/defp/defmacro call
                first_child = node.children[0] if node.children else None
                if first_child and first_child.type == "identifier":
                    call_name = source_bytes[first_child.start_byte:first_child.end_byte].decode()
                    if call_name == "defmodule":
                        # Second child is the module name (arguments -> alias)
                        args = node.child_by_field_name("arguments") or (node.children[1] if len(node.children) > 1 else None)
                        if args:
                            for c in args.named_children if hasattr(args, 'named_children') else [args]:
                                if c.type == "alias":
                                    name = source_bytes[c.start_byte:c.end_byte].decode()
                                    sig = line_text(node.start_point[0]).strip()
                                    sym = Symbol(name=name, qualified_name=name, kind="class",
                                                 file_path=file_path, start_line=node.start_point[0]+1,
                                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                                 end_byte=node.end_byte, signature=sig)
                                    break
                    elif call_name in ("def", "defp", "defmacro", "defmacrop"):
                        args = node.children[1] if len(node.children) > 1 else None
                        if args:
                            # The function name is in a nested call or identifier
                            fn_node = None
                            if args.type == "arguments":
                                for c in args.named_children:
                                    if c.type == "call":
                                        fn_id = c.children[0] if c.children else None
                                        if fn_id and fn_id.type == "identifier":
                                            fn_node = fn_id
                                            break
                                    elif c.type == "identifier":
                                        fn_node = c
                                        break
                            elif args.type == "call":
                                fn_id = args.children[0] if args.children else None
                                if fn_id and fn_id.type == "identifier":
                                    fn_node = fn_id
                            elif args.type == "identifier":
                                fn_node = args
                            if fn_node:
                                name = source_bytes[fn_node.start_byte:fn_node.end_byte].decode()
                                kind = "method" if parent_name else "function"
                                qname = f"{parent_name}.{name}" if parent_name else name
                                sig = line_text(node.start_point[0]).strip()
                                sym = Symbol(name=name, qualified_name=qname, kind=kind,
                                             file_path=file_path, start_line=node.start_point[0]+1,
                                             end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                             end_byte=node.end_byte, signature=sig, parent=parent_name)

        # Haskell
        elif lang_name == "haskell":
            if ntype == "function":
                name_node = node.child_by_field_name("name") or (node.named_children[0] if node.named_children else None)
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    if not name.startswith("("):  # skip operator definitions
                        sig = line_text(node.start_point[0]).strip()
                        sym = Symbol(name=name, qualified_name=name, kind="function",
                                     file_path=file_path, start_line=node.start_point[0]+1,
                                     end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                     end_byte=node.end_byte, signature=sig)
            elif ntype == "data_type":
                name_node = node.child_by_field_name("name") or (node.named_children[0] if node.named_children else None)
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    sig = line_text(node.start_point[0]).strip()
                    sym = Symbol(name=name, qualified_name=name, kind="type",
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig)
            elif ntype == "class":
                name_node = node.child_by_field_name("name") or (node.named_children[0] if node.named_children else None)
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    sig = line_text(node.start_point[0]).strip()
                    sym = Symbol(name=name, qualified_name=name, kind="class",
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig)

        # Lua
        elif lang_name == "lua":
            if ntype == "function_declaration":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    # method_index_expression means Class:method
                    if name_node.type == "method_index_expression":
                        parts = name.split(":")
                        if len(parts) == 2:
                            qname = f"{parts[0]}.{parts[1]}"
                            sym = Symbol(name=parts[1], qualified_name=qname, kind="method",
                                         file_path=file_path, start_line=node.start_point[0]+1,
                                         end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                         end_byte=node.end_byte, signature=line_text(node.start_point[0]).strip(),
                                         parent=parts[0])
                        else:
                            sig = line_text(node.start_point[0]).strip()
                            sym = Symbol(name=name, qualified_name=name, kind="function",
                                         file_path=file_path, start_line=node.start_point[0]+1,
                                         end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                         end_byte=node.end_byte, signature=sig)
                    elif "." in name:
                        parts = name.rsplit(".", 1)
                        qname = f"{parts[0]}.{parts[1]}"
                        sig = line_text(node.start_point[0]).strip()
                        sym = Symbol(name=parts[1], qualified_name=qname, kind="method",
                                     file_path=file_path, start_line=node.start_point[0]+1,
                                     end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                     end_byte=node.end_byte, signature=sig, parent=parts[0])
                    else:
                        kind = "method" if parent_name else "function"
                        qname = f"{parent_name}.{name}" if parent_name else name
                        sig = line_text(node.start_point[0]).strip()
                        sym = Symbol(name=name, qualified_name=qname, kind=kind,
                                     file_path=file_path, start_line=node.start_point[0]+1,
                                     end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                     end_byte=node.end_byte, signature=sig, parent=parent_name)

        # Scala
        elif lang_name == "scala":
            if ntype == "function_definition":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    kind = "method" if parent_name else "function"
                    qname = f"{parent_name}.{name}" if parent_name else name
                    sig = line_text(node.start_point[0]).strip()
                    sym = Symbol(name=name, qualified_name=qname, kind=kind,
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig, parent=parent_name)
            elif ntype == "class_definition":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    sig = line_text(node.start_point[0]).strip()
                    sym = Symbol(name=name, qualified_name=name, kind="class",
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig, parent=parent_name)
            elif ntype == "object_definition":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    sig = line_text(node.start_point[0]).strip()
                    sym = Symbol(name=name, qualified_name=name, kind="class",
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig, parent=parent_name)
            elif ntype == "trait_definition":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    sig = line_text(node.start_point[0]).strip()
                    sym = Symbol(name=name, qualified_name=name, kind="type",
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig, parent=parent_name)

        # Bash / Shell
        elif lang_name == "bash":
            if ntype == "function_definition":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    sig = line_text(node.start_point[0]).strip()
                    sym = Symbol(name=name, qualified_name=name, kind="function",
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig)

        # Zig
        elif lang_name == "zig":
            if ntype == "function_declaration":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    kind = "method" if parent_name else "function"
                    qname = f"{parent_name}.{name}" if parent_name else name
                    sig = line_text(node.start_point[0]).strip()
                    sym = Symbol(name=name, qualified_name=qname, kind=kind,
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig, parent=parent_name)
            elif ntype == "variable_declaration":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    # Check if it's a struct/enum/union assignment
                    init = node.child_by_field_name("value") or node.child_by_field_name("init")
                    if init and init.type in ("struct_declaration", "enum_declaration", "union_declaration"):
                        sig = line_text(node.start_point[0]).strip()
                        sym = Symbol(name=name, qualified_name=name, kind="type",
                                     file_path=file_path, start_line=node.start_point[0]+1,
                                     end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                     end_byte=node.end_byte, signature=sig)
                        # Recurse into the struct body for methods
                        for child in init.named_children:
                            walk(child, parent_name=name)
                        # Skip normal recursion for this node
                        if sym:
                            symbols.append(sym)
                        return

        # Objective-C
        elif lang_name == "objc":
            if ntype == "class_interface":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    sig = line_text(node.start_point[0]).strip()
                    sym = Symbol(name=name, qualified_name=name, kind="class",
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig)
            elif ntype == "class_implementation":
                name_node = node.child_by_field_name("name")
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    sig = line_text(node.start_point[0]).strip()
                    sym = Symbol(name=name, qualified_name=name, kind="class",
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig)
            elif ntype in ("method_declaration", "method_definition"):
                # ObjC methods: - (void)methodName or + (void)methodName
                selector = node.child_by_field_name("selector")
                if selector:
                    name = source_bytes[selector.start_byte:selector.end_byte].decode()
                    qname = f"{parent_name}.{name}" if parent_name else name
                    sig = line_text(node.start_point[0]).strip()
                    sym = Symbol(name=name, qualified_name=qname, kind="method",
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig, parent=parent_name)

        elif lang_name == "html":
            if ntype == "element":
                start_tag = None
                for child in node.children:
                    if child.type == "start_tag":
                        start_tag = child
                        break
                if start_tag:
                    tag_name_node = None
                    for child in start_tag.children:
                        if child.type == "tag_name":
                            tag_name_node = child
                            break
                    if tag_name_node:
                        tag_name = source_bytes[tag_name_node.start_byte:tag_name_node.end_byte].decode()
                        # Custom elements (contain a hyphen)
                        if "-" in tag_name:
                            sig = line_text(node.start_point[0]).strip()
                            sym = Symbol(name=tag_name, qualified_name=tag_name, kind="type",
                                         file_path=file_path, start_line=node.start_point[0]+1,
                                         end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                         end_byte=node.end_byte, signature=sig)
                        else:
                            # Extract id and data-* attributes from standard elements
                            for attr_child in start_tag.children:
                                if attr_child.type == "attribute":
                                    attr_name_node = None
                                    attr_val_node = None
                                    for ac in attr_child.children:
                                        if ac.type == "attribute_name":
                                            attr_name_node = ac
                                        if ac.type == "quoted_attribute_value":
                                            for vc in ac.children:
                                                if vc.type == "attribute_value":
                                                    attr_val_node = vc
                                    if attr_name_node and attr_val_node:
                                        aname = source_bytes[attr_name_node.start_byte:attr_name_node.end_byte].decode()
                                        aval = source_bytes[attr_val_node.start_byte:attr_val_node.end_byte].decode()
                                        if aname == "id":
                                            sig = line_text(node.start_point[0]).strip()
                                            sym = Symbol(name=f"#{aval}", qualified_name=f"{tag_name}#{aval}", kind="constant",
                                                         file_path=file_path, start_line=node.start_point[0]+1,
                                                         end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                                         end_byte=node.end_byte, signature=sig)
                                            symbols.append(sym)
                                            sym = None
                                        elif aname.startswith("data-"):
                                            sig = line_text(node.start_point[0]).strip()
                                            sym = Symbol(name=aname, qualified_name=f"{tag_name}[{aname}]", kind="constant",
                                                         file_path=file_path, start_line=node.start_point[0]+1,
                                                         end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                                         end_byte=node.end_byte, signature=sig)
                                            symbols.append(sym)
                                            sym = None

        elif lang_name == "css":
            if ntype == "rule_set":
                selectors_node = None
                for child in node.children:
                    if child.type == "selectors":
                        selectors_node = child
                        break
                if selectors_node:
                    for sel in selectors_node.children:
                        if sel.type == "class_selector":
                            name_node = None
                            for c in sel.children:
                                if c.type == "class_name":
                                    name_node = c
                                    break
                            if name_node:
                                # class_name may contain an identifier child
                                name_text = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                                sig = line_text(node.start_point[0]).strip()
                                sym = Symbol(name=f".{name_text}", qualified_name=f".{name_text}", kind="type",
                                             file_path=file_path, start_line=node.start_point[0]+1,
                                             end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                             end_byte=node.end_byte, signature=sig)
                                symbols.append(sym)
                                sym = None
                        elif sel.type == "id_selector":
                            name_node = None
                            for c in sel.children:
                                if c.type == "id_name":
                                    name_node = c
                                    break
                            if name_node:
                                name_text = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                                sig = line_text(node.start_point[0]).strip()
                                sym = Symbol(name=f"#{name_text}", qualified_name=f"#{name_text}", kind="constant",
                                             file_path=file_path, start_line=node.start_point[0]+1,
                                             end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                             end_byte=node.end_byte, signature=sig)
                                symbols.append(sym)
                                sym = None
            elif ntype == "declaration":
                prop_node = node.child_by_field_name("property_name") if hasattr(node, 'child_by_field_name') else None
                if prop_node is None:
                    for child in node.children:
                        if child.type == "property_name":
                            prop_node = child
                            break
                if prop_node:
                    prop_name = source_bytes[prop_node.start_byte:prop_node.end_byte].decode()
                    if prop_name.startswith("--"):
                        sig = line_text(node.start_point[0]).strip()
                        sym = Symbol(name=prop_name, qualified_name=prop_name, kind="constant",
                                     file_path=file_path, start_line=node.start_point[0]+1,
                                     end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                     end_byte=node.end_byte, signature=sig)
            elif ntype == "keyframes_statement":
                name_node = None
                for child in node.children:
                    if child.type == "keyframes_name":
                        name_node = child
                        break
                    elif child.type == "identifier":
                        name_node = child
                        break
                if name_node:
                    name = source_bytes[name_node.start_byte:name_node.end_byte].decode()
                    sig = line_text(node.start_point[0]).strip()
                    sym = Symbol(name=f"@keyframes {name}", qualified_name=f"@keyframes {name}", kind="function",
                                 file_path=file_path, start_line=node.start_point[0]+1,
                                 end_line=node.end_point[0]+1, start_byte=node.start_byte,
                                 end_byte=node.end_byte, signature=sig)

        if sym:
            symbols.append(sym)
            new_parent = sym.qualified_name if sym.kind in ("class", "type") else parent_name
        else:
            new_parent = parent_name

        # Recurse into children
        for child in node.children:
            walk(child, new_parent)

    walk(tree.root_node)
    return symbols


def _extract_references(tree, source_bytes):
    """Extract all identifier references from a file."""
    refs = set()
    # Node types that represent identifiers across languages
    id_types = {
        "identifier", "property_identifier", "type_identifier",
        "simple_identifier",  # Swift
        "alias",  # Elixir module names
        "tag_name",  # HTML
        "class_name", "id_name", "property_name",  # CSS
    }
    def walk(node):
        if node.type in id_types:
            name = source_bytes[node.start_byte:node.end_byte].decode("utf-8", errors="replace")
            if len(name) > 1 and not name.startswith("_"):  # skip single chars and private
                refs.add(name)
        for child in node.children:
            walk(child)
    walk(tree.root_node)
    return refs


# ---------------------------------------------------------------------------
# File discovery
# ---------------------------------------------------------------------------

def discover_files(root_path, gitignore_patterns=None):
    """Walk the directory tree and find parseable source files."""
    root = Path(root_path).resolve()
    files = []

    for dirpath, dirnames, filenames in os.walk(root):
        # Filter out ignored directories (in-place to prevent os.walk descent)
        dirnames[:] = [d for d in dirnames if d not in DEFAULT_IGNORE_DIRS
                       and not d.startswith(".")]

        for fname in filenames:
            if fname in DEFAULT_IGNORE_FILES:
                continue

            fpath = Path(dirpath) / fname
            ext = fpath.suffix.lower()

            if ext in BINARY_EXTENSIONS:
                continue

            if ext not in EXT_TO_LANG:
                continue

            try:
                size = fpath.stat().st_size
                if size > MAX_FILE_SIZE or size == 0:
                    continue
            except OSError:
                continue

            rel_path = str(fpath.relative_to(root))
            files.append((rel_path, EXT_TO_LANG[ext], fpath))

    return files


# ---------------------------------------------------------------------------
# Indexing
# ---------------------------------------------------------------------------

def index_codebase(root_path, force=False):
    """Parse all files and build the symbol index."""
    root = Path(root_path).resolve()
    cache_dir = root / ".codeindexer"
    cache_file = cache_dir / "index.json"

    # Check cache
    if not force and cache_file.exists():
        try:
            cached = json.loads(cache_file.read_text())
            if cached.get("version") == 2:
                # Validate cache freshness
                stale = False
                for rel_path, finfo in cached.get("files", {}).items():
                    fp = root / rel_path
                    if fp.exists():
                        if fp.stat().st_mtime > finfo.get("mtime", 0):
                            stale = True
                            break
                    else:
                        stale = True
                        break
                if not stale:
                    # Reconstruct index from cache
                    idx = RepoIndex(root_path=str(root))
                    idx.indexed_at = cached.get("indexed_at", "")
                    for rel_path, fdata in cached["files"].items():
                        fi = FileInfo(path=rel_path, language=fdata["language"],
                                      mtime=fdata["mtime"], content_hash=fdata["content_hash"])
                        fi.references = set(fdata.get("references", []))
                        idx.files[rel_path] = fi
                    for sid, sdata in cached.get("symbols", {}).items():
                        sym = Symbol(**{k: v for k, v in sdata.items() if k != "symbol_id"})
                        idx.symbols[sid] = sym
                        # Attach to file
                        if sym.file_path in idx.files:
                            idx.files[sym.file_path].symbols.append(sym)
                    print(f"[codeindexer] Loaded cached index: {len(idx.files)} files, {len(idx.symbols)} symbols", file=sys.stderr)
                    return idx
        except (json.JSONDecodeError, KeyError):
            pass

    # Fresh index
    print(f"[codeindexer] Indexing {root}...", file=sys.stderr)
    idx = RepoIndex(root_path=str(root))
    idx.indexed_at = time.strftime("%Y-%m-%dT%H:%M:%S")

    source_files = discover_files(root)
    parsers = {}  # lang -> parser cache

    for rel_path, lang_name, abs_path in source_files:
        try:
            source = abs_path.read_bytes()
        except OSError:
            continue

        content_hash = hashlib.md5(source).hexdigest()
        mtime = abs_path.stat().st_mtime

        # Get or create parser
        if lang_name not in parsers:
            parsers[lang_name] = _get_parser(lang_name)
        parser = parsers[lang_name]
        if not parser:
            continue

        try:
            tree = parser.parse(source)
        except Exception:
            continue

        symbols = _extract_symbols_from_tree(tree, source, rel_path, lang_name)
        references = _extract_references(tree, source)

        fi = FileInfo(path=rel_path, language=lang_name, symbols=symbols,
                      references=references, mtime=mtime, content_hash=content_hash)
        idx.files[rel_path] = fi

        for sym in symbols:
            idx.symbols[sym.symbol_id] = sym

    # Save cache
    cache_dir.mkdir(exist_ok=True)
    cache_data = {
        "version": 2,
        "root_path": str(root),
        "indexed_at": idx.indexed_at,
        "files": {},
        "symbols": {},
    }
    for rel_path, fi in idx.files.items():
        cache_data["files"][rel_path] = {
            "language": fi.language,
            "mtime": fi.mtime,
            "content_hash": fi.content_hash,
            "references": list(fi.references),
        }
    for sid, sym in idx.symbols.items():
        cache_data["symbols"][sid] = {
            "name": sym.name,
            "qualified_name": sym.qualified_name,
            "kind": sym.kind,
            "file_path": sym.file_path,
            "start_line": sym.start_line,
            "end_line": sym.end_line,
            "start_byte": sym.start_byte,
            "end_byte": sym.end_byte,
            "signature": sym.signature,
            "parent": sym.parent,
        }

    cache_file.write_text(json.dumps(cache_data, indent=2))

    # Add .codeindexer to .gitignore if not already
    gitignore = root / ".gitignore"
    if gitignore.exists():
        content = gitignore.read_text()
        if ".codeindexer" not in content:
            with open(gitignore, "a") as f:
                f.write("\n# Code indexer cache\n.codeindexer/\n")
    else:
        gitignore.write_text("# Code indexer cache\n.codeindexer/\n")

    print(f"[codeindexer] Indexed {len(idx.files)} files, {len(idx.symbols)} symbols", file=sys.stderr)
    return idx


# ---------------------------------------------------------------------------
# PageRank ranking
# ---------------------------------------------------------------------------

def rank_files(idx, focus_files=None):
    """Build file dependency graph and rank using PageRank."""
    import networkx as nx

    G = nx.DiGraph()

    # Add all files as nodes
    for path in idx.files:
        G.add_node(path)

    # Build symbol name -> file lookup
    sym_name_to_files = {}
    for sym in idx.symbols.values():
        sym_name_to_files.setdefault(sym.name, set()).add(sym.file_path)

    # Add edges: if file A references a symbol defined in file B, add edge A -> B
    for path, fi in idx.files.items():
        for ref in fi.references:
            if ref in sym_name_to_files:
                for target_file in sym_name_to_files[ref]:
                    if target_file != path:
                        if G.has_edge(path, target_file):
                            G[path][target_file]["weight"] += 1
                        else:
                            G.add_edge(path, target_file, weight=1)

    # Personalization vector (focus files get higher weight)
    personalization = None
    if focus_files:
        personalization = {}
        for node in G.nodes():
            if node in focus_files:
                personalization[node] = 10.0
            else:
                personalization[node] = 1.0

    try:
        ranks = nx.pagerank(G, alpha=0.85, personalization=personalization,
                            max_iter=200, weight="weight")
    except nx.PowerIterationFailedConvergence:
        ranks = {path: 1.0 / len(G) for path in G.nodes()}

    return ranks


# ---------------------------------------------------------------------------
# Repo map generation (token-budgeted)
# ---------------------------------------------------------------------------

def _count_tokens(text):
    """Approximate token count. Uses tiktoken if available, else rough estimate."""
    try:
        import tiktoken
        enc = tiktoken.get_encoding("cl100k_base")
        return len(enc.encode(text))
    except Exception:
        # Rough approximation: ~4 chars per token
        return len(text) // 4


def generate_repomap(idx, ranks, token_budget=2048, focus_files=None):
    """Generate a compact repo map within the token budget."""
    # Sort files by rank
    sorted_files = sorted(ranks.items(), key=lambda x: -x[1])

    # Build the map incrementally
    lines = []
    lines.append("# Repository Map")
    lines.append(f"# {len(idx.files)} files, {len(idx.symbols)} symbols")
    lines.append(f"# Root: {idx.root_path}")
    lines.append("")

    current_tokens = _count_tokens("\n".join(lines))

    for file_path, rank in sorted_files:
        fi = idx.files.get(file_path)
        if not fi or not fi.symbols:
            continue

        # Build file section
        file_lines = []
        file_lines.append(f"## {file_path}")

        # Sort symbols: classes first, then functions/methods
        kind_order = {"class": 0, "type": 1, "function": 2, "method": 3, "constant": 4}
        sorted_syms = sorted(fi.symbols, key=lambda s: (kind_order.get(s.kind, 5), s.start_line))

        for sym in sorted_syms:
            # Truncate very long signatures
            sig = sym.signature[:120]
            if sym.kind == "class":
                file_lines.append(f"  {sig}")
            elif sym.kind == "method":
                file_lines.append(f"    {sig}")
            else:
                file_lines.append(f"  {sig}")

        file_lines.append("")

        section_text = "\n".join(file_lines)
        section_tokens = _count_tokens(section_text)

        if current_tokens + section_tokens > token_budget:
            # Try adding just the file header with symbol count
            summary = f"## {file_path}  ({len(fi.symbols)} symbols)\n"
            summary_tokens = _count_tokens(summary)
            if current_tokens + summary_tokens <= token_budget:
                lines.append(summary)
                current_tokens += summary_tokens
            else:
                break  # Budget exhausted
        else:
            lines.extend(file_lines)
            current_tokens += section_tokens

    # Add footer
    footer = f"\n# Map: ~{current_tokens} tokens | Budget: {token_budget} tokens"
    lines.append(footer)

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------

def search_symbols(idx, query, max_results=20):
    """Search symbols by name or qualified name."""
    query_lower = query.lower()
    results = []

    for sid, sym in idx.symbols.items():
        score = 0
        if query_lower == sym.name.lower():
            score = 100
        elif query_lower in sym.qualified_name.lower():
            score = 80
        elif query_lower in sym.name.lower():
            score = 60
        elif query_lower in sym.signature.lower():
            score = 40

        if score > 0:
            results.append((score, sym))

    results.sort(key=lambda x: -x[0])
    return results[:max_results]


def get_symbol_source(idx, symbol_id):
    """Retrieve the full source code of a specific symbol."""
    sym = idx.symbols.get(symbol_id)
    if not sym:
        return None

    root = Path(idx.root_path)
    fpath = root / sym.file_path
    if not fpath.exists():
        return None

    source = fpath.read_bytes()
    return source[sym.start_byte:sym.end_byte].decode("utf-8", errors="replace")


# ---------------------------------------------------------------------------
# Output formatters
# ---------------------------------------------------------------------------

def format_search_results(results):
    """Format search results for display."""
    lines = []
    for score, sym in results:
        lines.append(f"[{sym.kind}] {sym.symbol_id}")
        lines.append(f"  {sym.signature}")
        lines.append(f"  Lines {sym.start_line}-{sym.end_line}")
        lines.append("")
    return "\n".join(lines)


def format_index_json(idx):
    """Export index as JSON for programmatic use."""
    data = {
        "root": idx.root_path,
        "indexed_at": idx.indexed_at,
        "stats": {
            "files": len(idx.files),
            "symbols": len(idx.symbols),
            "languages": list(set(fi.language for fi in idx.files.values())),
        },
        "files": {},
        "symbols": {},
    }

    for path, fi in idx.files.items():
        data["files"][path] = {
            "language": fi.language,
            "symbol_count": len(fi.symbols),
            "symbols": [s.symbol_id for s in fi.symbols],
        }

    for sid, sym in idx.symbols.items():
        data["symbols"][sid] = {
            "name": sym.name,
            "qualified_name": sym.qualified_name,
            "kind": sym.kind,
            "file_path": sym.file_path,
            "lines": f"{sym.start_line}-{sym.end_line}",
            "signature": sym.signature,
        }

    return json.dumps(data, indent=2)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Tree-sitter + PageRank codebase indexer for Claude Code",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    parser.add_argument("path", help="Path to the project root")
    parser.add_argument("--tokens", type=int, default=2048,
                        help="Token budget for the repo map (default: 2048)")
    parser.add_argument("--focus", nargs="*", default=None,
                        help="Files to prioritize in the ranking")
    parser.add_argument("--search", type=str, default=None,
                        help="Search for symbols matching a query")
    parser.add_argument("--symbol", type=str, default=None,
                        help="Get full source of a specific symbol by ID")
    parser.add_argument("--force", action="store_true",
                        help="Force re-indexing (ignore cache)")
    parser.add_argument("--json", action="store_true",
                        help="Output full index as JSON")
    parser.add_argument("--stats", action="store_true",
                        help="Show index statistics only")

    args = parser.parse_args()

    # Index
    idx = index_codebase(args.path, force=args.force)

    if not idx.files:
        print("No parseable files found.", file=sys.stderr)
        sys.exit(1)

    # Handle different modes
    if args.search:
        results = search_symbols(idx, args.search)
        if results:
            print(format_search_results(results))
        else:
            print(f"No symbols found matching '{args.search}'")

    elif args.symbol:
        source = get_symbol_source(idx, args.symbol)
        if source:
            print(source)
        else:
            print(f"Symbol not found: {args.symbol}", file=sys.stderr)
            sys.exit(1)

    elif args.json:
        print(format_index_json(idx))

    elif args.stats:
        lang_counts = {}
        kind_counts = {}
        for fi in idx.files.values():
            lang_counts[fi.language] = lang_counts.get(fi.language, 0) + 1
        for sym in idx.symbols.values():
            kind_counts[sym.kind] = kind_counts.get(sym.kind, 0) + 1

        print(f"Root:      {idx.root_path}")
        print(f"Indexed:   {idx.indexed_at}")
        print(f"Files:     {len(idx.files)}")
        print(f"Symbols:   {len(idx.symbols)}")
        print(f"Languages: {', '.join(f'{k}({v})' for k, v in sorted(lang_counts.items()))}")
        print(f"Kinds:     {', '.join(f'{k}({v})' for k, v in sorted(kind_counts.items()))}")

    else:
        # Default: generate repo map
        focus_set = set(args.focus) if args.focus else None
        ranks = rank_files(idx, focus_files=focus_set)
        repo_map = generate_repomap(idx, ranks, token_budget=args.tokens,
                                     focus_files=focus_set)
        print(repo_map)


if __name__ == "__main__":
    main()
