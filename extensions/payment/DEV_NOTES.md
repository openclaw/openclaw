# Payment Plugin — Dev Notes

Developer-only notes for working on `extensions/payment/`. User-facing docs land later in the feature plan's U7 (`docs/plugins/payment.md`).

The work tracked by these notes lives in:

- Feature plan: `pay-plugin/2026-04-30-001-feat-payment-plugin-plan.md`
- Dev-workflow plan: `pay-plugin/2026-04-30-002-feat-payment-plugin-dev-workflow-plan.md`

## Where things live

| Thing                             | Path                                                              |
| --------------------------------- | ----------------------------------------------------------------- |
| Plugin source                     | `extensions/payment/` (this directory)                            |
| Working branch                    | `feat/payment-plugin`, off `upstream/main`                        |
| Worktree                          | `.worktrees/payment-plugin/` (the directory you're in)            |
| Dev sandbox state                 | `~/.openclaw-pay-dev/` (gateway state, agent logs, provider auth) |
| Live install state (DO NOT TOUCH) | `~/.openclaw/`                                                    |
| Stripe Link CLI state             | `~/.link-cli/` (provider-managed)                                 |
| Inspector reports (dev-only)      | `extensions/payment/reports/` (don't `git add`)                   |

## Activating the dev sandbox

The dev sandbox keeps gateway state out of the user's live `~/.openclaw/` install. Activate it with **one** of:

```bash
# Per-command (one-shot CLI calls)
openclaw --profile pay-dev <subcommand>

# Whole shell session (recommended for active dev)
export OPENCLAW_HOME=~/.openclaw-pay-dev

# pnpm dev / pnpm openclaw need OPENCLAW_HOME, not --profile
OPENCLAW_HOME=~/.openclaw-pay-dev pnpm dev
```

`--profile pay-dev` and `OPENCLAW_HOME=~/.openclaw-pay-dev` resolve to the same path. The flag form is only honored by the homebrew-installed `openclaw`; the `pnpm dev` runner only sees env vars.

If you ever see gateway logs that include `~/.openclaw/` (without the `-pay-dev` suffix), **stop immediately** — your env var isn't set, and you're about to write into the live install.

To reset the sandbox to a clean state without losing the config:

```bash
find ~/.openclaw-pay-dev -mindepth 1 ! -name openclaw.json ! -name README.md -delete
```

## Inner loop (per edit)

```bash
pnpm test extensions/payment      # ~250ms; the smoke + unit tests
pnpm plugin:check                 # ~30s on first run, fast after; inspector
```

Run from the worktree root (`.worktrees/payment-plugin/`). `pnpm plugin:check` invokes `pnpm dlx @openclaw/plugin-inspector@0.3.5 inspect --no-openclaw` against `extensions/payment/`.

## Pre-commit gate (auto)

A pre-commit hook runs `pnpm check:changed --staged` automatically. It's fast (~100ms for typical small commits). If it fails, fix the issue and commit again — **do not amend** (per `AGENTS.md`).

## Pre-push gate (manual)

Before `git push`, run all four extension boundary scripts and the broader check, even if the inner loop and pre-commit passed:

```bash
pnpm test:extensions:package-boundary
pnpm lint:extensions:no-src-outside-plugin-sdk
pnpm lint:extensions:no-relative-outside-package
pnpm lint:extensions:no-plugin-sdk-internal
pnpm check
```

`pnpm check` is heavy (full prod typecheck + lint + guards). Run it before opening a PR.

## Stripe Link CLI dependency

The payment plugin shells out to `link-cli`. Auth state is global (lives at `~/.link-cli/`, not inside `~/.openclaw-pay-dev/`).

```bash
link-cli auth login --test       # one-time, switches to test mode
link-cli auth status --format json
```

**Approving spend requests during dev requires the Link mobile app on your phone**, signed into the same test-mode account, with biometric (Face ID / passkey) confirmation. This is by Stripe's design — the agent cannot simulate buyer approval. If a `--request-approval` call hangs, check phone notification settings before suspecting the CLI.

If `link-cli` auth gets stale (rate-limited, token expired):

```bash
rm -rf ~/.link-cli && link-cli auth login --test
```

## Plugin enablement during dev

The V1 scaffold sets `activation.onStartup: false` — `pnpm openclaw plugins list` shows payment as **disabled**. To exercise the plugin in the sandbox:

1. Enable it in `~/.openclaw-pay-dev/openclaw.json`:
   ```json
   {
     "plugins": {
       "entries": {
         "payment": { "enabled": true }
       }
     }
   }
   ```
2. Re-run `OPENCLAW_HOME=~/.openclaw-pay-dev pnpm openclaw plugins list` and confirm status flips to `enabled`.
3. As feature plan U5 lands real tool/CLI surface, the plugin will be agent-callable from there.

## Known dev-time gotchas

- **First `pnpm openclaw` after a fresh build is slow** (~25s for `bundled plugin runtime deps` step). Subsequent invocations are fast.
- **Inspector reports are written to `extensions/payment/reports/`**. Don't `git add` them. The fork's gitignore policy doesn't allow nested `.gitignore` files, so this is a developer-discipline boundary, not a tooling one.
- **`pnpm-lock.yaml` is in the root `.gitignore`** but the file is already tracked. `git status` may show it changed after `pnpm install`. Stage it deliberately when needed.
- **Don't call raw `vitest`** — always go through `pnpm test <path>` (per `AGENTS.md`).
- **Don't add `tsc --noEmit` lanes** — fork uses `tsgo`, not `tsc` (per `AGENTS.md`).
- **Don't skip the pre-commit hook with `--no-verify`**. If it fails, fix the underlying issue.

## Escaping the sandbox

If you need to run against the live install (rare; mostly for U8 final smoke gate):

```bash
unset OPENCLAW_HOME
openclaw <subcommand>          # routes to ~/.openclaw/
```

Be deliberate about this. The live install runs the user's real channels.
