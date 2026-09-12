---
summary: "E2EE setup, device verification, cross-signing, and room-key backup"
read_when:
  - Configuring Matrix E2EE and verification
  - Recovering a Matrix device that lost cross-signing trust
  - Restoring room keys from a Matrix backup
title: "Matrix encryption and verification"
sidebarTitle: "Encryption"
---

Enable end-to-end encryption for a Matrix account, verify the gateway device, and repair crypto state when it drifts.

## Encryption and verification

In encrypted (E2EE) rooms, outbound image events use `thumbnail_file` so image previews are encrypted alongside the full attachment; unencrypted rooms use plain `thumbnail_url`. No configuration is needed - the plugin detects E2EE state automatically.

All `openclaw matrix` commands accept `--verbose` (full diagnostics), `--json` (machine-readable output), and `--account <id>` (multi-account setups). Output is concise by default.

### Enable encryption

```bash
openclaw matrix encryption setup
printf '%s\n' "$MATRIX_RECOVERY_KEY" | openclaw matrix encryption setup --recovery-key-stdin
```

Bootstraps secret storage and cross-signing, creates a room-key backup if needed, then prints status and next steps. Useful flags:

- `--recovery-key-stdin` reads a recovery key from stdin without exposing it in process arguments; `--recovery-key <key>` remains available for compatibility
- `--force-reset-cross-signing` discard the current cross-signing identity and create a new one (intentional use only)

For a new account, enable E2EE at creation time:

```bash
openclaw matrix account add \
  --homeserver https://matrix.example.org \
  --access-token syt_xxx \
  --enable-e2ee
```

`--encryption` is an alias for `--enable-e2ee`. Both setup commands finish their Matrix client operations before saving the enabled config, so a running Gateway can reload after that work settles. If bootstrap fails, the encryption setting is still saved; use the reported diagnostics and next steps to finish verification.

Setup preserves unrelated configuration changes made while it runs. If the selected account changes, setup leaves that newer configuration intact and asks you to review it and rerun the command.

