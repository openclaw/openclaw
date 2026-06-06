# Existing OpenClaw Install Upgrade

Use this page when OpenClaw already exists on the computer and you want to switch it to the Zorg MemoryDB branch of the original OpenClaw repository.

If SSH, terminals, `cd`, or Linux paths are unfamiliar, read [`beginner-terminal-and-ssh.md`](beginner-terminal-and-ssh.md) first.

This is different from a fresh install only in how OpenClaw got there first. Both paths end with OpenClaw installed from a Zorg MemoryDB branch/fork of `openclaw/openclaw`, not from a separate `Zorg_MemoryDB` folder.

Example folders used on this page:
`text $HOME/.openclaw/workspace `

What those folders mean:

`$HOME/.openclaw/workspace` is the normal existing OpenClaw workspace folder.

The runtime workspace stays here. The source checkout should be the OpenClaw source checkout, usually `$HOME/openclaw`, with Zorg MemoryDB committed on a branch.

## Step 1: Update OpenClaw Itself First

`bash openclaw update --dry-run `

What this does: asks the official OpenClaw updater what it would change. It does not apply the update yet.
`bash openclaw update `

What this does: applies the official OpenClaw update. This updates OpenClaw before the Zorg MemoryDB overlay is refreshed.
`bash openclaw doctor `

What this does: checks whether the OpenClaw install is healthy after the upstream update.

## Step 2: Clone or Enter the OpenClaw Source Checkout

Clone the OpenClaw fork that contains the Zorg MemoryDB branch, or enter it if it already exists:

```bash
git clone https://github.com/<your-account>/openclaw.git "$HOME/openclaw"
cd "$HOME/openclaw"
git checkout zorg-memorydb
```

What this does: puts the Zorg MemoryDB code in the OpenClaw source tree itself.

## Step 3: Reinstall OpenClaw From That Branch

`bash curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --git-dir "$HOME/openclaw" --version zorg-memorydb --no-onboard `

What this does: uses OpenClaw's official git installer against the OpenClaw checkout that contains the Zorg MemoryDB branch.

The runtime workspace remains `$HOME/.openclaw/workspace`; the source code comes from the OpenClaw branch.

## Step 4: Verify Database Recall

`bash .venv-sqlmem/bin/python scripts/memory_recall_router.py "database memory" --limit 5 `

What this does: asks the Zorg MemoryDB recall path to read from the database. Expected mode: `database-direct-vector-neural-weighted`.

The upgrade helper applies `db/public_canonical_rules_update_2026_06_02.sql`.
That SQL seeds the full public-safe canonical rule set and checks for 93 active
public rules in `zorg_logic_rules`.

The upgrade helper also installs the built-in LAN command chat from `lan-chat/`
by default. To deliberately skip only that LAN chat install, set
`ZORG_SKIP_LAN_CHAT_INSTALL=1`.

## Step 5: Restart OpenClaw if Needed

`bash openclaw gateway restart `

What this does: restarts the OpenClaw Gateway so it can use the refreshed overlay files.

If your OpenClaw install does not have `openclaw gateway restart`, start the Gateway the same way you normally started it before the overlay upgrade.
