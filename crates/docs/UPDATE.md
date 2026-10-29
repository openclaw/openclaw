# Updating

## There is no self-update command

`openclaw update` is **not implemented**. The official product supports channel
switching between stable and dev installs, automatic service re-pinning, and
`doctor --fix` migrations on upgrade. None of that exists here.

Attempting it fails:

```
$ openclaw update
unknown command: update
```

The command is listed as `MISSING` in `parity-commands.tsv`, and the test suite
fails if that row and the binary disagree.

## How to update this build

Update by rebuilding from source. The binary is self-contained; there is no
package manager state to reconcile.

### 1. Back up state first

There is no `openclaw backup` either, so take a copy:

```bash
STATE="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
tar -czf "openclaw-state-$(date +%F-%H%M).tar.gz" -C "$(dirname "$STATE")" "$(basename "$STATE")"
```

This captures `openclaw.json`, the SQLite database, sessions, and pairings.

### 2. Stop the Gateway

```bash
# If installed as a service
sudo systemctl stop openclaw-gateway.service
# or, for a user unit
systemctl --user stop openclaw-gateway.service

# If running in the foreground, press Ctrl+C
```

`gateway stop` is **not implemented** and exits non-zero rather than pretending
to stop anything. Use the service manager.

### 3. Fetch and rebuild

```bash
git pull
cd crates
cargo build --release --locked -p openclaw-cli -p openclaw-node-host
```

### 4. Validate config and state

```bash
./target/release/openclaw config validate
./target/release/openclaw doctor
```

`doctor` exits non-zero when it finds problems and prints them; it is a real gate,
not a report that always succeeds. It does **not** repair anything — `--fix` is
not implemented.

### 5. Restart

```bash
sudo systemctl start openclaw-gateway.service
./target/release/openclaw gateway status --json
```

`--json` exits `0` only when the Gateway is reachable, so it works in scripts.

## Database migrations

The store applies additive migrations automatically at open time:

- `pairings.account_id` is added to older tables, with existing rows becoming the
  documented `default` account.
- The `sessions` table is created if missing, so `sessions.list` survives a
  restart.

Migrations are idempotent and safe to re-run. There is **no downgrade path**: an
older binary opening a newer database is unsupported. Keep the tarball from step 1
if you need to roll back.

### Legacy upstream state is not imported

Upstream keeps pairing state in
`~/.openclaw/state/openclaw.sqlite` (`channel_pairing_requests`,
`channel_pairing_allow_entries`) and devices in `~/.openclaw/devices/*.json`.
This build uses its own `pairings` and `sessions` tables in `database.path`.

There is no importer. Pointing this build at an upstream installation will **not**
carry over pairings or devices — those senders will need to pair again.

## Rolling back

```bash
sudo systemctl stop openclaw-gateway.service
git checkout <previous-commit>
cd crates && cargo build --release --locked -p openclaw-cli
# restore state if the schema moved forward
tar -xzf openclaw-state-<timestamp>.tar.gz -C "$(dirname "$STATE")"
sudo systemctl start openclaw-gateway.service
```

## Verifying an update

```bash
cd crates
cargo test --workspace --offline     # expect: 63 suites, 311 tests, exit 0
./target/release/openclaw version
./target/release/openclaw help       # the "NOT IMPLEMENTED YET" list must match parity-commands.tsv
```

If `parity_table.rs` fails, the binary and the documented command surface have
drifted apart — fix the table or the CLI, not the test.

## What is not covered

- No update channels (`stable`/`dev`/`beta`)
- No automatic service re-pinning after an update
- No `doctor --fix` repairs or config migrations
- No rollback automation
- No signature or checksum verification of a downloaded artifact (there is no
  artifact to download)
- No ARM64 update path — see [`INSTALL.md`](INSTALL.md)
