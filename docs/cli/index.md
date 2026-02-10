---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "OpenClaw CLI reference for `openclaw` commands, subcommands, and options"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Adding or modifying CLI commands or options（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Documenting new command surfaces（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "CLI Reference"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# CLI reference（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This page describes the current CLI behavior. If commands change, update this doc.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Command pages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`setup`](/cli/setup)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`onboard`](/cli/onboard)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`configure`](/cli/configure)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`config`](/cli/config)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`doctor`](/cli/doctor)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`dashboard`](/cli/dashboard)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`reset`](/cli/reset)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`uninstall`](/cli/uninstall)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`update`](/cli/update)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`message`](/cli/message)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`agent`](/cli/agent)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`agents`](/cli/agents)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`acp`](/cli/acp)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`status`](/cli/status)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`health`](/cli/health)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`sessions`](/cli/sessions)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`gateway`](/cli/gateway)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`logs`](/cli/logs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`system`](/cli/system)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`models`](/cli/models)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`memory`](/cli/memory)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`nodes`](/cli/nodes)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`devices`](/cli/devices)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`node`](/cli/node)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`approvals`](/cli/approvals)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`sandbox`](/cli/sandbox)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`tui`](/cli/tui)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`browser`](/cli/browser)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`cron`](/cli/cron)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`dns`](/cli/dns)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`docs`](/cli/docs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`hooks`](/cli/hooks)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`webhooks`](/cli/webhooks)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`pairing`](/cli/pairing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`plugins`](/cli/plugins) (plugin commands)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`channels`](/cli/channels)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`security`](/cli/security)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`skills`](/cli/skills)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [`voicecall`](/cli/voicecall) (plugin; if installed)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Global flags（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--dev`: isolate state under `~/.openclaw-dev` and shift default ports.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--profile <name>`: isolate state under `~/.openclaw-<name>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--no-color`: disable ANSI colors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--update`: shorthand for `openclaw update` (source installs only).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `-V`, `--version`, `-v`: print version and exit.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Output styling（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ANSI colors and progress indicators only render in TTY sessions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- OSC-8 hyperlinks render as clickable links in supported terminals; otherwise we fall back to plain URLs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json` (and `--plain` where supported) disables styling for clean output.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--no-color` disables ANSI styling; `NO_COLOR=1` is also respected.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Long-running commands show a progress indicator (OSC 9;4 when supported).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Color palette（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw uses a lobster palette for CLI output.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `accent` (#FF5A2D): headings, labels, primary highlights.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `accentBright` (#FF7A3D): command names, emphasis.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `accentDim` (#D14A22): secondary highlight text.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `info` (#FF8A5B): informational values.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `success` (#2FBF71): success states.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `warn` (#FFB020): warnings, fallbacks, attention.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `error` (#E23D2D): errors, failures.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `muted` (#8B7F77): de-emphasis, metadata.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Palette source of truth: `src/terminal/palette.ts` (aka “lobster seam”).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Command tree（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw [--dev] [--profile <name>] <command>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  onboard（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  configure（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    get（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    set（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    unset（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  security（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    audit（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  reset（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  uninstall（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  update（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    logs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    add（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    remove（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    login（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    logout（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  skills（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    info（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    check（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  plugins（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    info（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    enable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    disable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    index（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    search（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  message（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    add（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    delete（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  acp（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  health（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  sessions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    call（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    health（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    probe（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    discover（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    uninstall（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    stop（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    restart（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  logs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  system（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    event（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    heartbeat last|enable|disable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    presence（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  models（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    set（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    set-image（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    aliases list|add|remove（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    fallbacks list|add|remove|clear（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    image-fallbacks list|add|remove|clear（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    scan（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    auth add|setup-token|paste-token（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    auth order get|set|clear（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  sandbox（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    recreate（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    explain（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  cron（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    add（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    edit（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    rm（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    enable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    disable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    runs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  nodes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  devices（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  node（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    uninstall（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    stop（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    restart（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  approvals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    get（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    set（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    allowlist add|remove（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  browser（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    stop（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    reset-profile（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    tabs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    open（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    focus（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    close（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    profiles（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    create-profile（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    delete-profile（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    screenshot（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    snapshot（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    navigate（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    resize（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    click（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    type（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    press（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    hover（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    drag（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    select（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    upload（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    fill（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    dialog（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    wait（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    evaluate（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    console（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    pdf（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  hooks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    info（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    check（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    enable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    disable（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    update（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  webhooks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    gmail setup|run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  pairing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    approve（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  docs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  dns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tui（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: plugins can add additional top-level commands (for example `openclaw voicecall`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Security（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw security audit` — audit config + local state for common security foot-guns.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw security audit --deep` — best-effort live Gateway probe.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw security audit --fix` — tighten safe defaults and chmod state/config.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Plugins（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Manage extensions and their config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw plugins list` — discover plugins (use `--json` for machine output).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw plugins info <id>` — show details for a plugin.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw plugins install <path|.tgz|npm-spec>` — install a plugin (or add a plugin path to `plugins.load.paths`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw plugins enable <id>` / `disable <id>` — toggle `plugins.entries.<id>.enabled`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw plugins doctor` — report plugin load errors.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Most plugin changes require a gateway restart. See [/plugin](/tools/plugin).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Memory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Vector search over `MEMORY.md` + `memory/*.md`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw memory status` — show index stats.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw memory index` — reindex memory files.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw memory search "<query>"` — semantic search over memory.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Chat slash commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Chat messages support `/...` commands (text and native). See [/tools/slash-commands](/tools/slash-commands).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Highlights:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/status` for quick diagnostics.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/config` for persisted config changes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/debug` for runtime-only config overrides (memory, not disk; requires `commands.debug: true`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Setup + onboarding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `setup`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Initialize config + workspace.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--workspace <dir>`: agent workspace path (default `~/.openclaw/workspace`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--wizard`: run the onboarding wizard.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--non-interactive`: run wizard without prompts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--mode <local|remote>`: wizard mode.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--remote-url <url>`: remote Gateway URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--remote-token <token>`: remote Gateway token.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Wizard auto-runs when any wizard flags are present (`--non-interactive`, `--mode`, `--remote-url`, `--remote-token`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `onboard`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Interactive wizard to set up gateway, workspace, and skills.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--workspace <dir>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--reset` (reset config + credentials + sessions + workspace before wizard)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--non-interactive`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--mode <local|remote>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--flow <quickstart|advanced|manual>` (manual is an alias for advanced)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--auth-choice <setup-token|token|chutes|openai-codex|openai-api-key|openrouter-api-key|ai-gateway-api-key|moonshot-api-key|moonshot-api-key-cn|kimi-code-api-key|synthetic-api-key|venice-api-key|gemini-api-key|zai-api-key|apiKey|minimax-api|minimax-api-lightning|opencode-zen|skip>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--token-provider <id>` (non-interactive; used with `--auth-choice token`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--token <token>` (non-interactive; used with `--auth-choice token`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--token-profile-id <id>` (non-interactive; default: `<provider>:manual`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--token-expires-in <duration>` (non-interactive; e.g. `365d`, `12h`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--anthropic-api-key <key>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--openai-api-key <key>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--openrouter-api-key <key>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--ai-gateway-api-key <key>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--moonshot-api-key <key>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--kimi-code-api-key <key>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--gemini-api-key <key>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--zai-api-key <key>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--minimax-api-key <key>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--opencode-zen-api-key <key>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--gateway-port <port>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--gateway-bind <loopback|lan|tailnet|auto|custom>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--gateway-auth <token|password>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--gateway-token <token>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--gateway-password <password>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--remote-url <url>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--remote-token <token>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--tailscale <off|serve|funnel>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--tailscale-reset-on-exit`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--install-daemon`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--no-install-daemon` (alias: `--skip-daemon`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--daemon-runtime <node|bun>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--skip-channels`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--skip-skills`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--skip-health`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--skip-ui`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--node-manager <npm|pnpm|bun>` (pnpm recommended; bun not recommended for Gateway runtime)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `configure`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Interactive configuration wizard (models, channels, skills, gateway).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `config`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Non-interactive config helpers (get/set/unset). Running `openclaw config` with no（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
subcommand launches the wizard.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Subcommands:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `config get <path>`: print a config value (dot/bracket path).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `config set <path> <value>`: set a value (JSON5 or raw string).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `config unset <path>`: remove a value.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `doctor`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Health checks + quick fixes (config + gateway + legacy services).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--no-workspace-suggestions`: disable workspace memory hints.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--yes`: accept defaults without prompting (headless).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--non-interactive`: skip prompts; apply safe migrations only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--deep`: scan system services for extra gateway installs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Channel helpers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `channels`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Manage chat channel accounts (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage/MS Teams).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Subcommands:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels list`: show configured channels and auth profiles.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels status`: check gateway reachability and channel health (`--probe` runs extra checks; use `openclaw health` or `openclaw status --deep` for gateway health probes).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tip: `channels status` prints warnings with suggested fixes when it can detect common misconfigurations (then points you to `openclaw doctor`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels logs`: show recent channel logs from the gateway log file.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels add`: wizard-style setup when no flags are passed; flags switch to non-interactive mode.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels remove`: disable by default; pass `--delete` to remove config entries without prompts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels login`: interactive channel login (WhatsApp Web only).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels logout`: log out of a channel session (if supported).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--channel <name>`: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--account <id>`: channel account id (default `default`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--name <label>`: display name for the account（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`channels login` options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--channel <channel>` (default `whatsapp`; supports `whatsapp`/`web`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--account <id>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--verbose`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`channels logout` options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--channel <channel>` (default `whatsapp`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--account <id>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`channels list` options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--no-usage`: skip model provider usage/quota snapshots (OAuth/API-backed only).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json`: output JSON (includes usage unless `--no-usage` is set).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`channels logs` options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--channel <name|all>` (default `all`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--lines <n>` (default `200`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
More detail: [/concepts/oauth](/concepts/oauth)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Examples:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels add --channel telegram --account alerts --name "Alerts Bot" --token $TELEGRAM_BOT_TOKEN（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels add --channel discord --account work --name "Work Bot" --token $DISCORD_BOT_TOKEN（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels remove --channel discord --account work --delete（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels status --probe（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw status --deep（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `skills`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
List and inspect available skills plus readiness info.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Subcommands:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `skills list`: list skills (default when no subcommand).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `skills info <name>`: show details for one skill.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `skills check`: summary of ready vs missing requirements.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--eligible`: show only ready skills.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json`: output JSON (no styling).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `-v`, `--verbose`: include missing requirements detail.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tip: use `npx clawhub` to search, install, and sync skills.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `pairing`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Approve DM pairing requests across channels.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Subcommands:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `pairing list <channel> [--json]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `pairing approve <channel> <code> [--notify]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `webhooks gmail`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Gmail Pub/Sub hook setup + runner. See [/automation/gmail-pubsub](/automation/gmail-pubsub).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Subcommands:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `webhooks gmail setup` (requires `--account <email>`; supports `--project`, `--topic`, `--subscription`, `--label`, `--hook-url`, `--hook-token`, `--push-token`, `--bind`, `--port`, `--path`, `--include-body`, `--max-bytes`, `--renew-minutes`, `--tailscale`, `--tailscale-path`, `--tailscale-target`, `--push-endpoint`, `--json`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `webhooks gmail run` (runtime overrides for the same flags)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `dns setup`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Wide-area discovery DNS helper (CoreDNS + Tailscale). See [/gateway/discovery](/gateway/discovery).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--apply`: install/update CoreDNS config (requires sudo; macOS only).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Messaging + agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `message`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Unified outbound messaging + channel actions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See: [/cli/message](/cli/message)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Subcommands:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `message send|poll|react|reactions|read|edit|delete|pin|unpin|pins|permissions|search|timeout|kick|ban`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `message thread <create|list|reply>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `message emoji <list|upload>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `message sticker <send|upload>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `message role <info|add|remove>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `message channel <info|list>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `message member info`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `message voice status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `message event <list|create>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Examples:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw message send --target +15555550123 --message "Hi"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw message poll --channel discord --target channel:123 --poll-question "Snack?" --poll-option Pizza --poll-option Sushi`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `agent`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run one agent turn via the Gateway (or `--local` embedded).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Required:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--message <text>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--to <dest>` (for session key and optional delivery)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--session-id <id>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--thinking <off|minimal|low|medium|high|xhigh>` (GPT-5.2 + Codex models only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--verbose <on|full|off>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--channel <whatsapp|telegram|discord|slack|mattermost|signal|imessage|msteams>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--local`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--deliver`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--timeout <seconds>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `agents`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Manage isolated agents (workspaces + auth + routing).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### `agents list`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
List configured agents.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--bindings`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### `agents add [name]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Add a new isolated agent. Runs the guided wizard unless flags (or `--non-interactive`) are passed; `--workspace` is required in non-interactive mode.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--workspace <dir>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--model <id>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--agent-dir <dir>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--bind <channel[:accountId]>` (repeatable)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--non-interactive`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Binding specs use `channel[:accountId]`. When `accountId` is omitted for WhatsApp, the default account id is used.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### `agents delete <id>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Delete an agent and prune its workspace + state.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--force`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `acp`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run the ACP bridge that connects IDEs to the Gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [`acp`](/cli/acp) for full options and examples.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Show linked session health and recent recipients.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--all` (full diagnosis; read-only, pasteable)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--deep` (probe channels)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--usage` (show model provider usage/quota)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--timeout <ms>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--verbose`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--debug` (alias for `--verbose`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Overview includes Gateway + node host service status when available.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Usage tracking（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw can surface provider usage/quota when OAuth/API creds are available.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Surfaces:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `/status` (adds a short provider usage line when available)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw status --usage` (prints full provider breakdown)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS menu bar (Usage section under Context)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Data comes directly from provider usage endpoints (no estimates).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Providers: Anthropic, GitHub Copilot, OpenAI Codex OAuth, plus Gemini CLI/Antigravity when those provider plugins are enabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If no matching credentials exist, usage is hidden.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Details: see [Usage tracking](/concepts/usage-tracking).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `health`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Fetch health from the running Gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--timeout <ms>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--verbose`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `sessions`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
List stored conversation sessions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--verbose`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--store <path>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--active <minutes>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Reset / Uninstall（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `reset`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Reset local config/state (keeps the CLI installed).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--scope <config|config+creds+sessions|full>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--yes`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--non-interactive`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--dry-run`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--non-interactive` requires `--scope` and `--yes`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `uninstall`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Uninstall the gateway service + local data (CLI remains).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--service`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--state`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--workspace`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--app`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--all`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--yes`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--non-interactive`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--dry-run`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--non-interactive` requires `--yes` and explicit scopes (or `--all`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `gateway`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run the WebSocket Gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--port <port>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--bind <loopback|tailnet|lan|auto|custom>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--token <token>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--auth <token|password>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--password <password>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--tailscale <off|serve|funnel>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--tailscale-reset-on-exit`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--allow-unconfigured`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--dev`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--reset` (reset dev config + credentials + sessions + workspace)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--force` (kill existing listener on port)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--verbose`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--claude-cli-logs`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--ws-log <auto|full|compact>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--compact` (alias for `--ws-log compact`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--raw-stream`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--raw-stream-path <path>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `gateway service`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Manage the Gateway service (launchd/systemd/schtasks).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Subcommands:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway status` (probes the Gateway RPC by default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway install` (service install)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway uninstall`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway start`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway stop`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway restart`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway status` probes the Gateway RPC by default using the service’s resolved port/config (override with `--url/--token/--password`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway status` supports `--no-probe`, `--deep`, and `--json` for scripting.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway status` also surfaces legacy or extra gateway services when it can detect them (`--deep` adds system-level scans). Profile-named OpenClaw services are treated as first-class and aren't flagged as "extra".（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway status` prints which config path the CLI uses vs which config the service likely uses (service env), plus the resolved probe target URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway install|uninstall|start|stop|restart` support `--json` for scripting (default output stays human-friendly).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway install` defaults to Node runtime; bun is **not recommended** (WhatsApp/Telegram bugs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway install` options: `--port`, `--runtime`, `--token`, `--force`, `--json`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `logs`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tail Gateway file logs via RPC.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TTY sessions render a colorized, structured view; non-TTY falls back to plain text.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json` emits line-delimited JSON (one log event per line).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Examples:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --limit 200（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --plain（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --no-color（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `gateway <subcommand>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Gateway CLI helpers (use `--url`, `--token`, `--password`, `--timeout`, `--expect-final` for RPC subcommands).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When you pass `--url`, the CLI does not auto-apply config or environment credentials.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Include `--token` or `--password` explicitly. Missing explicit credentials is an error.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Subcommands:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway call <method> [--params <json>]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway health`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway probe`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway discover`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway install|uninstall|start|stop|restart`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway run`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common RPCs:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `config.apply` (validate + write config + restart + wake)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `config.patch` (merge a partial update + restart + wake)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `update.run` (run update + restart + wake)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tip: when calling `config.set`/`config.apply`/`config.patch` directly, pass `baseHash` from（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`config.get` if a config already exists.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Models（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [/concepts/models](/concepts/models) for fallback behavior and scanning strategy.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Preferred Anthropic auth (setup-token):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
claude setup-token（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models auth setup-token --provider anthropic（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw models status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `models` (root)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`openclaw models` is an alias for `models status`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Root options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--status-json` (alias for `models status --json`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--status-plain` (alias for `models status --plain`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `models list`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--all`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--local`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--provider <name>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--plain`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `models status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--plain`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--check` (exit 1=expired/missing, 2=expiring)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--probe` (live probe of configured auth profiles)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--probe-provider <name>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--probe-profile <id>` (repeat or comma-separated)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--probe-timeout <ms>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--probe-concurrency <n>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--probe-max-tokens <n>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Always includes the auth overview and OAuth expiry status for profiles in the auth store.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`--probe` runs live requests (may consume tokens and trigger rate limits).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `models set <model>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Set `agents.defaults.model.primary`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `models set-image <model>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Set `agents.defaults.imageModel.primary`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `models aliases list|add|remove`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `list`: `--json`, `--plain`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `add <alias> <model>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `remove <alias>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `models fallbacks list|add|remove|clear`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `list`: `--json`, `--plain`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `add <model>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `remove <model>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `clear`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `models image-fallbacks list|add|remove|clear`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `list`: `--json`, `--plain`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `add <model>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `remove <model>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `clear`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `models scan`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--min-params <b>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--max-age-days <days>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--provider <name>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--max-candidates <n>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--timeout <ms>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--concurrency <n>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--no-probe`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--yes`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--no-input`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--set-default`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--set-image`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `models auth add|setup-token|paste-token`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `add`: interactive auth helper（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `setup-token`: `--provider <name>` (default `anthropic`), `--yes`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `paste-token`: `--provider <name>`, `--profile-id <id>`, `--expires-in <duration>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `models auth order get|set|clear`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `get`: `--provider <name>`, `--agent <id>`, `--json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `set`: `--provider <name>`, `--agent <id>`, `<profileIds...>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `clear`: `--provider <name>`, `--agent <id>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## System（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `system event`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Enqueue a system event and optionally trigger a heartbeat (Gateway RPC).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Required:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--text <text>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--mode <now|next-heartbeat>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--url`, `--token`, `--timeout`, `--expect-final`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `system heartbeat last|enable|disable`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Heartbeat controls (Gateway RPC).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--url`, `--token`, `--timeout`, `--expect-final`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `system presence`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
List system presence entries (Gateway RPC).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--url`, `--token`, `--timeout`, `--expect-final`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Cron（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Manage scheduled jobs (Gateway RPC). See [/automation/cron-jobs](/automation/cron-jobs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Subcommands:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `cron status [--json]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `cron list [--all] [--json]` (table output by default; use `--json` for raw)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `cron add` (alias: `create`; requires `--name` and exactly one of `--at` | `--every` | `--cron`, and exactly one payload of `--system-event` | `--message`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `cron edit <id>` (patch fields)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `cron rm <id>` (aliases: `remove`, `delete`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `cron enable <id>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `cron disable <id>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `cron runs --id <id> [--limit <n>]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `cron run <id> [--force]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
All `cron` commands accept `--url`, `--token`, `--timeout`, `--expect-final`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Node host（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`node` runs a **headless node host** or manages it as a background service. See（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[`openclaw node`](/cli/node).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Subcommands:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `node run --host <gateway-host> --port 18789`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `node status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `node install [--host <gateway-host>] [--port <port>] [--tls] [--tls-fingerprint <sha256>] [--node-id <id>] [--display-name <name>] [--runtime <node|bun>] [--force]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `node uninstall`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `node stop`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `node restart`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Nodes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`nodes` talks to the Gateway and targets paired nodes. See [/nodes](/nodes).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--url`, `--token`, `--timeout`, `--json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Subcommands:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `nodes status [--connected] [--last-connected <duration>]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `nodes describe --node <id|name|ip>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `nodes list [--connected] [--last-connected <duration>]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `nodes pending`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `nodes approve <requestId>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `nodes reject <requestId>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `nodes rename --node <id|name|ip> --name <displayName>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `nodes invoke --node <id|name|ip> --command <command> [--params <json>] [--invoke-timeout <ms>] [--idempotency-key <key>]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `nodes run --node <id|name|ip> [--cwd <path>] [--env KEY=VAL] [--command-timeout <ms>] [--needs-screen-recording] [--invoke-timeout <ms>] <command...>` (mac node or headless node host)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `nodes notify --node <id|name|ip> [--title <text>] [--body <text>] [--sound <name>] [--priority <passive|active|timeSensitive>] [--delivery <system|overlay|auto>] [--invoke-timeout <ms>]` (mac only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Camera:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `nodes camera list --node <id|name|ip>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `nodes camera snap --node <id|name|ip> [--facing front|back|both] [--device-id <id>] [--max-width <px>] [--quality <0-1>] [--delay-ms <ms>] [--invoke-timeout <ms>]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `nodes camera clip --node <id|name|ip> [--facing front|back] [--device-id <id>] [--duration <ms|10s|1m>] [--no-audio] [--invoke-timeout <ms>]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Canvas + screen:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `nodes canvas snapshot --node <id|name|ip> [--format png|jpg|jpeg] [--max-width <px>] [--quality <0-1>] [--invoke-timeout <ms>]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `nodes canvas present --node <id|name|ip> [--target <urlOrPath>] [--x <px>] [--y <px>] [--width <px>] [--height <px>] [--invoke-timeout <ms>]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `nodes canvas hide --node <id|name|ip> [--invoke-timeout <ms>]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `nodes canvas navigate <url> --node <id|name|ip> [--invoke-timeout <ms>]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `nodes canvas eval [<js>] --node <id|name|ip> [--js <code>] [--invoke-timeout <ms>]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `nodes canvas a2ui push --node <id|name|ip> (--jsonl <path> | --text <text>) [--invoke-timeout <ms>]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `nodes canvas a2ui reset --node <id|name|ip> [--invoke-timeout <ms>]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `nodes screen record --node <id|name|ip> [--screen <index>] [--duration <ms|10s>] [--fps <n>] [--no-audio] [--out <path>] [--invoke-timeout <ms>]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Location:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `nodes location get --node <id|name|ip> [--max-age <ms>] [--accuracy <coarse|balanced|precise>] [--location-timeout <ms>] [--invoke-timeout <ms>]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Browser（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Browser control CLI (dedicated Chrome/Brave/Edge/Chromium). See [`openclaw browser`](/cli/browser) and the [Browser tool](/tools/browser).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--url`, `--token`, `--timeout`, `--json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--browser-profile <name>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Manage:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `browser status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `browser start`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `browser stop`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `browser reset-profile`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `browser tabs`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `browser open <url>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `browser focus <targetId>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `browser close [targetId]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `browser profiles`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `browser create-profile --name <name> [--color <hex>] [--cdp-url <url>]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `browser delete-profile --name <name>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Inspect:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `browser screenshot [targetId] [--full-page] [--ref <ref>] [--element <selector>] [--type png|jpeg]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `browser snapshot [--format aria|ai] [--target-id <id>] [--limit <n>] [--interactive] [--compact] [--depth <n>] [--selector <sel>] [--out <path>]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Actions:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `browser navigate <url> [--target-id <id>]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `browser resize <width> <height> [--target-id <id>]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `browser click <ref> [--double] [--button <left|right|middle>] [--modifiers <csv>] [--target-id <id>]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `browser type <ref> <text> [--submit] [--slowly] [--target-id <id>]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `browser press <key> [--target-id <id>]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `browser hover <ref> [--target-id <id>]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `browser drag <startRef> <endRef> [--target-id <id>]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `browser select <ref> <values...> [--target-id <id>]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `browser upload <paths...> [--ref <ref>] [--input-ref <ref>] [--element <selector>] [--target-id <id>] [--timeout-ms <ms>]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `browser fill [--fields <json>] [--fields-file <path>] [--target-id <id>]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `browser dialog --accept|--dismiss [--prompt <text>] [--target-id <id>] [--timeout-ms <ms>]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `browser wait [--time <ms>] [--text <value>] [--text-gone <value>] [--target-id <id>]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `browser evaluate --fn <code> [--ref <ref>] [--target-id <id>]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `browser console [--level <error|warn|info>] [--target-id <id>]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `browser pdf [--target-id <id>]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Docs search（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `docs [query...]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Search the live docs index.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## TUI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `tui`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Open the terminal UI connected to the Gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--url <url>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--token <token>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--password <password>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--session <key>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--deliver`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--thinking <level>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--message <text>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--timeout-ms <ms>` (defaults to `agents.defaults.timeoutSeconds`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--history-limit <n>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
