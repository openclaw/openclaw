---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: peekaboo（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Capture and automate macOS UI with the Peekaboo CLI.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
homepage: https://peekaboo.boo（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "emoji": "👀",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "os": ["darwin"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "requires": { "bins": ["peekaboo"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "install":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "formula": "steipete/tap/peekaboo",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "bins": ["peekaboo"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Install Peekaboo (brew)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Peekaboo（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Peekaboo is a full macOS UI automation CLI: capture/inspect screens, target UI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
elements, drive input, and manage apps/windows/menus. Commands share a snapshot（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cache and support `--json`/`-j` for scripting. Run `peekaboo` or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`peekaboo <cmd> --help` for flags; `peekaboo --version` prints build metadata.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tip: run via `polter peekaboo` to ensure fresh builds.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Features (all CLI capabilities, excluding agent/MCP)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Core（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `bridge`: inspect Peekaboo Bridge host connectivity（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `capture`: live capture or video ingest + frame extraction（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `clean`: prune snapshot cache and temp files（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `config`: init/show/edit/validate, providers, models, credentials（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `image`: capture screenshots (screen/window/menu bar regions)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `learn`: print the full agent guide + tool catalog（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `list`: apps, windows, screens, menubar, permissions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `permissions`: check Screen Recording/Accessibility status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `run`: execute `.peekaboo.json` scripts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sleep`: pause execution for a duration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `tools`: list available tools with filtering/display options（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Interaction（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `click`: target by ID/query/coords with smart waits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `drag`: drag & drop across elements/coords/Dock（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `hotkey`: modifier combos like `cmd,shift,t`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `move`: cursor positioning with optional smoothing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `paste`: set clipboard -> paste -> restore（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `press`: special-key sequences with repeats（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `scroll`: directional scrolling (targeted + smooth)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `swipe`: gesture-style drags between targets（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `type`: text + control keys (`--clear`, delays)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
System（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `app`: launch/quit/relaunch/hide/unhide/switch/list apps（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `clipboard`: read/write clipboard (text/images/files)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `dialog`: click/input/file/dismiss/list system dialogs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `dock`: launch/right-click/hide/show/list Dock items（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `menu`: click/list application menus + menu extras（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `menubar`: list/click status bar items（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `open`: enhanced `open` with app targeting + JSON payloads（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `space`: list/switch/move-window (Spaces)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `visualizer`: exercise Peekaboo visual feedback animations（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `window`: close/minimize/maximize/move/resize/focus/list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Vision（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `see`: annotated UI maps, snapshot IDs, optional analysis（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Global runtime flags（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json`/`-j`, `--verbose`/`-v`, `--log-level <level>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--no-remote`, `--bridge-socket <path>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quickstart (happy path)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
peekaboo permissions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
peekaboo list apps --json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
peekaboo see --annotate --path /tmp/peekaboo-see.png（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
peekaboo click --on B1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
peekaboo type "Hello" --return（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Common targeting parameters (most interaction commands)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- App/window: `--app`, `--pid`, `--window-title`, `--window-id`, `--window-index`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Snapshot targeting: `--snapshot` (ID from `see`; defaults to latest)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Element/coords: `--on`/`--id` (element ID), `--coords x,y`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Focus control: `--no-auto-focus`, `--space-switch`, `--bring-to-current-space`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `--focus-timeout-seconds`, `--focus-retry-count`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Common capture parameters（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Output: `--path`, `--format png|jpg`, `--retina`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Targeting: `--mode screen|window|frontmost`, `--screen-index`,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `--window-title`, `--window-id`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Analysis: `--analyze "prompt"`, `--annotate`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Capture engine: `--capture-engine auto|classic|cg|modern|sckit`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Common motion/typing parameters（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Timing: `--duration` (drag/swipe), `--steps`, `--delay` (type/scroll/press)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Human-ish movement: `--profile human|linear`, `--wpm` (typing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Scroll: `--direction up|down|left|right`, `--amount <ticks>`, `--smooth`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### See -> click -> type (most reliable flow)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
peekaboo see --app Safari --window-title "Login" --annotate --path /tmp/see.png（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
peekaboo click --on B3 --app Safari（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
peekaboo type "user@example.com" --app Safari（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
peekaboo press tab --count 1 --app Safari（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
peekaboo type "supersecret" --app Safari --return（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Target by window id（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
peekaboo list windows --app "Visual Studio Code" --json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
peekaboo click --window-id 12345 --coords 120,160（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
peekaboo type "Hello from Peekaboo" --window-id 12345（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Capture screenshots + analyze（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
peekaboo image --mode screen --screen-index 0 --retina --path /tmp/screen.png（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
peekaboo image --app Safari --window-title "Dashboard" --analyze "Summarize KPIs"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
peekaboo see --mode screen --screen-index 0 --analyze "Summarize the dashboard"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Live capture (motion-aware)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
peekaboo capture live --mode region --region 100,100,800,600 --duration 30 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  --active-fps 8 --idle-fps 2 --highlight-changes --path /tmp/capture（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### App + window management（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
peekaboo app launch "Safari" --open https://example.com（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
peekaboo window focus --app Safari --window-title "Example"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
peekaboo window set-bounds --app Safari --x 50 --y 50 --width 1200 --height 800（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
peekaboo app quit --app Safari（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Menus, menubar, dock（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
peekaboo menu click --app Safari --item "New Window"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
peekaboo menu click --app TextEdit --path "Format > Font > Show Fonts"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
peekaboo menu click-extra --title "WiFi"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
peekaboo dock launch Safari（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
peekaboo menubar list --json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Mouse + gesture input（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
peekaboo move 500,300 --smooth（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
peekaboo drag --from B1 --to T2（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
peekaboo swipe --from-coords 100,500 --to-coords 100,200 --duration 800（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
peekaboo scroll --direction down --amount 6 --smooth（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Keyboard input（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
peekaboo hotkey --keys "cmd,shift,t"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
peekaboo press escape（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
peekaboo type "Line 1\nLine 2" --delay 10（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Requires Screen Recording + Accessibility permissions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `peekaboo see --annotate` to identify targets before clicking.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
