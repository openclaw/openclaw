# aOa - Fast Code Intelligence

> **Core Principle:** aOa finds exact locations so you read only what you need.
> Instead of 3,700 tokens for a whole file, read 200 tokens for the relevant function.

---

## Quick Reference (Unix-style Commands)

| I want to... | Command | Scope | Speed |
|--------------|---------|-------|-------|
| Find a symbol | `aoa grep handleAuth` | Full index | <1ms |
| Find files with ANY term | `aoa grep "auth token"` | Full index | <5ms |
| Find files with ALL terms | `aoa grep -a auth,token` | Full index | ~3ms |
| Search with regex | `aoa egrep "TODO\|FIXME"` | Working set | ~20ms |
| Find files by pattern | `aoa find "*.py"` | Full index | <10ms |
| Find files by name | `aoa locate handler` | Full index | <5ms |
| See file structure | `aoa outline src/auth.js` | Single file | ~5ms |
| Find by semantic tag | `aoa grep "#authentication"` | Tagged files | <1ms |
| Filter by time | `aoa grep auth --since 1h` | Full index | <5ms |

**Scope definitions:**
- **Full index**: All indexed files in project (hundreds/thousands)
- **Working set**: Local/recently accessed files (~30-50)
- **Tagged files**: Files processed by `aoa-outline` agent

---

## When You Need to Find Code Fast

**Goal:** Locate where something is implemented

**Use:** `aoa grep <term>` or spawn `aoa-scout` agent

```bash
aoa grep handleAuth              # Single term
aoa grep "auth session token"    # Multi-term OR (ranked)
aoa grep -a auth,session,token   # Multi-term AND (all required)
aoa grep auth --since 1h         # Modified in last hour
aoa grep auth --today            # Modified today
```

**Result:** Exact file:line in <5ms (not slow grep scanning)

---

## When You Need to Understand Architecture

**Goal:** Explore patterns, understand how components connect

**Use:** Spawn `aoa-explore` agent

**Result:** Thorough analysis using indexed symbols, understands relationships

---

## When You Need File Structure

**Goal:** See functions/classes without reading the whole file

**Use:** `aoa outline <file>`

```bash
aoa outline src/auth/handler.py
aoa outline src/auth/handler.py --tags   # With AI-generated tags
```

**Result:** Symbol map with line ranges - read only what matters

---

## When You Want Semantic Search

