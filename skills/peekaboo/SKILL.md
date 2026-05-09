---
name: peekaboo
description: Capture and automate macOS UI with the Peekaboo CLI.
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

# Peekaboo

Peekaboo is a full macOS UI automation CLI: capture/inspect screens, target UI
elements, drive input, and manage apps/windows/menus. Commands share a snapshot
cache and support `--json`/`-j` for scripting. Run `peekaboo` or
`peekaboo <cmd> --help` for flags; `peekaboo --version` prints build metadata.
Tip: run via `polter peekaboo` to ensure fresh builds.

## Features (all CLI capabilities, excluding agent/MCP)

Core

- `bridge`: inspect Peekaboo Bridge host connectivity
- `capture`: live capture or video ingest + frame extraction
- `clean`: prune snapshot cache and temp files
- `config`: init/show/edit/validate, providers, models, credentials
- `image`: capture screenshots (screen/window/menu bar regions)
- `learn`: print the full agent guide + tool catalog
- `list`: apps, windows, screens, menubar, permissions
- `permissions`: check Screen Recording/Accessibility status
- `run`: execute `.peekaboo.json` scripts
- `sleep`: pause execution for a duration
- `tools`: list available tools with filtering/display options

Interaction

- `click`: target by ID/query/coords with smart waits
- `drag`: drag & drop across elements/coords/Dock
- `hotkey`: modifier combos like `cmd,shift,t`
- `move`: cursor positioning with optional smoothing
- `paste`: set clipboard -> paste -> restore
- `press`: special-key sequences with repeats
- `scroll`: directional scrolling (targeted + smooth)
- `swipe`: gesture-style drags between targets
- `type`: text + control keys (`--clear`, delays)

System

- `app`: launch/quit/relaunch/hide/unhide/switch/list apps
- `clipboard`: read/write clipboard (text/images/files)
- `dialog`: click/input/file/dismiss/list system dialogs
- `dock`: launch/right-click/hide/show/list Dock items
- `menu`: click/list application menus + menu extras
- `menubar`: list/click status bar items
- `open`: enhanced `open` with app targeting + JSON payloads
- `space`: list/switch/move-window (Spaces)
- `visualizer`: exercise Peekaboo visual feedback animations
- `window`: close/minimize/maximize/move/resize/focus/list

Vision

- `see`: annotated UI maps, snapshot IDs, optional analysis

Global runtime flags

- `--json`/`-j`, `--verbose`/`-v`, `--log-level <level>`
- `--no-remote`, `--bridge-socket <path>`

## Quickstart (happy path)

```bash
peekaboo permissions
peekaboo list apps --json
peekaboo see --annotate --path /tmp/peekaboo-see.png
peekaboo click --on B1
peekaboo type "Hello" --return
```

## Common targeting parameters (most interaction commands)

- App/window: `--app`, `--pid`, `--window-title`, `--window-id`, `--window-index`
- Snapshot targeting: `--snapshot` (ID from `see`; defaults to latest)
- Element/coords: `--on`/`--id` (element ID), `--coords x,y`
- Focus control: `--no-auto-focus`, `--space-switch`, `--bring-to-current-space`,
  `--focus-timeout-seconds`, `--focus-retry-count`

## Common capture parameters

- Output: `--path`, `--format png|jpg`, `--retina`
- Targeting: `--mode screen|window|frontmost`, `--screen-index`,
  `--window-title`, `--window-id`
- Analysis: `--analyze "prompt"`, `--annotate`
- Capture engine: `--capture-engine auto|classic|cg|modern|sckit`

## Common motion/typing parameters

- Timing: `--duration` (drag/swipe), `--steps`, `--delay` (type/scroll/press)
- Human-ish movement: `--profile human|linear`, `--wpm` (typing)
- Scroll: `--direction up|down|left|right`, `--amount <ticks>`, `--smooth`

## Examples

### See -> click -> type (most reliable flow)

```bash
peekaboo see --app Safari --window-title "Login" --annotate --path /tmp/see.png
peekaboo click --on B3 --app Safari
peekaboo type "user@example.com" --app Safari
peekaboo press tab --count 1 --app Safari
peekaboo type "supersecret" --app Safari --return
```

### Target by window id

```bash
peekaboo list windows --app "Visual Studio Code" --json
peekaboo click --window-id 12345 --coords 120,160
peekaboo type "Hello from Peekaboo" --window-id 12345
```

### Capture screenshots + analyze

```bash
peekaboo image --mode screen --screen-index 0 --retina --path /tmp/screen.png
peekaboo image --app Safari --window-title "Dashboard" --analyze "Summarize KPIs"
peekaboo see --mode screen --screen-index 0 --analyze "Summarize the dashboard"
```

### Live capture (motion-aware)

```bash
peekaboo capture live --mode region --region 100,100,800,600 --duration 30 \
  --active-fps 8 --idle-fps 2 --highlight-changes --path /tmp/capture
```

### App + window management

