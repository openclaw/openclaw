---
name: aoa
description: Fast codebase search using aOa. Use instead of Grep/Glob for finding code, symbols, functions, or files. 10-50x faster than built-in search tools.
allowed-tools: Bash
---

# aOa Search (Unix-style Commands)

> **Use aOa instead of Grep/Glob.** It's faster, ranked, and context-aware.
> These commands mirror Unix conventions but are 10-100x faster via indexing.

## Quick Reference

| Command | Use For | Speed |
|---------|---------|-------|
| `aoa grep <term>` | Symbol search (O(1) indexed) | <1ms |
| `aoa grep "a b c"` | Multi-term OR search, ranked | <5ms |
| `aoa grep -a t1,t2` | Multi-term AND (all required) | <5ms |
| `aoa egrep "regex"` | Regex pattern (working set) | ~20ms |
| `aoa find "*.py"` | File discovery by pattern | <10ms |
| `aoa locate name` | Fast filename search | <5ms |
| `aoa tree [dir]` | Directory structure | <50ms |
| `aoa changes [time]` | Recently modified files | <10ms |
| `aoa hot` | Frequently accessed files | <10ms |
| `aoa intent recent` | See current work patterns | <50ms |

## Commands

### 1. Symbol Search: `aoa grep <term>`

Find any symbol, function, class, or term in the codebase.

```bash
aoa grep handleAuth           # Single term
aoa grep "auth session token" # Multi-term OR (ranked)
aoa grep -a auth,session      # Multi-term AND (all required)
aoa grep auth --since 1h      # Modified in last hour
aoa grep auth --today         # Modified today (last 24h)
aoa grep auth --json          # JSON output
aoa grep auth -c              # Count only
```

**Output:** `file:line` for all matches, ranked by relevance.

**Use instead of:** `Grep`, `Glob`, `find`

### 2. Regex Search: `aoa egrep "regex"`

Pattern matching with regex (searches working set ~30-50 files).

```bash
aoa egrep "TODO|FIXME"           # Simple regex
aoa egrep "def\\s+handle\\w+"    # Function patterns
aoa egrep "class.*Handler"       # Class patterns
```

**Use instead of:** `grep -E`, `rg`

### 3. File Discovery: `aoa find` / `aoa locate`

Find files by pattern or name.

```bash
aoa find "*.py"              # Glob pattern
aoa find --lang python       # By language
aoa locate handler           # Fast filename search
```

**Use instead of:** `find`, `ls -R`

### 4. Recent Changes: `aoa changes [time]`

Find files modified recently.

```bash
aoa changes        # Last hour
aoa changes 5m     # Last 5 minutes
aoa changes 1d     # Last day
```

### 5. Behavioral Commands

```bash
aoa hot            # Frequently accessed files
aoa touched        # Files from current session
aoa focus          # Current working context
aoa predict        # Next likely files
```

### 6. Intent Tracking: `aoa intent recent`

See what's currently being worked on based on tool usage patterns.

```bash
aoa intent recent       # Last hour
aoa intent recent 30m   # Last 30 minutes
aoa intent tags         # All semantic tags
```

## Decision Tree

1. **Know what you're looking for?** → `aoa grep <term>`
2. **Multiple related concepts?** → `aoa grep "term1 term2"` (OR) or `aoa grep -a t1,t2` (AND)
3. **Need regex matching?** → `aoa egrep "pattern"` (working set only)
4. **Find files by pattern?** → `aoa find "*.py"` or `aoa locate name`
5. **What changed recently?** → `aoa changes` or `aoa grep --today`
6. **What's being worked on?** → `aoa intent recent`

## Efficiency

| Approach | Tool Calls | Tokens | Time |
|----------|------------|--------|------|
| Grep + Read loops | 7 | 8,500 | 2.6s |
| aoa grep | 1-2 | 1,150 | 54ms |
| **Savings** | **71%** | **86%** | **98%** |

## Tips

1. **Read specific lines** - aOa returns `file:line`, so read just those lines:
   ```bash
   Read(file_path="src/auth.py", offset=45, limit=10)
   ```

2. **Don't read entire files** - Use the line numbers aOa gives you.

3. **Use time filters** - `--since 1h` or `--today` to narrow results.

4. **AND vs OR** - Space-separated is OR, comma with `-a` is AND.
