---
summary: "Supported surfaces, precedence, activation triggers, degraded signals, and the audit and configure workflow"
read_when:
  - Operating secrets audit, configure, and apply safely in production
  - Understanding startup fail-fast, activation triggers, and last-known-good behavior
title: "Secrets operations and behavior"
---

This page covers day-to-day secrets operation: the supported credential surface, required behavior and precedence, activation and recovery signals, and the audit, configure, and apply workflow.

## Supported credential surface

Canonical supported and unsupported credentials are listed in [SecretRef Credential Surface](/reference/secretref-credential-surface).

<Note>
Runtime-minted or rotating credentials and OAuth refresh material are intentionally excluded from read-only SecretRef resolution.
</Note>

## Required behavior and precedence

- Field without a ref: unchanged.
- Field with a ref: required on active surfaces during activation.
- If both plaintext and ref are present, the ref takes precedence on supported precedence paths.
- The redaction sentinel `__OPENCLAW_REDACTED__` is reserved for internal config redaction/restore and is rejected as literal submitted config data.

Warning and audit signals:

- `SECRETS_REF_OVERRIDES_PLAINTEXT` (runtime warning)
- `REF_SHADOWED` (audit finding when SQLite auth-profile credentials take precedence over `openclaw.json` refs)
- `STORE_PLAINTEXT_RESIDUE` (audit finding when a stored name still has an equivalent plaintext config value)

Google Chat `serviceAccount` accepts inline JSON or a SecretRef. Doctor moves the retired sibling `serviceAccountRef` into this canonical field when it is unset.

## Activation triggers

Secret activation runs on:

- Startup (preflight plus final activation)
- Config reload hot-apply path
- Config reload restart-check path
- Manual reload via `secrets.reload`
- Gateway config write RPC preflight (`config.set` / `config.apply` / `config.patch`), validating active-surface SecretRefs within the submitted config payload before persisting edits

Activation contract:

- Success swaps the snapshot atomically.
- A strict startup failure aborts Gateway startup.
- During cold startup, a retryable resolution failure for a mapped, isolatable non-Gateway owner may publish the snapshot with that exact owner configured-unavailable. Requests for the owner fail with `SECRET_SURFACE_UNAVAILABLE`; model-provider owners do not fall back to environment or auth-profile credentials after an explicit ref fails.
- Reload and restart-check isolate eligible mapped owners. Unchanged ref identities with unchanged provider definitions and an unchanged complete non-secret owner contract retain their exact last-known-good values as stale; changed or newly configured unresolved refs publish cold for only that owner. A strict reload failure preserves the previously active snapshot.
- `config.set`, `config.apply`, and `config.patch` accept syntactically valid unresolved refs for isolatable owners and return a redacted `degradedSecretOwners` report. Gateway ingress auth, structurally invalid config or resolved values, policy violations, and unknown owners still reject before disk mutation.
- Healthy sibling owners resolve and publish normally even when another owner is cold or stale.
- Providing an explicit per-call channel token to an outbound helper/tool call does not trigger SecretRef activation; activation points remain startup, reload, and explicit `secrets.reload`.

## Degraded and recovered signals

When reload-time activation fails after a healthy state, OpenClaw enters degraded secrets state, emitting one-shot system events and log codes:

- `SECRETS_RELOADER_DEGRADED`
- `SECRETS_RELOADER_RECOVERED`

Behavior:

- Degraded: healthy owners refresh, stale owners keep last-known-good, and cold owners remain unavailable.
- Recovered: emitted once after the next successful activation. It confirms recovery, including cold owners that had no usable previous credential.
- Repeated failures while already degraded log warnings but do not re-emit the event.
- A strict startup failure never emits a degraded event, because runtime never became active. A successful startup with cold owners logs the owner degradation but does not emit a reloader event.
- Ref-scoped startup and reload failures emit a structured `SECRETS_DEGRADED` warning for each affected owner. Provider-scoped outages emit one `SECRETS_PROVIDER_DEGRADED` warning with the provider and complete affected-owner list instead of repeating the provider failure per owner. Warnings include a redacted reason, `cold` or `stale` owner state, and the `openclaw secrets reload` retry hint. They never include resolved values or SecretRef ids.
- `openclaw doctor` lists cold and stale owners with their affected config paths, redacted reason, and retry guidance.
- Channel health and status keep cold accounts visible as configured but unavailable, alongside healthy accounts. Read-only inspection does not resolve inactive credentials or probe cold accounts. `/healthz` still reports Gateway liveness; `/readyz` may report the affected channel as failing until it recovers. Restore the secret, then run `openclaw secrets reload`.

## Command-path resolution

Command paths can opt into supported SecretRef resolution via a gateway snapshot RPC. Two broad behaviors apply:

<Tabs>
  <Tab title="Strict command paths">
    For example `openclaw memory` remote-memory paths and `openclaw qr --remote` when it needs remote shared-secret refs. They read from the active snapshot and fail fast when a required SecretRef is unavailable.
  </Tab>
  <Tab title="Read-only command paths">
    For example `openclaw status`, `openclaw status --all`, `openclaw channels status`, `openclaw channels resolve`, `openclaw security audit`, and read-only doctor/config repair flows. They also prefer the active snapshot, but degrade instead of aborting when a targeted SecretRef is unavailable.

    Read-only behavior:

    - When the gateway is running, these commands read from the active snapshot first.
    - If gateway resolution is incomplete or the gateway is unavailable, they attempt a targeted local fallback for that command surface.
    - If a targeted SecretRef is still unavailable, the command continues with degraded read-only output and an explicit diagnostic that the ref is configured but unavailable in this command path.
    - This degraded behavior is command-local only; it does not weaken runtime startup, reload, or send/auth paths.

  </Tab>
