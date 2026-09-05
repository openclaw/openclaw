---
name: peekaboo
description: "Capture, inspect, and automate macOS UI with the Peekaboo v4.1+ CLI."
homepage: https://peekaboo.boo
metadata:
  {
    "openclaw":
      {
        "emoji": "👀",
        "os": ["darwin"],
        "requires": { "bins": ["peekaboo"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "steipete/tap/peekaboo",
              "bins": ["peekaboo"],
              "label": "Install Peekaboo (brew)",
            },
          ],
      },
  }
---

# Peekaboo v4.1+

Use Peekaboo to inspect and automate macOS UI. This skill targets Peekaboo
version 4.1.0 and newer.

## Check the live contract

Verify the full installed version before composing commands. This skill requires
version 4.1.0 or newer:

```bash
peekaboo --version
peekaboo --help
```

If the version is older than 4.1.0, stop and upgrade through the same approved
installation source instead of guessing across incompatible syntax or routing
behavior. For the Homebrew formula declared by this skill:

```bash
brew upgrade steipete/tap/peekaboo
peekaboo --version
```

If Peekaboo came from another source, follow that source's release instructions
at the homepage above. After the version gate passes, prefer live help over a
memorized flag list:

```bash
peekaboo <command> --help
peekaboo tools --json
peekaboo tools describe <tool-name> --json
```

`tools describe` accepts names emitted by `peekaboo tools`; MCP tool names can
differ from CLI subcommands.

Put global runtime flags after the leaf command. Common flags are `--json`,
`--verbose`, `--no-remote`, and `--bridge-socket <path>`.

## Runtime and Bridge routing

By default, leave `PEEKABOO_BRIDGE_SOCKET` unset and let v4 select a runtime
host for the requested operation. Inspect the decision and all probed hosts:

```bash
peekaboo bridge status --verbose --json
```

OpenClaw.app can host a permission-aware Bridge when **Allow Computer Control**
is enabled, **Computer Control provider** is set to **Peekaboo**, and **Enable
Peekaboo Bridge** is enabled. If the provider is **CUA**, OpenClaw intentionally
stops the Peekaboo Bridge; leave the socket override unset and use normal host
discovery instead. Select the OpenClaw socket explicitly only when the task
needs OpenClaw.app's TCC grants and all three Peekaboo-host conditions hold.
First copy the OpenClaw socket path reported by verbose status; do not guess or
hard-code the filename:

```bash
peekaboo bridge status --verbose --json
OPENCLAW_BRIDGE="<OpenClaw socketPath from verbose status>"
peekaboo bridge status --bridge-socket "$OPENCLAW_BRIDGE" --json
peekaboo app list --bridge-socket "$OPENCLAW_BRIDGE" --json
```

In v4.1+, an explicit socket is fail-closed: an absent, unauthorized, or
incompatible host returns nonzero instead of falling back. For routing proof,
confirm `data.selected.socketPath` and its handshake in the status response,
then run one representative leaf command through the same explicit socket;
exit 0 from `bridge status` alone is not sufficient evidence. Avoid exporting
the override globally unless every subsequent command should target the same
host. Do not use `--no-remote` unless the caller process has the grants required
by the selected operation, such as Screen Recording, Accessibility, or Event
Synthesizing.

## Reliable workflow

1. Check permissions and inventory.
2. Capture fresh UI state with `see`.
3. Act on an element ID, query, or exact target.
4. Verify the postcondition instead of sleeping blindly.

```bash
peekaboo permissions status --json
peekaboo app list --json
peekaboo window list --app Safari --json
peekaboo see --app Safari --window-title "Login" --annotate \
  --path /tmp/peekaboo-login.png --json
peekaboo click --on B3 --app Safari --json
peekaboo type "user@example.com" --app Safari --json
peekaboo press Return --app Safari --foreground --json
peekaboo verify --app Safari --window-title "Dashboard" --window-exists \
  --timeout 5s --json
```

`verify` has a ternary result: exit 0 means satisfied, exit 1 means
unsatisfied, and exit 2 means unknown. Treat both unsatisfied and unknown as
non-success.

## Peekaboo v4 spellings

Do not use removed v3 commands or flags:

| Removed v3 spelling                           | Peekaboo v4                                             |
| --------------------------------------------- | ------------------------------------------------------- |
| `list apps` / `list windows` / `list screens` | `app list` / `window list` / `screen list`              |
| `image`                                       | `see` (add `--no-elements` for screenshot-only capture) |
| `inspect-ui`                                  | `see --tree --no-screenshot`                            |
| `hotkey --keys cmd,shift,t`                   | `press cmd+shift+t --foreground`                        |
| `swipe --from-coords … --to-coords …`         | `drag --from … --to … --foreground`                     |
| `perform-action`                              | `action`                                                |
| `sleep`                                       | `verify` for state waits, otherwise `/bin/sleep`        |
| `run file.peekaboo.json`                      | a shell script chaining `peekaboo` commands             |
| `--coords x,y`                                | `--at x,y`                                              |
| `--id <element>`                              | `--on <element>`                                        |

Durations accept bare milliseconds or explicit `ms`/`s` suffixes. Prefer
explicit units, for example `--timeout 5s` or `--duration 800ms`.

## Capture and inspect

```bash
# Screenshot only
peekaboo see --mode screen --screen-index 0 --no-elements --retina \
  --path /tmp/screen.png --json

# Annotated element map
peekaboo see --app Safari --window-title "Dashboard" --annotate \
  --path /tmp/dashboard.png --json

# Accessibility tree without pixels
peekaboo see --app Safari --tree --no-screenshot --json
```

Element IDs come from a snapshot and can go stale after UI changes. Re-run
`see` before acting when the window changed, navigation occurred, or a target
cannot be found.

## Input and targeting

Prefer process- or snapshot-targeted background input:

```bash
peekaboo click "Submit" --app Safari --json
peekaboo type "Hello" --app TextEdit --clear --json
peekaboo scroll --direction down --amount 6 --on B4 --json
```

Use `--foreground` for intentional global/shared input. Raw key events require
it unless they carry a fresh exact-window or snapshot receipt, and drags always
move the shared physical cursor:

```bash
peekaboo press cmd+shift+t --app Safari --foreground --json
peekaboo click --at 120,160 --app Safari --foreground --json
peekaboo drag --from 100,500 --to 100,200 --duration 800ms \
  --foreground --json
```

Target windows with `--window-id` when possible. Obtain IDs from
`peekaboo window list --app <app> --json`; use `--window-title` or
`--window-index` only when an exact ID is unavailable.

## App and window management

```bash
peekaboo app launch Safari --open https://example.com --wait-ready --json
peekaboo window focus --app Safari --window-title "Example" --json
peekaboo window set-bounds --app Safari --x 50 --y 50 \
  --width 1200 --height 800 --json
peekaboo app quit Safari --json
```

## Troubleshooting

1. Run `peekaboo bridge status --verbose --json` to identify the selected host
   and handshake or capability failures.
2. Run `peekaboo permissions status --json`; permissions belong to the process
   or Bridge host performing the operation.
3. Re-run the exact leaf command with `--help` and `--verbose --json`.
4. Re-capture with `see` before retrying a stale element or window target.
5. If an explicit OpenClaw socket fails, confirm that the Computer Control
   provider is **Peekaboo** and both required toggles are enabled. Otherwise,
   remove the override and intentionally use normal v4 host selection.
