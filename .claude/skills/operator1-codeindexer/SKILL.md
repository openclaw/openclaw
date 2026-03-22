---
name: codeindexer
description: Index a codebase using tree-sitter AST parsing and PageRank to generate a compact, token-efficient code map. Use when exploring, understanding, or working with a codebase — especially large or unfamiliar projects. Triggers include "index this project", "understand this codebase", "show me the structure", "what functions are in this repo", "map this project", "search for symbols", or when needing to understand a codebase efficiently without reading every file. Also use when asked to reduce token usage, save tokens, or work more efficiently with code context.
allowed-tools: Bash(python3 *)
argument-hint: "[path] [--tokens N] [--focus file...] [--search query] [--symbol id] [--force] [--stats] [--json]"
---

# Operator1 Code Indexer

A tree-sitter + PageRank codebase indexer that generates compact, ranked code maps for token-efficient code understanding.

## How It Works

1. **Parse** — tree-sitter builds ASTs for all source files, extracting symbols (functions, classes, methods, types) with their signatures and byte offsets
2. **Graph** — builds a file dependency graph from cross-file symbol references
3. **Rank** — PageRank identifies the most important/connected files and symbols
4. **Map** — generates a compact code map within a token budget, showing only the most relevant signatures
5. **Cache** — stores the index in `.codeindexer/index.json` for instant reuse

## Supported Languages

Python, JavaScript, TypeScript, Go, Rust, Java, C, C++, Ruby, PHP, Swift, Kotlin, C#, Objective-C, Elixir, Haskell, Lua, Scala, Bash/Shell, Zig, HTML, CSS

## Usage

### Generate a Code Map (default action)

```bash
python3 ${CLAUDE_SKILL_DIR}/scripts/repomap.py /path/to/project
```

Default budget is 2048 tokens.

### Custom Token Budget

```bash
python3 ${CLAUDE_SKILL_DIR}/scripts/repomap.py /path/to/project --tokens 4096
```

### Focus on Specific Files

```bash
python3 ${CLAUDE_SKILL_DIR}/scripts/repomap.py /path/to/project --focus src/auth.py src/models.py
```

### Search for Symbols

```bash
python3 ${CLAUDE_SKILL_DIR}/scripts/repomap.py /path/to/project --search "authenticate"
```

### Get Full Symbol Source

```bash
python3 ${CLAUDE_SKILL_DIR}/scripts/repomap.py /path/to/project --symbol "src/auth.py::UserService.login#method"
```

### Show Statistics

```bash
python3 ${CLAUDE_SKILL_DIR}/scripts/repomap.py /path/to/project --stats
```

### Export Full Index as JSON

```bash
python3 ${CLAUDE_SKILL_DIR}/scripts/repomap.py /path/to/project --json
```

### Force Re-index

```bash
python3 ${CLAUDE_SKILL_DIR}/scripts/repomap.py /path/to/project --force
```

## Recommended Workflow

1. **Start** by generating the code map:

   ```bash
   python3 ${CLAUDE_SKILL_DIR}/scripts/repomap.py . --tokens 2048
   ```

2. **Search** for specific symbols:

   ```bash
   python3 ${CLAUDE_SKILL_DIR}/scripts/repomap.py . --search "functionName"
   ```

3. **Retrieve** exact symbol source:

   ```bash
   python3 ${CLAUDE_SKILL_DIR}/scripts/repomap.py . --symbol "src/file.ts::ClassName.method#method"
   ```

4. **Only read full files** when you need to edit them.

## Symbol ID Format

```
{file_path}::{qualified_name}#{kind}
```

Examples:

- `src/main.py::UserService.login#method`
- `src/utils.py::authenticate#function`
- `src/models.py::User#class`

## Cache

- Stored in `{project}/.codeindexer/index.json`
- Automatically added to `.gitignore`
- Invalidated when file mtimes change
- Use `--force` to rebuild
