---
title: Guardian
summary: Path-based guardrails for high-risk read/write/delete/exec actions.
permalink: /security/guardian/
---

# Guardian

Guardian adds a minimal permission layer for OpenClaw tools. It is disabled by default and only blocks high-risk actions when enabled. When enabled, it enforces read/write/delete/exec actions against the rules below.

## Enable Guardian

Guardian lives in OpenClaw configuration. See [configuration](/gateway/configuration) for where to edit the config.

```yaml
guardian:
  enabled: true
  keyFileName: ".openclaw.key"
  cacheTtlMs: 3000
  failMode: "closed"
  rules:
    - mode: "deny"
      path: "/etc"
    - mode: "needs_key"
      path: "/srv/projects"
```

## Rule modes

- `public` allows the action.
- `deny` blocks the action.
- `needs_key` allows only when a key file exists in the target directory or a parent directory within five levels.

Rules are matched top to bottom and use prefix matching. If nothing matches, the default is `public`.

## Key file placement

Place a key file named `guardian.keyFileName` in a directory to authorize read/write/delete/exec actions under that path. The lookup walks upward from the target directory, stopping after five levels or the filesystem root.

## Fail mode

When `guardian.enabled` is `true`, `failMode: "closed"` blocks actions if Guardian encounters an internal error. `failMode: "open"` allows them instead.

## Audit log

Audit logging is always on. Entries are appended to:

- `~/.openclaw/logs/guardian-audit.jsonl` on macOS and Linux.
- `%USERPROFILE%\\.openclaw\\logs\\guardian-audit.jsonl` on Windows.
