---
summary: "CLI reference for `openclaw path` (inspect and edit workspace files via the `oc://` addressing scheme)"
read_when:
  - You want to read or write a leaf inside a workspace file from the terminal
  - You're scripting against workspace state and want a stable, kind-agnostic addressing scheme
  - You're debugging a `oc://` path (validate the syntax, see what it resolves to)
title: "Path"
---

# `openclaw path`

Plugin-provided shell access to the `oc://` addressing substrate: one
kind-dispatched path scheme for inspecting and editing addressable workspace
files (markdown, jsonc, jsonl). Self-hosters, plugin authors, and editor
extensions use it to read, find, or update a narrow location without
hand-rolling per-file parsers.

The CLI mirrors the substrate's public verbs:

- `resolve` is concrete and single-match.
- `find` is the multi-match verb for wildcards, unions, predicates, and
  positional expansion.
- `set` only accepts concrete paths or insertion markers; wildcard patterns are
  rejected before writing.

`path` is provided by the bundled optional `oc-path` plugin. Enable it before
first use:

```bash
openclaw plugins enable oc-path
```

## Subcommands

| Subcommand              | Purpose                                                                      |
| ----------------------- | ---------------------------------------------------------------------------- |
| `resolve <oc-path>`     | Print the concrete match at the path (or "not found").                       |
| `find <pattern>`        | Enumerate matches for a wildcard / union / predicate path.                   |
| `set <oc-path> <value>` | Write a leaf or insertion target at a concrete path. Supports `--dry-run`.   |
| `validate <oc-path>`    | Parse-only; print structural breakdown (file / section / item / field).      |
| `emit <file>`           | Round-trip a file through `parseXxx` + `emitXxx` (byte-fidelity diagnostic). |

## Global flags

| Flag            | Purpose                                                                  |
| --------------- | ------------------------------------------------------------------------ |
| `--cwd <dir>`   | Resolve the file slot against this directory (default: `process.cwd()`). |
| `--file <path>` | Override the file slot's resolved path (absolute access).                |
| `--json`        | Force JSON output (default when stdout is not a TTY).                    |
| `--human`       | Force human output (default when stdout is a TTY).                       |
| `--dry-run`     | (only on `set`) print the bytes that would be written without writing.   |

## `oc://` syntax

```
oc://FILE/SECTION/ITEM/FIELD?session=SCOPE
```

Slot rules: `field` requires `item`, and `item` requires `section`. Across all
four slots:

- **Quoted segments** — `"a/b.c"` survives `/` and `.` separators.
  Content is byte-literal; `"` and `\` are not allowed inside quotes.
  The file slot is also quote-aware: `oc://"skills/email-drafter"/Tools/$last`
  treats `skills/email-drafter` as a single file path.
- **Predicates** — `[k=v]`, `[k!=v]`, `[k<v]`, `[k<=v]`, `[k>v]`,
  `[k>=v]`. Numeric ops require both sides to coerce to finite numbers.
- **Unions** — `{a,b,c}` matches any of the alternatives.
- **Wildcards** — `*` (single sub-segment) and `**` (zero-or-more,
  recursive). `find` accepts these; `resolve` and `set` reject them as
  ambiguous.
- **Positional** — `$last` resolves to the last index / last-declared key.
- **Ordinal** — `#N` for Nth match by document order.
- **Insertion markers** — `+`, `+key`, `+nnn` for keyed / indexed
  insertion (use with `set`).
- **Session scope** — `?session=cron-daily` etc. Orthogonal to slot
  nesting. Session values are raw, not percent-decoded; they may not contain
  control characters or reserved query delimiters (`?`, `&`, `%`).

Reserved characters (`?`, `&`, `%`) outside quoted, predicate, or union
segments are rejected. Control characters (U+0000-U+001F, U+007F) are rejected
anywhere, including the `session` query value.

`formatOcPath(parseOcPath(path)) === path` is guaranteed for canonical paths.
Non-canonical query parameters are ignored except for the first non-empty
`session=` value.

## Addressing by file kind

| Kind       | Addressing model                                                                 |
| ---------- | -------------------------------------------------------------------------------- |
| Markdown   | H2 sections by slug, bullet items by slug or `#N`, frontmatter via `[frontmatter]`. |
| JSONC/JSON | Object keys and array indexes; dots split nested sub-segments unless quoted.      |
| JSONL      | Top-level line addresses (`L1`, `L2`, `$last`), then JSONC-style descent inside the line. |

