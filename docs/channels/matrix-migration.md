---
summary: "How OpenClaw upgrades the previous Matrix plugin in place, including encrypted-state recovery limits and manual recovery steps."
read_when:
  - Upgrading an existing Matrix installation
  - Migrating encrypted Matrix history and device state
title: "Matrix migration"
---

Upgrade from the previous public `matrix` plugin to the current implementation.

For most users, the upgrade is in place:

- the plugin stays `@openclaw/matrix`
- the channel stays `matrix`
- your config stays under `channels.matrix`
- cached credentials stay under `~/.openclaw/credentials/matrix/`
- runtime state stays under `~/.openclaw/matrix/`

You do not need to rename config keys or reinstall the plugin under a new name.
The root `openclaw` package no longer bundles Matrix runtime code or Matrix SDK
dependencies. If `openclaw channels status` shows Matrix is configured but the
plugin is not installed, run `openclaw doctor --fix` or
`openclaw plugins install @openclaw/matrix`; do not install Matrix SDK packages
into the root OpenClaw package.

## What the migration does automatically

Matrix migration runs when the gateway starts (through the loaded Matrix plugin), when you run [`openclaw doctor --fix`](/gateway/doctor), and as a fallback when the Matrix client starts and still finds old on-disk state. Before any actionable migration step mutates on-disk state, OpenClaw creates or reuses a focused recovery snapshot.

When you use `openclaw update`, the exact trigger depends on how OpenClaw is installed:

- source installs run a non-interactive `openclaw doctor --fix` pass during the update flow, then restart the gateway by default
- package-manager installs update the package, run `openclaw doctor --non-interactive --fix`, then rely on the default gateway restart so startup can finish Matrix migration
- if you use `openclaw update --no-restart`, startup-backed Matrix migration is deferred until you later run `openclaw doctor --fix` and restart the gateway

Automatic migration covers:

- creating or reusing a pre-migration snapshot under `~/Backups/openclaw-migrations/`
- reusing your cached Matrix credentials
- keeping the same account selection and `channels.matrix` config
- moving the old flat Matrix sync store and crypto store into the current account-scoped location when the target account can be resolved safely
- importing file-based sidecar state (`bot-storage.json` sync cache, `recovery-key.json`, `legacy-crypto-migration.json`, IndexedDB snapshots) into Matrix SQLite state; migrated files are archived with a `.migrated` suffix
- extracting a previously saved Matrix room-key backup decryption key from the old rust crypto store, when that key exists locally
- reusing the most complete existing token-hash storage root for the same Matrix account, homeserver, user, and device when the access token changes later
- scanning sibling token-hash storage roots for pending encrypted-state restore metadata when the Matrix access token changed but the account/device identity stayed the same
- restoring backed-up room keys into the new crypto store on the next Matrix startup

Snapshot details:

- OpenClaw writes a marker file at `~/.openclaw/matrix/migration-snapshot.json` after a successful snapshot so later startup and repair passes can reuse the same archive.
- These automatic Matrix migration snapshots back up config + state only (`includeWorkspace: false`).
- If Matrix only has warning-only migration state, for example because `userId` or `accessToken` is still missing, OpenClaw does not create the snapshot yet because no Matrix mutation is actionable.
- If the snapshot step fails, OpenClaw skips Matrix migration for that run instead of mutating state without a recovery point.

About multi-account upgrades:

- the flat Matrix store (`~/.openclaw/matrix/bot-storage.json` and `~/.openclaw/matrix/crypto/`) came from a single-store layout, so OpenClaw can only migrate it into one resolved Matrix account target
- already account-scoped legacy Matrix stores are detected and prepared per configured Matrix account

## What the migration cannot do automatically

The previous public Matrix plugin did **not** automatically create Matrix room-key backups. It persisted local crypto state and requested device verification, but it did not guarantee that your room keys were backed up to the homeserver.

