---
summary: "CLI reference for `openclaw file-transfer` (review and migrate standing file-transfer approvals)"
read_when:
  - You upgraded and older file-transfer permissions stopped taking effect
  - You need the flag surface for `openclaw file-transfer approvals migrate`
  - You want a scriptable check for unreviewed file-transfer permissions
title: "File transfers"
---

# `openclaw file-transfer`

Review the standing approvals that the file-transfer plugin stores under
`plugins.entries.file-transfer.config`. The command group ships with the
file-transfer plugin. It is absent when that plugin is not installed.

## `file-transfer approvals migrate`

Review older file-transfer permissions and migrate them to the current policy
format. Older positive permissions stay inactive until this review finishes.
Deny rules, size limits, and symlink settings keep applying throughout.

```bash
openclaw file-transfer approvals migrate
openclaw file-transfer approvals migrate --dry-run
openclaw file-transfer approvals migrate --json
```

| Option      | Effect                                                                          |
| ----------- | ------------------------------------------------------------------------------- |
| `--dry-run` | Walk the prompts and print the plan. No config is written.                      |
| `--json`    | Print the unreviewed permissions as JSON and exit. No prompts, no config write. |

Both options default to off.

### Where it runs

Run the command on the Gateway host in an interactive terminal. The command
updates that host's file-transfer policy, so it refuses to run when
`gateway.mode` is `remote`. It also refuses when the OpenClaw config is invalid.
Fix the config first, then rerun.

### What the interactive run asks

The command lists one entry per legacy permission, shown as
`<node selector> · read|write · <path>`. Choose one outcome per entry:

- **Require exact reapproval** removes the ambiguous permission. The next use
  prompts once and records the exact node, command, requested path, and
  canonical target.
- **Keep as an intentional wildcard** preserves the entry as an
  operator-authored glob.
- **Remove this permission** drops the entry outright.

The command then prints a plan with the count for each outcome, plus a
downgrade note. It asks for one confirmation before writing. On success it
writes the migrated config and reports the adjacent config backup path. It says
so when that backup cannot be verified.

### Scripted and non-interactive use

`--json` reports the work without changing anything. Use it in a health check or
an upgrade script.

| Situation                     | Output                                                                                                        | Exit code |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- | --------- |
| Nothing to review             | `{"status":"ok","changed":false,"message":"No legacy permissions need review."}`                              | 0         |
| Permissions still need review | `{"status":"needs-input","changed":false,"items":[...],"command":"openclaw file-transfer approvals migrate"}` | 2         |

Without `--json`, a non-interactive shell is an error. The command tells you to
rerun it in a terminal rather than guessing an outcome for each permission.

## Related

- [CLI reference](/cli)
- [Node file transfers](/nodes/file-transfers)
- [File Transfer plugin reference](/plugins/reference/file-transfer)