**Goal:** Search by concept (#auth, #routing) not just text matches

**Use:** Spawn `aoa-outline` agent (runs in background)

**Result:** AI-tagged symbols searchable by purpose and domain

---

## Available Agents

| Agent | Model | Use When |
|-------|-------|----------|
| `aoa-scout` | haiku | Quick searches: "where is X?" |
| `aoa-explore` | sonnet | Deep dives: "how does auth work?" |
| `aoa-outline` | haiku | Background tagging for semantic search |

---

## How Search Works

**Three search modes:**

### 1. Symbol Lookup (O(1) - instant, full index)

**Single term** - exact symbol match:
```bash
aoa grep handleAuth              # finds "handleAuth" symbol
```

**Multi-term (space-separated)** - OR search, ranked by relevance:
```bash
aoa grep "auth session token"    # finds symbols matching ANY term, ranked
```
**Note:** This is NOT phrase search. `"auth session"` won't find the exact phrase - it finds files containing "auth" OR "session", ranked by match quality.

### 2. Multi-Term Intersection (full index)

**Comma-separated with -a flag** - AND search, files must contain ALL terms:
```bash
aoa grep -a auth,session,token   # files must contain all three terms
```
Use this when you need intersection, not union.

### 3. Pattern Search (regex - working set only)

Pattern search scans **local/recent files only** (~30-50 files), not the full index.
Use this for regex matching within your current working context.

```bash
aoa egrep "TODO|FIXME"            # regex in working set
aoa egrep "async\\s+function"     # function patterns
```

**Scope limitation:** For full-codebase pattern search, use:
```bash
aoa grep TODO                    # symbol lookup (full index, O(1))
```

---

## Time Filtering (NEW)

Filter search results by file modification time:

```bash
aoa grep auth --since 1h         # Modified in last hour
aoa grep auth --since 7d         # Modified in last week
aoa grep auth --before 1d        # Modified more than a day ago
aoa grep auth --today            # Modified in last 24h (shortcut)
```

Time units: `s` (seconds), `m` (minutes), `h` (hours), `d` (days)

---

## Output Flags (NEW)

Control output format:

```bash
aoa grep auth --json             # Raw JSON output
aoa grep auth -c                 # Count only
aoa grep auth -q                 # Quiet (exit code only)
```

---

## Tokenization Rules

`aoa grep` tokenizes on word boundaries. Understanding this prevents "0 hits" surprises:

| Pattern | Tokens | How to Search |
|---------|--------|---------------|
| `tree_sitter` | `tree_sitter` | `aoa grep tree_sitter` |
| `tree-sitter` | `tree`, `sitter` | `aoa grep tree` or `aoa grep -a tree,sitter` |
| `treeSitter` | `treeSitter` | `aoa grep treeSitter` |
| `app.post` | `app`, `post` | `aoa egrep "app\\.post"` |
| `module.exports` | `module`, `exports` | `aoa grep exports` or `aoa grep -a module,exports` |

**Tip:** When searching for hyphenated or dot-notation terms, use `aoa grep -a` with comma separation:
```bash
aoa grep -a voice,app             # finds "voice-app", "voice_app", etc.
```

---

## Common Mistakes

### Expecting phrase/proximity search
```bash
# What users try:
aoa grep "error handling"        # expects exact phrase

# What actually happens:
# Finds symbols matching "error" OR "handling", ranked by relevance

# What to use instead:
aoa grep -a error,handling       # files containing BOTH terms
aoa egrep "error.*handling"      # regex (working set only)
```

### Using egrep for full codebase search
```bash
# What users try:
aoa egrep "module\\.exports"     # expects all 700+ files

# What actually happens:
# Only scans ~30-50 local/recent files

# What to use instead:
aoa grep exports                 # symbol lookup (full index)
aoa grep -a module,exports       # intersection search
```

### Searching for dot-notation patterns
```bash
# What users try:
aoa grep app.post                # fails - dot breaks tokenization

# What to use instead:
aoa egrep "app\\.post"           # regex (escape the dot)
aoa grep post                    # then filter results manually
```

---

## Rules

1. **Always use `aoa grep`** - Never Grep or Glob (built-in)
2. **Always use `aoa outline`** - Never raw curl to API
3. **Read specific lines** - Use file:line from search results, don't read whole files
4. **Use underscores in search** - Hyphens and dots split tokens
5. **Use `aoa grep -a` for AND** - Space-separated is OR, comma with `-a` is AND

---

## The Value

| Without aOa | With aOa |
|-------------|----------|
| Grep scans entire codebase | Indexed O(1) lookup |
| Read whole files (3,700 tokens) | Read exact lines (200 tokens) |
| Slow pattern matching | <5ms symbol search |
| Text matches only | Semantic tags (#auth, #routing) |

---

## Troubleshooting

### "0 hits" for a term I know exists

1. **Check tokenization:** Hyphens and dots break tokens
   - `app.post` → search for `post` or use `aoa egrep`
   - `my-component` → search for `component` or use `aoa grep -a my,component`
2. **Try `aoa grep -a`** with individual words
3. **Use `aoa egrep`** for exact string matching (working set only)

### Pattern search returns fewer results than expected

Pattern search only scans working set (~30-50 files). For full codebase:
- Use `aoa grep` for symbol lookup
- Use traditional `grep -r` for exhaustive pattern matching

### Predictions showing low confidence (30-40%)

This is normal during cold start. Accuracy improves as:
- More intents are recorded (aim for 1000+)
- Semantic tags are added via `aoa-outline` agent
- Usage patterns establish file relationships

### Semantic search (#tags) not working

Run the `aoa-outline` agent to generate semantic tags:
```bash
# In Claude Code, spawn aoa-outline agent
# Or manually: aoa outline --store <file>
```

---

## Auto-Tag Requests (AUTOMATIC)

When you see `## aOa Auto-Tag Request` in hook output, you MUST:

1. Generate 3-5 semantic hashtags directly (YOU are the model - no Task tool needed)
2. Store the tags via the curl command shown

Example - just generate tags in your response:
```
Tags: ["#authentication", "#session-management", "#api-handler"]
```

Then store with `"tool": "Intent"`:
```bash
curl -s -X POST localhost:8080/intent -H "Content-Type: application/json" -d '{"tool": "Intent", "session_id": "...", "project_id": "...", "files": [...], "tags": ["#routing", "#auth"]}'
```

This builds semantic context automatically as you work. **Don't skip this.**

---

## Predicted Files (AUTOMATIC)

When you see `## aOa Predicted Files` in hook output, these are files predicted based on your prompt keywords.

- Review the snippets before exploring the codebase
- These predictions improve as more intents are captured
- Accuracy shows in status line (aim for 80%+)