```bash
peekaboo app launch "Safari" --open https://example.com
peekaboo window focus --app Safari --window-title "Example"
peekaboo window set-bounds --app Safari --x 50 --y 50 --width 1200 --height 800
peekaboo app quit --app Safari
```

### Menus, menubar, dock

```bash
peekaboo menu click --app Safari --item "New Window"
peekaboo menu click --app TextEdit --path "Format > Font > Show Fonts"
peekaboo menu click-extra --title "WiFi"
peekaboo dock launch Safari
peekaboo menubar list --json
```

### Mouse + gesture input

```bash
peekaboo move 500,300 --smooth
peekaboo drag --from B1 --to T2
peekaboo swipe --from-coords 100,500 --to-coords 100,200 --duration 800
peekaboo scroll --direction down --amount 6 --smooth
```

### Keyboard input

```bash
peekaboo hotkey --keys "cmd,shift,t"
peekaboo press escape
peekaboo type "Line 1\nLine 2" --delay 10
```

Notes

- Requires Screen Recording + Accessibility permissions. If you are running
  inside an OpenClaw subprocess (gateway-spawned Node, an agent runtime, etc.),
  read **Subprocess agents** below before reporting a permission problem —
  the grants are checked against the Bridge host, not your process.
- Use `peekaboo see --annotate` to identify targets before clicking.

## Subprocess agents (Bridge architecture)

Peekaboo evaluates Screen Recording and Accessibility against TWO independent
processes depending on the path you take. Both can be in valid states at the
same time, and that is not a contradiction.

```
                     +--------------------+
peekaboo CLI  --->   |  Bridge selection  |
(default path)       +--------------------+
                              |  auto, in priority order:
                              v
                  +-----------+-----------+
                  | 1) Peekaboo.app       |
                  | 2) Claude.app         |
                  | 3) ClawdBot.app       |
                  | 4) Local in-process   |  <- only if no host found
                  +-----------+-----------+
                              |
                              v
                  TCC checked against the host app's bundle ID.

peekaboo CLI --no-remote --->  Local in-process capture.
                               TCC checked against the calling process.
```

If you are an agent running under an OpenClaw host (gateway, agent runtime,
cron-spawned subprocess), your calling process is whatever Node binary the
gateway shells out to. Plain Node has no TCC grants of its own. Granting them
to that binary path would also silently break on the next package-manager
upgrade, since the path moves. **The Bridge is your TCC.** Use the default path.

### Rules for subprocess agents

- **Always use the Bridge path. Never pass `--no-remote`.** The default
  `peekaboo` invocation IS the Bridge path when an OpenClaw host app is
  running.
- **Never** read `peekaboo permissions status --no-remote` and conclude
  there is a permission problem. That command checks your subprocess's
  TCC namespace, which is empty by design.
- The user has granted Screen Recording + Accessibility to the host app
  (OpenClaw/Claude/Peekaboo). Don't ask them to grant it again to your
  runtime — they can't, and shouldn't.

```bash
# Correct.
peekaboo image --mode screen --screen-index 0 --json

# Wrong for a subprocess agent — bypasses the Bridge.
peekaboo image --mode screen --no-remote --json
```

### Diagnosing failures, in order

```bash
# 1. Is a host app running?
peekaboo bridge status --json

# 2. What does the Bridge see for permissions?
peekaboo permissions status --json
# Expect: Source: Peekaboo Bridge, SR=Granted, AX=Granted

# 3. One-off Bridge capture.
peekaboo image --mode screen --screen-index 0 --json
```

If step 1 shows no remote host, the Bridge fell through to local
in-process — meaning no host app is up. Ask the user to relaunch the
host (don't try to launch it yourself; lifecycle is owned by the host's
own daemon/launchd).

If step 2 says `Source: Peekaboo Bridge` with both granted but step 3
fails, it's a real permission problem (rare — usually only after the
host app's bundle path changes). Re-granting via System Settings is the
fix.

### Sequoia "bypass private window picker" dialog

On macOS 15+ you may capture a screenshot that shows a system modal:

> "<Host>" is requesting to bypass the system private window picker
> and directly access your screen and audio.

This is a separate Sequoia escalation (skip the per-capture picker
overlay) — granting it does not change base Screen Recording state.
The dialog is owned by `loginwindow`, not by the host app, so a
`peekaboo click` on the Allow button correctly reports
`App: loginwindow`. That is not a bug.

### Anti-patterns

| Don't                                                                 | Do                                                                                        |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `peekaboo permissions status --no-remote` and report results          | `peekaboo permissions status` (default Bridge view)                                       |
| Run raw `screencapture -x ...` from a subprocess                      | `peekaboo image --mode screen --json` (Bridge-routed)                                     |
| Tell the user to grant Screen Recording to Terminal/Node/your runtime | Use the Bridge. Permissions belong on the host app.                                       |
| Conclude "permission state is split between Bridge and CLI" and stop  | The split is by design. Bridge granted = you can capture.                                 |
| Add `--no-remote` because it sounds safer or more direct              | The Bridge is the path. `--no-remote` is for callers who already have their own SR grant. |