Manual config equivalent:

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_xxx",
      encryption: true,
      dm: { policy: "pairing" },
    },
  },
}
```

### Status and trust signals

```bash
openclaw matrix verify status
openclaw matrix verify status --include-recovery-key --json
```

With `--include-recovery-key`, text output confirms when a raw recovery key is available and directs you to add `--json`. Text output never prints the key itself; keep JSON output containing a recovery key private.

`verify status` reports three independent trust signals (`--verbose` shows all of them):

- `Locally trusted`: trusted by this client only
- `Cross-signing verified`: the SDK reports verification via cross-signing
- `Signed by owner`: signed by your own self-signing key (diagnostic only)

`Verified by owner` is `yes` only when `Cross-signing verified` is `yes`; local trust or an owner signature alone is not enough.

`--allow-degraded-local-state` returns best-effort diagnostics without preparing the Matrix account first; useful for offline or partially-configured probes.

### Verify this device with a recovery key

Pipe the recovery key via stdin instead of passing it on the command line:

```bash
printf '%s\n' "$MATRIX_RECOVERY_KEY" | openclaw matrix verify device --recovery-key-stdin
```

The command reports three states:

- `Recovery key accepted`: Matrix accepted the key for secret storage or device trust.
- `Backup usable`: room-key backup can be loaded with the trusted recovery material.
- `Device verified by owner`: this device has full Matrix cross-signing identity trust.

It exits non-zero when full identity trust is incomplete, even if the recovery key unlocked backup material. In that case, finish self-verification from another Matrix client:

```bash
openclaw matrix verify self
```

`verify self` waits for `Cross-signing verified: yes` before exiting successfully. Use `--timeout-ms <ms>` to tune the wait.

The literal-key form `openclaw matrix verify device "<recovery-key>"` also works, but the key ends up in shell history.

### Bootstrap or repair cross-signing

```bash
openclaw matrix verify bootstrap
```

The repair/setup command for encrypted accounts. In order, it:

- bootstraps secret storage, reusing an existing recovery key when possible
- bootstraps cross-signing and uploads missing public keys
- marks and cross-signs the current device
- creates a server-side room-key backup if one does not already exist

If the homeserver requires UIA to upload cross-signing keys, OpenClaw tries no-auth first, then `m.login.dummy`, then `m.login.password` (requires `channels.matrix.password`).

Useful flags:

- `--recovery-key-stdin` (pair with `printf '%s\n' "$MATRIX_RECOVERY_KEY" | ...`) or `--recovery-key <key>`
- `--force-reset-cross-signing` to discard the current cross-signing identity (intentional only; requires the active recovery key stored or supplied with `--recovery-key-stdin`)

### Room-key backup

```bash
openclaw matrix verify backup status
printf '%s\n' "$MATRIX_RECOVERY_KEY" | openclaw matrix verify backup restore --recovery-key-stdin
```

`backup status` shows whether a server-side backup exists and whether this device can decrypt it. `backup restore` imports backed-up room keys into the local crypto store; omit `--recovery-key-stdin` if the recovery key is already on disk.

OpenClaw reads prior edits to notify only newly mentioned recipients. If an edit reports that its history is not fully decrypted, restore the missing room keys with `backup restore`, then retry the edit. If those keys are unavailable, send a new message.

To replace a broken backup with a fresh baseline (accepts losing unrecoverable old history; can also recreate secret storage if the current backup secret is unloadable):

```bash
openclaw matrix verify backup reset --yes
```

Add `--rotate-recovery-key` only when the previous recovery key should intentionally stop unlocking the fresh backup baseline.

### Listing, requesting, and responding to verifications

```bash
openclaw matrix verify list
```

Lists pending verification requests for the selected account.

```bash
openclaw matrix verify request --own-user
openclaw matrix verify request --user-id @ops:example.org --device-id ABCDEF
```

Sends a verification request from this account. `--own-user` requests self-verification (accept the prompt in another Matrix client of the same user); `--user-id`/`--device-id`/`--room-id` target someone else. `--own-user` cannot combine with the other targeting flags.

For lower-level lifecycle handling - typically while shadowing inbound requests from another client - these commands act on a specific request `<id>` (printed by `verify list` and `verify request`):

| Command                                    | Purpose                                                             |
| ------------------------------------------ | ------------------------------------------------------------------- |
| `openclaw matrix verify accept <id>`       | Accept an inbound request                                           |
| `openclaw matrix verify start <id>`        | Start the SAS flow                                                  |
| `openclaw matrix verify sas <id>`          | Print the SAS emoji or decimals                                     |
| `openclaw matrix verify confirm-sas <id>`  | Confirm that the SAS matches what the other client shows            |
| `openclaw matrix verify mismatch-sas <id>` | Reject the SAS when the emoji or decimals do not match              |
| `openclaw matrix verify cancel <id>`       | Cancel; takes optional `--reason <text>` and `--code <matrix-code>` |

`accept`, `start`, `sas`, `confirm-sas`, `mismatch-sas`, and `cancel` all accept `--user-id` and `--room-id` as DM follow-up hints when the verification is anchored to a specific direct-message room.

### Multi-account notes

Without `--account <id>`, Matrix CLI commands use the implicit default account. With multiple named accounts and no `channels.matrix.defaultAccount`, commands refuse to guess and ask you to choose. When E2EE is disabled or unavailable for a named account, errors point at that account's config key, for example `channels.matrix.accounts.assistant.encryption`.

<AccordionGroup>
  <Accordion title="Startup behavior">
    With `encryption: true`, `startupVerification` defaults to `"if-unverified"`. On startup an unverified device requests self-verification in another Matrix client, skipping duplicates and applying a cooldown (24 hours by default). Tune with `startupVerificationCooldownHours` or disable with `startupVerification: "off"`.

    Startup also runs a conservative crypto bootstrap pass reusing the current secret storage and cross-signing identity. If bootstrap state is broken, OpenClaw attempts a guarded repair even without `channels.matrix.password`; if the homeserver requires password UIA, startup logs a warning and stays non-fatal. Already-owner-signed devices are preserved.

    See [Matrix migration](/channels/matrix-migration) for the full upgrade flow.

  </Accordion>

  <Accordion title="Verification notices">
    Matrix posts verification lifecycle notices into the strict DM verification room as `m.notice` messages: request, ready (with "Verify by emoji" guidance), start/completion, and SAS (emoji/decimal) details when available.

    Incoming requests from another Matrix client are tracked and auto-accepted. For self-verification, OpenClaw starts the SAS flow automatically and confirms its own side once emoji verification is available - you still need to compare and confirm "They match" in your Matrix client.

    Verification system notices are not forwarded to the agent chat pipeline.

  </Accordion>

  <Accordion title="Deleted or invalid Matrix device">
    If `verify status` says the current device is no longer listed on the homeserver, create a new OpenClaw Matrix device. For password login:

```bash
openclaw matrix account add \
  --account assistant \
  --homeserver https://matrix.example.org \
  --user-id '@assistant:example.org' \
  --password '<password>' \
  --device-name OpenClaw-Gateway
```

    For token auth, create a fresh access token in your Matrix client or admin UI, then update OpenClaw:

```bash
openclaw matrix account add \
  --account assistant \
  --homeserver https://matrix.example.org \
  --access-token '<token>'
```

    Replace `assistant` with the account ID from the failed command, or omit `--account` for the default account.

  </Accordion>

  <Accordion title="Device hygiene">
    Old OpenClaw-managed devices can accumulate. List and prune:

```bash
openclaw matrix devices list
openclaw matrix devices prune-stale
```

  </Accordion>

  <Accordion title="Crypto store">
    Matrix E2EE uses the official `matrix-js-sdk` Rust crypto path with `fake-indexeddb` as the IndexedDB shim. Crypto state persists to `crypto-idb-snapshot.json` (restrictive file permissions).

    Encrypted runtime state lives under `~/.openclaw/matrix/accounts/<account>/<homeserver>__<user>/<token-hash>/` and includes the sync store, crypto store, recovery key, IDB snapshot, thread bindings, and startup verification state. When the token changes but the account identity stays the same, OpenClaw reuses the best existing root so prior state remains visible.

    A single older token-hash root can be a normal token-rotation continuity path. If OpenClaw logs `matrix: multiple populated token-hash storage roots detected`, inspect the account directory and archive stale sibling roots only after confirming the selected active root is healthy. Prefer moving stale roots into an `_archive/` directory over deleting them immediately.

  </Accordion>
</AccordionGroup>