`resolve` returns a structured match: `root`, `node`, `leaf`, or
`insertion-point`, with a 1-based line number. Leaf values are surfaced as text
plus a `leafType` so plugin authors can render previews without depending on
the per-kind AST shape.

## Mutation contract

`set` writes one concrete target:

- Markdown frontmatter values and `- key: value` item fields are string leaves.
  Markdown insertions append sections, frontmatter keys, or section items and
  render a canonical markdown shape for the changed file.
- JSONC leaf writes coerce the string value to the existing leaf type
  (`string`, finite `number`, `true`/`false`, or `null`). JSONC object and array
  insertions parse `<value>` as JSON and use the `jsonc-parser` edit path for
  ordinary leaf writes, preserving comments and nearby formatting.
- JSONL leaf writes coerce like JSONC inside a line. Whole-line replacement and
  append parse `<value>` as JSON. Rendered JSONL preserves the file's dominant
  LF/CRLF line-ending convention.

Use `--dry-run` before user-visible writes when the exact bytes matter. The
substrate preserves byte-identical output for parse/emit round-trips, but a
mutation can canonicalize the edited region or file depending on kind.

## Examples

```bash
# Validate a path (no filesystem access)
openclaw path validate 'oc://AGENTS.md/Tools/$last/risk'

# Read a leaf
openclaw path resolve 'oc://gateway.jsonc/version'

# Wildcard search
openclaw path find 'oc://session.jsonl/*/event' --file ./logs/session.jsonl

# Dry-run a write
openclaw path set 'oc://gateway.jsonc/version' '2.0' --dry-run

# Apply the write
openclaw path set 'oc://gateway.jsonc/version' '2.0'

# Byte-fidelity round-trip (diagnostic)
openclaw path emit ./AGENTS.md
```

More grammar examples:

```bash
# Quote keys containing / or .
openclaw path resolve 'oc://config.jsonc/agents.defaults.models/"anthropic/claude-opus-4-7"/alias'

# Predicate search over JSONC children
openclaw path find 'oc://config.jsonc/plugins/[enabled=true]/id'

# Insert into a JSONC array
openclaw path set 'oc://config.jsonc/items/+1' '{"id":"new","enabled":true}' --dry-run

# Insert a JSONC object key
openclaw path set 'oc://config.jsonc/plugins/+github' '{"enabled":true}' --dry-run

# Append a JSONL event
openclaw path set 'oc://session.jsonl/+' '{"event":"checkpoint","ok":true}' --file ./logs/session.jsonl

# Resolve the last JSONL value line
openclaw path resolve 'oc://session.jsonl/$last/event' --file ./logs/session.jsonl

# Address markdown frontmatter
openclaw path resolve 'oc://AGENTS.md/[frontmatter]/name'

# Insert markdown frontmatter
openclaw path set 'oc://AGENTS.md/[frontmatter]/+description' 'Agent instructions' --dry-run

# Find markdown item fields
openclaw path find 'oc://SKILL.md/Tools/*/send_email'

# Validate a session-scoped path
openclaw path validate 'oc://AGENTS.md/Tools/$last/risk?session=cron-daily'
```

## Exit codes

| Code | Meaning                                                                    |
| ---- | -------------------------------------------------------------------------- |
| `0`  | Success. (`resolve` / `find`: at least one match. `set`: write succeeded.) |
| `1`  | No match, or `set` rejected by the substrate (no system-level error).      |
| `2`  | Argument or parse error.                                                   |

## Output mode

`openclaw path` is TTY-aware: human-readable output on a terminal, JSON when
stdout is piped or redirected. `--json` and `--human` override the
auto-detection.

## Notes

- `set` writes bytes through the substrate's emit path, which applies the
  redaction-sentinel guard automatically. A leaf carrying
  `__OPENCLAW_REDACTED__` (verbatim or as a substring) is refused at write
  time.
- JSONC parsing and leaf edits use the plugin-local `jsonc-parser`
  dependency, so comments and formatting are preserved on ordinary leaf
  writes instead of going through a hand-rolled parser/re-render path.
- `path` does not know about LKG. If the file is LKG-tracked, the next
  observe call decides whether to promote / recover. `set --batch` for
  atomic multi-set through the LKG promote/recover lifecycle is planned
  alongside the LKG-recovery substrate.

## Related

- [CLI reference](/cli)