That means some encrypted installs can only be migrated partially.

OpenClaw cannot automatically recover:

- local-only room keys that were never backed up
- encrypted state when the target Matrix account cannot be resolved yet because `homeserver`, `userId`, or `accessToken` are still unavailable
- encrypted state when the old crypto store has no recorded device ID for the account
- automatic migration of one shared flat Matrix store when multiple Matrix accounts are configured but `channels.matrix.defaultAccount` is not set
- custom plugin path installs that are pinned to a repo path instead of the standard Matrix package (surfaced by `openclaw doctor`)
- a missing recovery key when the old store had backed-up keys but did not keep the decryption key locally

If your old installation had local-only encrypted history that was never backed up, some older encrypted messages may remain unreadable after the upgrade.

## Recommended upgrade flow

1. Update OpenClaw and the Matrix plugin normally.
   Prefer plain `openclaw update` without `--no-restart` so startup can finish the Matrix migration immediately.
2. Run:

   ```bash
   openclaw doctor --fix
   ```

   If Matrix has actionable migration work, doctor will create or reuse the pre-migration snapshot first and print the archive path.

3. Start or restart the gateway.
4. Check current verification and backup state:

   ```bash
   openclaw matrix verify status
   openclaw matrix verify backup status
   ```

5. Put the recovery key for the Matrix account you are repairing in an account-specific environment variable. For a single default account, `MATRIX_RECOVERY_KEY` is fine. For multiple accounts, use one variable per account, for example `MATRIX_RECOVERY_KEY_ASSISTANT`, and add `--account assistant` to the command.

6. If OpenClaw tells you a recovery key is needed, run the command for the matching account:

   ```bash
   printf '%s\n' "$MATRIX_RECOVERY_KEY" | openclaw matrix verify backup restore --recovery-key-stdin
   printf '%s\n' "$MATRIX_RECOVERY_KEY_ASSISTANT" | openclaw matrix verify backup restore --recovery-key-stdin --account assistant
   ```

7. If this device is still unverified, run the command for the matching account:

   ```bash
   printf '%s\n' "$MATRIX_RECOVERY_KEY" | openclaw matrix verify device --recovery-key-stdin
   printf '%s\n' "$MATRIX_RECOVERY_KEY_ASSISTANT" | openclaw matrix verify device --recovery-key-stdin --account assistant
   ```

   If the recovery key is accepted and backup is usable, but `Cross-signing verified`
   is still `no`, complete self-verification from another Matrix client:

   ```bash
   openclaw matrix verify self
   ```

   Accept the request in another Matrix client, compare the emoji or decimals,
   and type `yes` only when they match. The command waits for full Matrix
   identity trust before reporting success.

8. If you are intentionally abandoning unrecoverable old history and want a fresh backup baseline for future messages, run:

   ```bash
   openclaw matrix verify backup reset --yes
   ```

   Add `--rotate-recovery-key` only when the old recovery key should stop unlocking the fresh backup.

9. If no server-side key backup exists yet, create one for future recoveries:

   ```bash
   openclaw matrix verify bootstrap
   ```

## How encrypted migration works

Encrypted migration is a two-stage process:

1. Startup or `openclaw doctor --fix` creates or reuses the pre-migration snapshot if encrypted migration is actionable, then inspects the old Matrix rust crypto store through the crypto inspector bundled with the Matrix plugin.
2. If a backup decryption key is found, OpenClaw imports it into Matrix SQLite state and marks room-key restore as pending.
3. On the next Matrix startup, OpenClaw restores backed-up room keys into the new crypto store automatically. Pending restore state is also picked up from sibling token-hash storage roots when the access token rotated in between.

If the old store reports room keys that were never backed up, OpenClaw warns instead of pretending recovery succeeded.

## Common messages and what they mean

### Upgrade and detection messages

`Matrix plugin upgraded in place.` (doctor) or `matrix: plugin upgraded in place for account "..."` (startup)