</Tabs>

Agent turns using the matching prepared Gateway snapshot do not re-resolve every model and tool credential at turn startup. A configured-unavailable provider therefore does not block a turn using a healthy provider. Selecting the unavailable provider still fails closed before environment or auth-profile fallback, and explicitly targeted channel/account credentials remain strict.

Standalone agent commands without config-ref preparation and calls with a different config retain strict command-scoped resolution. A local non-delivery agent command does not resolve unrelated channel or Gateway credentials.

Other notes:

- Snapshot refresh after backend secret rotation is handled by `openclaw secrets reload`.
- Gateway RPC method used by these command paths: `secrets.resolve`.

## Audit and configure workflow

Default operator flow:

<Steps>
  <Step title="Audit current state">
    ```bash
    openclaw secrets audit --check
    ```
  </Step>
  <Step title="Configure and apply SecretRefs">
    ```bash
    openclaw secrets configure --apply
    ```
  </Step>
  <Step title="Re-audit">
    ```bash
    openclaw secrets audit --check
    ```
  </Step>
</Steps>

Do not treat the migration as complete until the re-audit is clean. If the audit still reports plaintext values at rest, the agent-access risk remains even when runtime APIs return redacted values.

If you save a plan instead of applying during `configure`, apply that saved plan with `openclaw secrets apply --from <plan-path>` before the re-audit.

<AccordionGroup>
  <Accordion title="secrets audit">
    Findings include:

    - Plaintext values at rest (`openclaw.json`, SQLite auth-profile rows, `.env`, and generated `agents/*/agent/models.json`).
    - Plaintext sensitive provider header residues in generated `models.json` entries.
    - Unresolved refs.
    - Precedence shadowing (SQLite auth profiles taking priority over `openclaw.json` refs).
    - Store residue (a stored name still has an equivalent plaintext value in config).

    Exec note: by default, audit skips exec SecretRef resolvability checks to avoid command side effects. Use `openclaw secrets audit --allow-exec` to execute exec providers during audit.

    Header residue note: sensitive provider header detection is name-heuristic based (common auth/credential header names and fragments such as `authorization`, `x-api-key`, `token`, `secret`, `password`, and `credential`).

  </Accordion>
  <Accordion title="secrets configure">
    Interactive helper that:

    - Configures `secrets.providers` first (`env`/`file`/`exec`/`store`, add/edit/remove).
    - Lets you select supported secret-bearing fields in `openclaw.json` plus the SQLite auth-profile store for one agent scope.
    - Can create a new auth-profile mapping directly in the target picker.
    - Captures SecretRef details (`source`, `provider`, `id`).
    - Runs preflight resolution and can apply immediately.

    Exec note: preflight skips exec SecretRef checks unless `--allow-exec` is set. If you apply directly from `configure --apply` and the plan includes exec refs/providers, keep `--allow-exec` set for the apply step too.

    Helpful modes:

    - `openclaw secrets configure --providers-only`
    - `openclaw secrets configure --skip-provider-setup`
    - `openclaw secrets configure --agent <id>`

    `configure` apply defaults:

    - Scrub matching static credentials from SQLite auth-profile rows for targeted providers.
    - Leave retired `auth.json` untouched; run `openclaw doctor --fix` to migrate and archive it.
    - Scrub matching known secret lines from the effective state and active-config `.env` files (deduplicated when both paths match).

  </Accordion>
  <Accordion title="secrets apply">
    Apply a saved plan:

    ```bash
    openclaw secrets apply --from /tmp/openclaw-secrets-plan.json
    openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --allow-exec
    openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run
    openclaw secrets apply --from /tmp/openclaw-secrets-plan.json --dry-run --allow-exec
    ```

    Exec note: dry-run skips exec checks unless `--allow-exec` is set; write mode rejects plans containing exec SecretRefs/providers unless `--allow-exec` is set.

    For strict target/path contract details and exact rejection rules, see [Secrets Apply Plan Contract](/gateway/secrets-plan-contract).

  </Accordion>
</AccordionGroup>

## One-way safety policy

<Warning>
OpenClaw intentionally does not write rollback backups containing historical plaintext secret values.
</Warning>

Safety model:

- Preflight must succeed before write mode.
- Runtime activation is validated before commit.
- Apply updates files using atomic file replacement and best-effort restore on failure.

## Legacy auth compatibility notes

For static credentials, runtime no longer depends on plaintext legacy auth storage.

- Runtime credential source is the resolved in-memory snapshot.
- Legacy static `api_key` entries are scrubbed when discovered.
- OAuth-related compatibility behavior remains separate.

## Control UI

Open **Settings → Secrets** to list, add, edit, bulk-import, or soft-delete team-scoped entries. Choose **Protected secret** for write-only values used by SecretRefs or destination-bound Gateway egress. Choose **Agent-readable environment** only when Gateway-hosted agent commands must receive plaintext and the agent may print, transmit, or persist it. Bulk Add accepts dotenv `NAME=VALUE` assignments, including quoted multiline values. **Protect credential-like names automatically** defaults credential-shaped names to protected mode.

This store page manages values only. Configure the corresponding `store` SecretRef on a supported field through its settings form or the raw editor. Identity-scoped entries are reserved for a later release and are not exposed by this page.
