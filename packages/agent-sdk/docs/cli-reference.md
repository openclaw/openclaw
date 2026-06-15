# Agent SDK CLI Reference

## Commands

### `openclaw-agent pack [path]`

Validate manifest, hash files, generate `openclaw.integrity.json`.

```bash
openclaw-agent pack ./my-agent
```

### `openclaw-agent validate [path]`

Validate manifest schema, integrity hashes, and mutable instruction policy.

```bash
openclaw-agent validate ./my-agent
```

### `openclaw-agent enable [path]`

Validate, compile, copy files, write config, register package.

```bash
openclaw-agent enable ./my-agent --workspace ~/.openclaw/workspace
openclaw-agent enable ./my-agent --dry-run
```

Options: `--workspace <path>`, `--dry-run`

### `openclaw-agent disable [path]`

Remove copied files, unregister, clean up.

```bash
openclaw-agent disable ./my-agent --force
```

Options: `--workspace <path>`, `--force`

## Exit Codes

| Code | Meaning                 |
| ---- | ----------------------- |
| 0    | Success                 |
| 1    | Validation/pack failure |
| 2    | Enable/disable error    |
