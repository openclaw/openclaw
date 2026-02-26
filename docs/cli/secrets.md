---
summary: "CLI reference for `openclaw secrets` (reload, audit, configure, apply)"
read_when:
  - Re-resolving secret refs at runtime
  - Auditing plaintext residues and unresolved refs
  - Configuring SecretRefs and applying one-way scrub changes
title: "secrets"
---

# `openclaw secrets`

Use `openclaw secrets` to migrate credentials from plaintext to SecretRefs and keep the active secrets runtime healthy.

Command roles:

- `reload`: gateway RPC (`secrets.reload`) that re-resolves refs and swaps runtime snapshot only on full success (no config writes).
- `audit`: read-only scan of config + auth stores + legacy residues (`.env`, `auth.json`) for plaintext, unresolved refs, and precedence drift.
- `configure`: interactive planner for provider setup + target mapping + preflight (TTY required).
- `apply`: execute a saved plan (`--dry-run` for validation only), then scrub migrated plaintext residues.

Recommended operator loop:

```bash
openclaw secrets audit --check
openclaw secrets configure
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json
openclaw secrets audit --check
openclaw secrets reload
```

Exit code note for CI/gates:

- `audit --check` returns `1` on findings, `2` when refs are unresolved.

Related:

- Secrets guide: [Secrets Management](/gateway/secrets)
- Security guide: [Security](/gateway/security)

## Reload runtime snapshot

Re-resolve secret refs and atomically swap runtime snapshot.

```bash
openclaw secrets reload
openclaw secrets reload --json
```

Notes:

- Uses gateway RPC method `secrets.reload`.
- If resolution fails, gateway keeps last-known-good snapshot and returns an error (no partial activation).
- JSON response includes `warningCount`.

## Audit

Scan OpenClaw state for:

- plaintext secret storage
- unresolved refs
- precedence drift (`auth-profiles` shadowing config refs)
- legacy residues (`auth.json`, OAuth out-of-scope notes)

```bash
openclaw secrets audit
openclaw secrets audit --check
openclaw secrets audit --json
```

Exit behavior:

- `--check` exits non-zero on findings.
- unresolved refs exit with a higher-priority non-zero code.

Report shape highlights:

- `status`: `clean | findings | unresolved`
- `summary`: `plaintextCount`, `unresolvedRefCount`, `shadowedRefCount`, `legacyResidueCount`
- finding codes:
  - `PLAINTEXT_FOUND`
  - `REF_UNRESOLVED`
  - `REF_SHADOWED`
  - `LEGACY_RESIDUE`

## Configure (interactive helper)

Build provider + SecretRef changes interactively, run preflight, and optionally apply:

```bash
openclaw secrets configure
openclaw secrets configure --plan-out /tmp/openclaw-secrets-plan.json
openclaw secrets configure --apply --yes
openclaw secrets configure --providers-only
openclaw secrets configure --skip-provider-setup
openclaw secrets configure --json
```

Flow:

- Provider setup first (`add/edit/remove` for `secrets.providers` aliases).
- Credential mapping second (select fields and assign `{source, provider, id}` refs).
- Preflight and optional apply last.

Flags:

- `--providers-only`: configure `secrets.providers` only, skip credential mapping.
- `--skip-provider-setup`: skip provider setup and map credentials to existing providers.

Notes:

- Requires an interactive TTY.
- You cannot combine `--providers-only` with `--skip-provider-setup`.
- `configure` targets secret-bearing fields in `openclaw.json`.
- Include all secret-bearing fields you intend to migrate (for example both `models.providers.*.apiKey` and `skills.entries.*.apiKey`) so audit can reach a clean state.
- It performs preflight resolution before apply.
- Generated plans default to scrub options (`scrubEnv`, `scrubAuthProfilesForProviderTargets`, `scrubLegacyAuthJson` all enabled).
- Apply path is one-way for migrated plaintext values.
- Without `--apply`, CLI still prompts `Apply this plan now?` after preflight.
- With `--apply` (and no `--yes`), CLI prompts an extra irreversible-migration confirmation.

Exec provider safety note:

- Homebrew installs often expose symlinked binaries under `/opt/homebrew/bin/*`.
- Set `allowSymlinkCommand: true` only when needed for trusted package-manager paths, and pair it with `trustedDirs` (for example `["/opt/homebrew"]`).

## Apply a saved plan

Apply or preflight a plan generated previously:

```bash
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run
openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --json
```

Plan contract details (allowed target paths, validation rules, and failure semantics):

- [Secrets Apply Plan Contract](/gateway/secrets-plan-contract)

What `apply` may update:

- `openclaw.json` (SecretRef targets + provider upserts/deletes)
- `auth-profiles.json` (provider-target scrubbing)
- legacy `auth.json` residues
- `~/.openclaw/.env` known secret keys whose values were migrated

## Why no rollback backups

`secrets apply` intentionally does not write rollback backups containing old plaintext values.

Safety comes from strict preflight + atomic-ish apply with best-effort in-memory restore on failure.

## Example

```bash
# Audit first, then configure, then confirm clean:
openclaw secrets audit --check
openclaw secrets configure
openclaw secrets audit --check
```

If `audit --check` still reports plaintext findings after a partial migration, verify you also migrated skill keys (`skills.entries.*.apiKey`) and any other reported target paths.