- Meaning: the old on-disk Matrix state was detected and migrated into the current layout.
- What to do: nothing unless the same output also includes warnings.

`Matrix migration snapshot created before applying Matrix upgrades.` / `Matrix migration snapshot reused before applying Matrix upgrades.`

- Meaning: doctor created a recovery archive before mutating Matrix state, or found an existing snapshot marker and reused that archive instead of creating a duplicate backup. Startup logs the same as `matrix: created pre-migration backup snapshot: ...` / `matrix: reusing existing pre-migration backup snapshot: ...`.
- What to do: keep the printed archive path until you confirm migration succeeded.

`Legacy Matrix state detected at ... but channels.matrix is not configured yet.`

- Meaning: old Matrix state exists, but OpenClaw cannot map it to a current Matrix account because Matrix is not configured.
- What to do: configure `channels.matrix`, then rerun `openclaw doctor --fix` or restart the gateway.

`Legacy Matrix state detected at ... but the new account-scoped target could not be resolved yet (need homeserver, userId, and access token for channels.matrix...).`

- Meaning: OpenClaw found old state, but it still cannot determine the exact current account/device root.
- What to do: start the gateway once with a working Matrix login, or rerun `openclaw doctor --fix` after cached credentials exist.

`Legacy Matrix state detected at ... but multiple Matrix accounts are configured and channels.matrix.defaultAccount is not set.`

- Meaning: OpenClaw found one shared flat Matrix store, but it refuses to guess which named Matrix account should receive it.
- What to do: set `channels.matrix.defaultAccount` to the intended account, then rerun `openclaw doctor --fix` or restart the gateway.

The same three warnings also appear with the prefix `Legacy Matrix encrypted state detected at ...` when the blocked store is the old encrypted crypto store.

`Matrix legacy sync store not migrated because the target already exists (...)` / `Matrix legacy crypto store not migrated because the target already exists (...)`

- Meaning: the new account-scoped location already has a sync or crypto store, so OpenClaw did not overwrite it automatically.
- What to do: verify that the current account is the correct one before manually removing or moving the conflicting target.

`Failed migrating Matrix legacy sync store (...)` or `Failed migrating Matrix legacy crypto store (...)`

- Meaning: OpenClaw tried to move old Matrix state but the filesystem operation failed.
- What to do: inspect filesystem permissions and disk state, then rerun `openclaw doctor --fix`.

`Matrix migration warnings are present, but no on-disk Matrix mutation is actionable yet. No pre-migration snapshot was needed.`

- Meaning: OpenClaw detected old Matrix state, but the migration is still blocked on missing identity or credential data. Startup logs this as `matrix: migration remains in a warning-only state; no pre-migration snapshot was needed yet`.
- What to do: finish Matrix login or config setup, then rerun `openclaw doctor --fix` or restart the gateway.

`Legacy Matrix encrypted state was detected, but the Matrix crypto inspector is unavailable.`

- Meaning: OpenClaw found old encrypted Matrix state, but the Matrix plugin build is missing the crypto inspector module that inspects the old rust crypto store.
- What to do: reinstall or repair the Matrix plugin (`openclaw plugins install @openclaw/matrix`, or `openclaw plugins install ./path/to/local/matrix-plugin` for a repo checkout), then rerun `openclaw doctor --fix` or restart the gateway.

`- Failed creating a Matrix migration snapshot before repair: ...`

`- Skipping Matrix migration changes for now. Resolve the snapshot failure, then rerun "openclaw doctor --fix".`

- Meaning: OpenClaw refused to mutate Matrix state because it could not create the recovery snapshot first.
- What to do: resolve the backup error, then rerun `openclaw doctor --fix` or restart the gateway.

`Failed migrating legacy Matrix client storage: ...`

