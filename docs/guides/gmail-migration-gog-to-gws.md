---
summary: "Migrate Gmail integrations from gog to gws"
read_when:
  - Migrating existing Gmail automation from gog to gws
  - Updating Gmail-related skills or shell commands after gog deprecation
title: "Gmail migration: gog → gws"
---

# Gmail migration: gog → gws

If you have existing OpenClaw workflows that rely on `gog` for Gmail access, this guide covers the practical migration path to `gws`.

## What changes

The move from `gog` to `gws` is not a drop-in binary rename.

Expect changes in:

- installation method
- auth/bootstrap flow
- credential storage paths
- command syntax
- shell scripts and cron jobs that call the CLI directly

## Before you start

Write down the Gmail commands and automations you currently use.

Common places to check:

- shell scripts
- cron jobs
- OpenClaw skills or custom prompts
- README/docs in your workspace
- aliases/functions in your shell config

Useful search examples:

```bash
grep -RIn "\bgog\b" .
grep -RIn "gog gmail" .
```

Also note which Gmail account(s) are currently authorized.

## Install gws

Install `gws` using the method recommended by the `gws` project.

For Homebrew users, that usually means installing `gws` first and then verifying it is available:

```bash
gws --help
```

If `gog` is still installed, you can keep it around during the transition for comparison and rollback testing.

## Credentials do not carry over

Do **not** assume `gog` credentials can be reused by `gws`.

In practice, treat this as a fresh auth setup:

- reconfigure the OAuth client if needed
- re-authenticate the Gmail account in `gws`
- re-test mailbox access before changing automations

If you previously stored `gog` config under a path like `~/.config/gog/`, expect `gws` to use its own config location and format instead.

## Migrate commands

The biggest migration risk is direct CLI usage inside scripts, hooks, and automation.

Translate your most-used commands one by one and test each before replacing the old version.

### Common migration pattern

Old `gog` workflows often used explicit subcommands and positional arguments.
New `gws` workflows may use different command names, flags, or shortcuts.

Example pattern reported by users:

```bash
# old
gog gmail list inbox

# new
gws gmail +triage
```

That exact mapping may not cover your workflow, so verify each command against `gws --help` and the upstream `gws` docs.

### Create a translation table for your setup

A simple approach is to keep a small checklist like this while migrating:

| Old gog command | New gws command | Status |
| --- | --- | --- |
| `gog gmail list inbox` | `gws gmail +triage` | tested |
| `gog gmail search ...` | `gws ...` | pending |
| `gog gmail send ...` | `gws ...` | pending |

If a script calls `gog` in multiple places, replace one command at a time instead of rewriting the whole script blindly.

## Update OpenClaw-related references

After your `gws` commands work manually, update the places OpenClaw depends on:

- custom skills
- prompts that mention `gog`
- local docs/notes
- webhook helper scripts
- shell wrappers used by OpenClaw

Search for stale references:

```bash
grep -RIn "\bgog\b" ~/.openclaw ~/clawd .
```

## Validate the migration

Before removing `gog`, confirm all of the following:

- `gws` can list or search mail successfully
- `gws` can read the target account you expect
- outgoing mail flows still work, if you use them
- cron jobs and scripts run without interactive prompts
- OpenClaw tasks that depended on Gmail still behave correctly

A good validation flow is:

1. run the new `gws` command manually
2. run the same path from the script or automation
3. compare output with the old `gog` behavior
4. only then switch scheduled tasks over

## Rollback plan

If something breaks, rollback should be simple:

1. keep the old `gog` script around temporarily
2. restore the old command invocation
3. disable or revert the new `gws`-based automation
4. inspect auth/config differences before retrying

This is another reason to migrate incrementally instead of doing a big-bang replacement.

## Known gotchas

- `gog` and `gws` may use different config directories
- OAuth often needs to be redone from scratch
- command names and argument shapes may differ significantly
- old examples copied from notes or chat history may silently be outdated
- scripts that assume `gog` JSON/output formats may need adjustment

## Recommended approach

Use this order:

1. install `gws`
2. authenticate a test account
3. translate one working command
4. test read access
5. test send/write access if applicable
6. update scripts one at a time
7. remove `gog` only after a full validation pass

## See also

- [Gmail Pub/Sub](/automation/gmail-pubsub)
- upstream `gws` project: <https://github.com/gen-mind/gws>
