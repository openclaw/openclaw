---
summary: "Path-scoped RWX permissions for file and exec tools"
read_when:
  - Restricting which paths an agent can read, write, or execute
  - Configuring per-agent filesystem access policies
  - Hardening single-OS-user gateway deployments
title: "Access Policy"
---

# Access policy

Access policy lets you restrict what paths an agent can **read**, **write**, or **execute** — independently of which binary is running. It enforces at two layers: the tool layer (read/write/edit/exec tools) and, on macOS, the OS layer via `sandbox-exec`.

## Why this exists

The exec allowlist controls _which binaries_ an agent can run, but it cannot restrict _which paths_ those binaries touch. A permitted `/bin/ls` on `~/workspace` is equally permitted on `~/.ssh`. Access policy closes that gap by scoping permissions to path patterns instead of binary names.

## Config file

Access policy is configured in a **sidecar file** separate from `openclaw.json`:

```
~/.openclaw/access-policy.json
```

The file is **optional** — if absent, all operations pass through unchanged with no enforcement. No restart is required when the file changes; it is read fresh on each agent turn.

## Format

```json
{
  "version": 1,
  "agents": {
    "*": {
      "policy": {
        "/**": "r--",
        "/tmp/": "rwx",
        "~/": "rw-",
        "~/dev/": "rwx",
        "~/.ssh/**": "---",
        "~/.aws/**": "---"
      }
    },
    "myagent": { "policy": { "~/private/": "rw-" } }
  }
}
```

### Permission strings

Each rule value is a three-character string — one character per operation:

| Position | Letter    | Meaning                  |
| -------- | --------- | ------------------------ |
| 0        | `r` / `-` | Read allowed / denied    |
| 1        | `w` / `-` | Write allowed / denied   |
| 2        | `x` / `-` | Execute allowed / denied |

Examples: `"rwx"` (full access), `"r--"` (read only), `"r-x"` (read + exec), `"---"` (deny all).

Use `"---"` to explicitly deny all access to a path — this is the deny mechanism. A rule with `"---"` always blocks regardless of broader rules, as long as it is the longest (most specific) matching pattern.

### Pattern syntax

- Patterns are path globs: `*` matches within a segment, `**` matches any depth.
- Trailing `/` is shorthand for `/**` — e.g. `"/tmp/"` matches everything under `/tmp`.
- `~` expands to the OS home directory (not `OPENCLAW_HOME`).
- On macOS, `/tmp`, `/var`, and `/etc` are transparently normalized from their `/private/*` real paths.

### Precedence

1. **`policy`** — longest matching glob wins (most specific pattern takes priority).
2. **Implicit fallback** — `"---"` (deny all) when no rule matches. Use `"/**": "r--"` (or any perm) as an explicit catch-all.

To deny a specific path, add a `"---"` rule that is more specific than any allow rule covering that path:

```json
"policy": {
  "/**": "r--",
  "~/.ssh/**": "---"
}
```

`~/.ssh/**` is longer than `/**` so it wins for any path under `~/.ssh/`.

## Layers

```
agents["*"] → agents["myagent"]
```

- **`agents["*"]`** — base policy applied to every agent. Put org-wide rules here. Can include both `policy` (path rules) and `scripts` (per-script overrides).
- **`agents["myagent"]`** — per-agent overrides merged on top of `agents["*"]`. `policy` rules are shallow-merged (agent wins on collision). `scripts` entries are deep-merged: the base `sha256` is always preserved and cannot be overridden by an agent block.

Named agents can also add their own `scripts` block, which is merged with the base scripts config.

## Per-script policy

The `scripts` block inside any agent config grants additional path permissions when a **specific binary** is the exec target. The override fires only when `resolvedArgv0` matches a key in `scripts` — it does not apply to unmatched exec calls.

```json
{
  "version": 1,
  "agents": {
    "*": {
      "policy": { "/**": "r--" },
      "scripts": {
        "policy": {
          "/tmp/**": "rw-"
        },
        "~/bin/deploy.sh": {
          "policy": { "~/deploy/**": "rwx" },
          "sha256": "<hex>"
        }
      }
    },
    "veda": {
      "policy": { "~/.openclaw/agents/veda/workspace/**": "rwx" },
      "scripts": {
        "~/bin/veda-tool.sh": {
          "policy": { "/opt/data/**": "r--" }
        }
      }
    }
  }
}
```

### `scripts["policy"]`

A flat `{ path: perm }` map of shared path rules. These rules are merged as the **base** for every per-script entry in the same `scripts` block, before the per-script `policy` is applied.

**Important:** `scripts["policy"]` only takes effect when an exec call matches one of the named script keys. If the `scripts` block has `scripts["policy"]` but no actual script entries, those rules are never applied.

### Per-script entries

Each key is the resolved absolute path to a script (tilde is expanded, symlinks are followed at match time).

- **`policy`** — path rules that add to or narrow the base policy for this script only. Override rules are emitted _after_ base rules in the OS sandbox profile so a script grant can reach inside a broadly denied subtree (last-match-wins semantics).
- **`sha256`** — optional SHA-256 hex of the script file. When set, exec is denied if the hash does not match. Best-effort integrity check — there is a small TOCTOU window between the hash read and kernel exec.

### Script override flow

When an exec call matches a script key:

1. `scripts["policy"]` shared rules are merged as a base.
2. The matching script's `policy` is merged on top (override key wins).
3. The resulting path rules are emitted _after_ the agent's main `policy` rules in the OS sandbox profile.

The `scripts` block is stripped from the policy after the match so it does not bleed into unrelated tool calls in the same agent turn.

## Enforcement

### Tool layer

Every read, write, edit, and exec tool call checks the resolved path against the active policy before executing. A denied path throws immediately — the operation never reaches the OS.

### OS layer (macOS)

On macOS, exec commands are additionally wrapped with `sandbox-exec` using a generated Seatbelt (SBPL) profile derived from the policy. This catches paths that expand at runtime (e.g. `cat $HOME/.ssh/id_rsa`) that config-level heuristics cannot intercept.

On Linux, a `bwrap` (bubblewrap) wrapper is generated instead.

## Validation

If the file exists but cannot be parsed, or contains structural errors (wrong nesting, misplaced keys), a clear error is logged and **all access is denied** (fail-closed) until the file is fixed:

```
[access-policy] Cannot parse ~/.openclaw/access-policy.json: ...
[access-policy] Failing closed (default: "---") until the file is fixed.
```

Common mistakes caught by the validator:

- `policy`, `rules`, `scripts`, or `base` placed at the top level instead of under `agents["*"]`
- Permission strings that are not exactly 3 characters (`"rwx"`, `"r--"`, `"---"`, etc.)
- `deny` or `default` keys inside agent blocks — these fields were removed; use `"---"` rules instead

### Bare directory paths

If a rule path has no glob suffix and resolves to a real directory (e.g. `"~/dev/openclaw"` instead of `"~/dev/openclaw/**"`), the validator auto-expands it to `/**` and logs a one-time diagnostic:

```
[access-policy] access-policy.policy["~/dev/openclaw"] is a directory — rule auto-expanded to "~/dev/openclaw/**" so it covers all contents.
```

A bare path without `/**` would match only the directory entry itself, not its contents.

Auto-expansion also applies to bare directory paths inside `scripts["policy"]` and per-script `policy` blocks.

## A2A trust scope

When an agent spawns a subagent, the subagent runs with its own agent identity and its own policy block applies. This is correct for standard OpenClaw subagent spawning.

For cross-agent MCP tool delegation (an orchestrator invoking a tool on behalf of a subagent via an MCP channel), the calling agent's identity governs — no automatic narrowing to the subagent's policy occurs. Explicit delegation controls are planned as a follow-up.

## Known limitations

**Metadata leak via directory listing.** `find`, `ls`, and shell globs use `readdir()` to enumerate directory contents, which is allowed. When content access is then denied at `open()`, the filenames are already visible in the error output. Content is protected; filenames are not. This is inherent to how OS-level enforcement works at the syscall level.

**Interpreter bypass of exec bit.** The `x` bit gates `execve()` on the file itself. Running `bash script.sh` executes bash (permitted), which reads the script as text (read permitted if `r` is set). The exec bit on the script is irrelevant for interpreter-based invocations. To prevent execution of a script entirely, deny read access to it (`"---"`).

**File-level `"---"` rules on Linux (bwrap).** On Linux, `"---"` rules are enforced at the OS layer using `bwrap --tmpfs` overlays, which only work on directories. When a `"---"` rule resolves to an existing file (e.g. `"~/.netrc": "---"`), the OS-level mount is skipped — bwrap cannot overlay a file with a tmpfs. Tool-layer enforcement still blocks read/write/edit calls for that file. However, exec commands running inside the sandbox can still access the file directly (e.g. `cat ~/.netrc`). A warning is emitted to stderr when this gap is active. To enforce at the OS layer on Linux, deny the parent directory instead (e.g. `"~/.aws/**": "---"` rather than `"~/.aws/credentials": "---"`). On macOS, seatbelt handles file-level denials correctly with `(deny file-read* (literal ...))`.

**Mid-path wildcard patterns and OS-level exec enforcement.** Patterns with a wildcard in a non-final segment — such as `skills/**/*.sh` or `logs/*/app.log` — cannot be expressed as OS-level subpath matchers. bwrap and Seatbelt do not understand glob syntax; they work with concrete directory prefixes. For non-deny rules, OpenClaw emits the longest concrete prefix (`skills/`) as an approximate OS-level rule for read and write access, which is bounded and safe. The exec bit is intentionally omitted from the OS approximation: granting exec on the entire prefix directory would allow any binary under that directory to be executed by subprocesses, not just files matching the original pattern. Exec for mid-path wildcard patterns is enforced by the tool layer only. To get OS-level exec enforcement, use a trailing-`**` pattern such as `skills/**` (which covers the directory precisely, with the file-type filter applying at the tool layer only).

**`scripts["policy"]` requires at least one script entry to take effect.** Shared script rules in `scripts["policy"]` are only applied when a specific script key matches the exec target. A `scripts` block with only `scripts["policy"]` and no named script entries has no effect on any exec call.

**No approval flow.** Access policy is fail-closed: a denied operation returns an error immediately. There is no `ask`/`on-miss` mode equivalent to exec approvals. If an agent hits a denied path, it receives a permission error and must handle it. Interactive approval for filesystem access is planned as a follow-up feature.

## Related

- [Exec approvals](/tools/exec-approvals) — allowlist-based exec gating (complements access policy)
- [Exec tool](/tools/exec) — exec tool reference