- Meaning: the Matrix client-side fallback found old storage, but the migration failed. OpenClaw rolls back completed moves and aborts that fallback instead of silently starting with a fresh store. This error also appears when the flat store targets a different account than the one currently starting.
- What to do: inspect filesystem permissions or conflicts, keep the old state intact, and retry after fixing the error.

`Matrix is installed from a custom path: ...`

- Meaning: Matrix is pinned to a path install, so mainline updates do not automatically replace it with the default Matrix package.
- What to do: reinstall with `openclaw plugins install @openclaw/matrix` when you want to return to the default Matrix plugin.

### Encrypted-state recovery messages

`matrix: restored X/Y room key(s) from legacy encrypted-state backup`

- Meaning: backed-up room keys were restored successfully into the new crypto store.
- What to do: usually nothing.

`matrix: N legacy local-only room key(s) were never backed up and could not be restored automatically`

- Meaning: some old room keys existed only in the old local store and had never been uploaded to Matrix backup. During preparation the same limit is reported as `Legacy Matrix encrypted state for account "..." contains N room key(s) that were never backed up.`
- What to do: expect some old encrypted history to remain unavailable unless you can recover those keys manually from another verified client.

`Legacy Matrix encrypted state detected at ... but no device ID was found for account "..."`

- Meaning: the old crypto store does not record which Matrix device it belonged to, so OpenClaw cannot inspect it safely.
- What to do: old encrypted history cannot be recovered automatically; OpenClaw continues without it.

`Legacy Matrix encrypted state for account "..." has backed-up room keys, but no local backup decryption key was found. Ask the operator to run "openclaw matrix verify backup restore --recovery-key <key>" after upgrade if they have the recovery key.`

- Meaning: backup exists, but OpenClaw could not recover the recovery key automatically.
- What to do: run `printf '%s\n' "$MATRIX_RECOVERY_KEY" | openclaw matrix verify backup restore --recovery-key-stdin` (preferred over passing the key as an argument).

`Failed inspecting legacy Matrix encrypted state for account "..." (...): ...`

- Meaning: OpenClaw found the old encrypted store, but it could not inspect it safely enough to prepare recovery.
- What to do: rerun `openclaw doctor --fix`. If it repeats, keep the old state directory intact and recover using another verified Matrix client plus `printf '%s\n' "$MATRIX_RECOVERY_KEY" | openclaw matrix verify backup restore --recovery-key-stdin`.

`Legacy Matrix backup key was found for account "...", but Matrix SQLite state already contains a different recovery key. Leaving the existing state unchanged.`

- Meaning: OpenClaw detected a backup key conflict and refused to overwrite the current recovery-key state automatically.
- What to do: verify which recovery key is correct before retrying any restore command.

`Legacy Matrix encrypted state for account "..." cannot be fully converted automatically because the old rust crypto store does not expose all local room keys for export.`

- Meaning: this is the hard limit of the old storage format.
- What to do: backed-up keys can still be restored, but local-only encrypted history may remain unavailable.

`matrix: failed restoring room keys from legacy encrypted-state backup: ...`

- Meaning: the new plugin attempted restore but Matrix returned an error.
- What to do: run `openclaw matrix verify backup status`, then retry with `printf '%s\n' "$MATRIX_RECOVERY_KEY" | openclaw matrix verify backup restore --recovery-key-stdin` if needed.

### Manual recovery messages

`openclaw matrix verify status` and `openclaw matrix verify backup status` print a `Backup issue:` line plus `Next steps:` guidance when the room-key backup is not healthy on this device:

