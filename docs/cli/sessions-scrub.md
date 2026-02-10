# openclaw sessions scrub

Scrub secrets (API keys, tokens, passwords) from session transcript files.

## Overview

Session transcripts (`.jsonl` files in `~/.openclaw/agents/*/sessions/`) may contain sensitive data from tool calls—especially from early versions before runtime redaction was implemented, or from `config.get` calls that exposed credentials.

The `sessions scrub` command provides **at-rest scrubbing**: it scans all session files and redacts secrets using the same patterns as runtime redaction, then overwrites the files.

## Usage

```bash
# Dry run: preview what would be scrubbed
openclaw sessions scrub --dry-run

# Scrub all session files (creates .bak backups by default)
openclaw sessions scrub

# Scrub with verbose output
openclaw sessions scrub --verbose

# Scrub without creating backups
openclaw sessions scrub --no-backup
```

## Options

### `--dry-run`

Report what would be scrubbed without modifying any files.

Use this to preview the impact before running the actual scrub.

### `--verbose`

Show per-file details during the scrub process.

Without this flag, only summary statistics are shown.

### `--no-backup`

Skip creating `.bak` backup files.

By default, the command creates a backup of each modified file with a `.bak` extension before scrubbing.

## How it works

1. **Finds all session files**: Scans `~/.openclaw/agents/*/sessions/*.jsonl`
2. **Applies redaction patterns**: Uses the same patterns from `src/logging/redact.ts` that are used at runtime
3. **Creates backups**: Copies original files to `.bak` (unless `--no-backup` is used)
4. **Overwrites**: Writes the scrubbed content back to the original file

## Redaction patterns

The scrub command uses the canonical redaction patterns from `src/logging/redact.ts`, which include:

- Environment variables (`API_KEY=...`, `TOKEN=...`, `PASSWORD=...`)
- JSON fields (`"apiKey": "..."`, `"token": "..."`)
- CLI flags (`--api-key ...`, `--token ...`)
- Authorization headers (`Authorization: Bearer ...`)
- Common token prefixes (`sk-...`, `ghp_...`, `xox...`, `gsk_...`, etc.)
- PEM private keys

See `src/logging/redact.ts` for the complete list.

## Runtime vs At-Rest Redaction

OpenClaw provides two layers of secret protection:

### Runtime (Read-Time) Redaction

**Built-in and always active** (unless explicitly disabled).

When session files are read for memory search or context, sensitive data is redacted on the fly. The raw `.jsonl` files on disk may still contain secrets, but they are masked before being surfaced to agents or the UI.

### At-Rest Scrubbing

**Optional manual cleanup** for historical sessions.

The `sessions scrub` command provides retroactive scrubbing for:

- Sessions created before runtime redaction was implemented
- Sessions where redaction was disabled
- Sessions where patterns were incomplete or missed edge cases

## When to use

### Run `sessions scrub` if

- You're upgrading from an older version without runtime redaction
- You suspect session files contain unredacted secrets from tool calls
- The `openclaw doctor` command reports unredacted secrets
- You want to ensure historical sessions are clean before sharing logs

### You probably don't need to run it if

- You just set up OpenClaw (sessions are new and already redacted)
- You haven't used tools that expose secrets
- `openclaw doctor` reports no session secrets

## Doctor integration

The `openclaw doctor` command includes a check for unredacted secrets in session files.

If secrets are detected, doctor will recommend running `sessions scrub`:

```
┌  Session Secrets
│
│  - Found unredacted secrets in 12 of 98 session files scanned (~12%).
│    Session transcripts may contain API keys, tokens, or passwords from tool calls.
│
│    Fix: openclaw sessions scrub
│    Dry run: openclaw sessions scrub --dry-run
│
│    Note: Runtime redaction is already enabled (read-time protection).
│    The scrub command provides at-rest scrubbing for historical sessions.
│
└
```

## Example output

### Dry run

```bash
$ openclaw sessions scrub --dry-run

┌  Sessions Scrub
│
◇  Found 127 session file(s)
│
◇  Scan complete
│
│  Files scanned: 127
│  Files that would be modified: 14
│  Lines with secrets: 42
│
│  Run without --dry-run to apply changes. Backups will be created.
│
└  Dry run complete
```

### Actual scrub

```bash
$ openclaw sessions scrub

┌  Sessions Scrub
│
◇  Found 127 session file(s)
│
◇  Scrub complete
│
│  Files scanned: 127
│  Files modified: 14
│  Lines scrubbed: 42
│
│  Backups created with .bak extension.
│
└  Sessions scrubbed
```

## Backups

By default, the command creates a backup of each modified file before scrubbing:

```
~/.openclaw/agents/main/sessions/abc123.jsonl      # scrubbed file
~/.openclaw/agents/main/sessions/abc123.jsonl.bak  # original backup
```

To skip backups (not recommended unless you have external backups):

```bash
openclaw sessions scrub --no-backup
```

## Related

- [sessions list](./sessions.md) — List conversation sessions
- [doctor](./doctor.md) — Health checks including session secrets detection
- [security](./security.md) — Comprehensive security audit

## Technical details

- **Location**: Session files are in `~/.openclaw/agents/*/sessions/*.jsonl`
- **Patterns**: Uses `redactSensitiveText()` from `src/logging/redact.ts`
- **Scope**: Processes all agents' sessions
- **Performance**: Processes files sequentially; may take a few seconds for hundreds of sessions
- **Safety**: Creates backups by default; dry-run mode available

## Context: GitHub issue #11468

This command was created in response to issue #11468, where `config.get` calls were leaking secrets into session transcripts.

The fix involved:

1. Enabling runtime redaction for all tool responses
2. Creating this scrub command for retroactive cleanup
3. Adding a doctor check to detect the issue

See the issue for full context and discussion.
