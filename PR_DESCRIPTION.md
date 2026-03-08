# Pull Request: Add sessions repair command to recover orphaned transcripts

## Summary

This PR implements **Problem 1** from GitHub issue #36694, adding a new `openclaw sessions` command suite to manage session transcripts and repair the session store.

## Changes

### New Commands

1. **`openclaw sessions repair`** - Scan for orphaned .jsonl files and register them in sessions.json
   - `--dry-run`: Preview changes without modifying files
   - `--verbose`: Show detailed output
   - `--json`: Output as JSON
   - `--agent`: Specify agent ID (default: main)

2. **`openclaw sessions rebuild`** - Alias for `repair` command

3. **`openclaw sessions status`** - Show session store health and orphaned file count

### Implementation Details

- **Automatic backup**: Creates timestamped backup before modifying sessions.json
- **Metadata extraction**: Parses session header from first line of each .jsonl file
- **Collision handling**: Gracefully handles key collisions with numeric suffixes
- **Recovery tracking**: Marks recovered sessions with `recovered: true` and `recoveredAt` timestamp
- **Error handling**: Graceful handling of missing directories and invalid files

### Files Added

- `src/cli/sessions-cli.ts` - Main CLI implementation (450 lines)
- `src/cli/sessions-cli.test.ts` - Unit tests

### Files Modified

- `src/cli/program/register.subclis.ts` - Register new sessions subcommand

## Testing

### Manual Testing

```bash
# Check session store status
openclaw sessions status

# Preview repair (dry run)
openclaw sessions repair --dry-run --verbose

# Apply repair
openclaw sessions repair --verbose

# JSON output for automation
openclaw sessions status --json
```

### Unit Tests

Run tests with:
```bash
pnpm test -- sessions-cli
```

## Use Cases

### Scenario 1: Recover from gateway crash
After a gateway crash, some sessions may not be registered in sessions.json:
```bash
openclaw sessions repair --verbose
```

### Scenario 2: Audit session store health
Check for orphaned files before running memory index:
```bash
openclaw sessions status
```

### Scenario 3: Automation/Scripting
```bash
# Check if repair is needed
STATUS=$(openclaw sessions status --json)
ORPHANED=$(echo $STATUS | jq '.orphanedFiles')

if [ "$ORPHANED" -gt 0 ]; then
  openclaw sessions repair
fi
```

## Related Issues

- Fixes #36694 (Problem 1): Sessions.json repair from orphaned transcripts

## Future Work (Problem 2)

This PR addresses Problem 1. Problem 2 (memory index checkpointing) will be addressed in a follow-up PR:
- Add incremental checkpointing to `openclaw memory index --force`
- Respect concurrency config for local embedding models
- Mark new sessions.json entries as dirty for incremental indexing

## Breaking Changes

None. This is a new feature with no breaking changes.

## Checklist

- [x] Code follows existing CLI patterns
- [x] Unit tests added
- [x] Help text with examples
- [x] Manual testing completed
- [x] No breaking changes
- [ ] Documentation updated (docs/cli/sessions.md)

## Screenshots

```
$ openclaw sessions status
=== Session Store Status ===
Agent: main
Directory: ~/.openclaw/agents/main/sessions
Registered sessions: 6
.jsonl files on disk: 6
Orphaned files: 4

Run 'openclaw sessions repair' to register 4 orphaned file(s)

$ openclaw sessions repair --verbose --dry-run
Sessions directory: ~/.openclaw/agents/main/sessions
Dry run: yes
Found 6 .jsonl files
  Already tracked: dacacc34-b980-4c96-b0f5-a7e38f06877d.jsonl
  Already tracked: 6491b325-2d6d-46c1-8902-be175ac3f85a.jsonl
  Registered: bd4828f7-5e50-4c48-b9c4-3603301b39de.jsonl → agent:main:recovered:bd4828f7-5e50-4c48-b9c4-3603301b39de
  Registered: 65d6a9b9-91d1-434a-b1e0-926d30cbca34.jsonl → agent:main:recovered:65d6a9b9-91d1-434a-b1e0-926d30cbca34
  Registered: d7899c1b-4627-4de3-b686-c752bf0afe35.jsonl → agent:main:recovered:d7899c1b-4627-4de3-b686-c752bf0afe35
  Registered: 2e268d4d-9ede-4eb3-9371-eb4ddcb23564.jsonl → agent:main:recovered:2e268d4d-9ede-4eb3-9371-eb4ddcb23564

=== Repair Summary ===
Files scanned: 6
Already tracked: 2
Newly registered: 4

NOTE: This was a dry run. No changes were made.
Run without --dry-run to apply changes.
```