| Backup issue                                                          | Meaning                                            | Fix                                                                                                                                       |
| --------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `no room-key backup exists on the homeserver`                         | nothing to restore from                            | `openclaw matrix verify bootstrap` to create a room key backup                                                                            |
| `backup decryption key is not loaded on this device`                  | key exists but is not active here                  | `openclaw matrix verify backup restore`; if it still cannot load the key, pipe the recovery key via `--recovery-key-stdin`                |
| `backup decryption key could not be loaded from secret storage (...)` | secret storage load failed or is unsupported       | pipe the recovery key: `printf '%s\n' "$MATRIX_RECOVERY_KEY" \| openclaw matrix verify backup restore --recovery-key-stdin`               |
| `backup key mismatch (...)`                                           | stored key does not match the active server backup | rerun `verify backup restore --recovery-key-stdin` with the active server backup key, or `verify backup reset --yes` for a fresh baseline |
| `backup signature chain is not trusted by this device`                | device does not trust the cross-signing chain yet  | `verify device --recovery-key-stdin`, then `verify self` from another verified client if trust is still incomplete                        |
| `backup exists but is not active on this device`                      | server backup present, local session inactive      | verify the device first, then recheck with `openclaw matrix verify backup status`                                                         |
| `backup trust state could not be fully determined`                    | diagnostics were inconclusive                      | `openclaw matrix verify status --verbose`                                                                                                 |

Other recovery errors:

`Matrix recovery key is required`

- Meaning: you tried a recovery step without supplying a recovery key when one was required.
- What to do: rerun the command with `--recovery-key-stdin`, for example `printf '%s\n' "$MATRIX_RECOVERY_KEY" | openclaw matrix verify device --recovery-key-stdin`.

`Invalid Matrix recovery key: ...`

- Meaning: the provided key could not be parsed or did not match the expected format.
- What to do: retry with the exact recovery key from your Matrix client or recovery-key export.

`Matrix recovery key was applied, but this device still lacks full Matrix identity trust.`

- Meaning: the recovery key unlocked usable backup material, but Matrix has not established full cross-signing identity trust for this device. Check the command output for `Recovery key accepted`, `Backup usable`, `Cross-signing verified`, and `Device verified by owner`.
- What to do: run `openclaw matrix verify self`, accept the request in another Matrix client, compare the SAS, and type `yes` only when it matches. Use `printf '%s\n' "$MATRIX_RECOVERY_KEY" | openclaw matrix verify bootstrap --recovery-key-stdin --force-reset-cross-signing` only when you intentionally want to replace the current cross-signing identity.

If you accept losing unrecoverable old encrypted history, you can instead reset the
current backup baseline with `openclaw matrix verify backup reset --yes`. When the
stored backup secret is broken, that reset also repairs secret storage so the
new backup key can load correctly after restart.

### Custom plugin install messages

`Matrix is installed from a custom path that no longer exists: ...`

- Meaning: your plugin install record points at a local path that is gone.
- What to do: reinstall with `openclaw plugins install @openclaw/matrix`, or if you are running from a repo checkout, `openclaw plugins install ./path/to/local/matrix-plugin`. `openclaw doctor --fix` can also remove the stale Matrix plugin references for you.

## If encrypted history still does not come back

Run these checks in order:

```bash
openclaw matrix verify status --verbose
openclaw matrix verify backup status --verbose
printf '%s\n' "$MATRIX_RECOVERY_KEY" | openclaw matrix verify backup restore --recovery-key-stdin --verbose
```

If the backup restores successfully but some old rooms are still missing history, those missing keys were probably never backed up by the previous plugin.

## If you want to start fresh for future messages

If you accept losing unrecoverable old encrypted history and only want a clean backup baseline going forward, run these commands in order:

```bash
openclaw matrix verify backup reset --yes
openclaw matrix verify backup status --verbose
openclaw matrix verify status
```

If the device is still unverified after that, finish verification from your Matrix client by comparing the SAS emoji or decimal codes and confirming that they match.

## Related

- [Matrix](/channels/matrix): channel setup and config.
- [Matrix push rules](/channels/matrix-push-rules): notification routing.
- [Doctor](/gateway/doctor): health check and automatic migration trigger.
- [Migration guide](/install/migrating): all migration paths (machine moves, cross-system imports).
- [Plugins](/tools/plugin): plugin install and registration.
