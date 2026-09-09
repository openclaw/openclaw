---
doc-schema-version: 1
summary: "Uninstall OpenClaw completely (CLI, service, state, workspace)"
read_when:
  - You want to remove OpenClaw from a machine
  - The gateway service is still running after uninstall
title: "Uninstall"
---

Remove the service and selected local data first, then [any remaining CLI install](#remove-the-cli). State deletion can also remove installation files nested inside that directory. Choose:

- **Easy path** if `openclaw` is still installed.
- **Manual service removal** if the CLI is gone but the service is still running.

## Easy path (CLI still installed)

The command attempts independent requested cleanup scopes and returns a nonzero status if any scope fails or is blocked. Service teardown remains the safety gate for state and workspace deletion; if that gate fails, those data scopes are preserved while app cleanup is still attempted. Partial cleanup is reported explicitly and is never followed by an unconditional completion result.

```bash
openclaw uninstall
```

The interactive prompt preselects only the Gateway service. For complete local
removal, also select state, workspace, and app in the prompt, or run
`openclaw uninstall --all`. State removal preserves configured workspace
directories unless you also select `--workspace`.

Preview what will be removed (safe):

```bash
openclaw uninstall --dry-run --all
```

Non-interactive (automation / npx). Use with caution and only after confirming scopes:

```bash
openclaw uninstall --all --yes --non-interactive
npx -y openclaw uninstall --all --yes --non-interactive
```

Flags: `--service`, `--state`, `--workspace`, `--app` select individual scopes; `--all` selects all four.

Unlike `openclaw uninstall --state`, manual state deletion does not preserve
workspaces. Stop and uninstall the service successfully before deleting files.
Before manual state or prefix deletion, move any configuration you want to keep outside that directory.

1. Stop the gateway service:

```bash
openclaw gateway stop
```

2. Uninstall the gateway service (launchd/systemd/schtasks):

```bash
openclaw gateway uninstall
```

3. Decide whether to preserve the workspace.

Move every configured workspace you want to keep, including `~/.openclaw/workspace`,
outside the state directory before manual deletion. Workspaces inside that directory
will otherwise be deleted with it; they need no separate deletion.

4. Delete state + config:

```bash
rm -rf "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
```

If you set `OPENCLAW_CONFIG_PATH` to a custom location outside the state dir, delete that file too.
Restore preserved workspaces after recreating their parent, or configure their new paths on reinstall.

5. Delete an external workspace only if you want to remove its agent files too:

```bash
rm -rf /path/to/external/workspace
```

6. [Remove the CLI](#remove-the-cli) using the installation owner below.

7. If you installed the macOS app:

```bash
rm -rf /Applications/OpenClaw.app
```

- If you used profiles (`--profile` / `OPENCLAW_PROFILE`), repeat steps 3-4 for each state dir (defaults are `~/.openclaw-<profile>`).
- In remote mode, the state dir lives on the **gateway host**, so run steps 1-4 there too.

## Manual service removal (CLI not installed)

Use this if the gateway service keeps running but `openclaw` is missing.

### macOS (launchd)

Default label is `ai.openclaw.gateway` (or `ai.openclaw.<profile>` with a profile):

```bash
launchctl bootout gui/$UID/ai.openclaw.gateway
rm -f ~/Library/LaunchAgents/ai.openclaw.gateway.plist
```

If you used a profile, replace the label and plist name with `ai.openclaw.<profile>`.

### Linux (systemd user unit)

Default unit name is `openclaw-gateway.service` (or `openclaw-gateway-<profile>.service`). A pre-rename `clawdbot-gateway.service` unit may still exist on machines upgraded from very old installs; `openclaw uninstall` / `openclaw gateway uninstall` detects and removes it automatically.

```bash
systemctl --user disable --now openclaw-gateway.service
rm -f ~/.config/systemd/user/openclaw-gateway.service{,.bak}
systemctl --user daemon-reload
```

### Windows (Scheduled Task)

Default task name is `OpenClaw Gateway` (or `OpenClaw Gateway (<profile>)`).
The task launches a windowless `gateway.vbs` script under your state dir, which in turn
runs `gateway.cmd`; remove both.

```powershell
schtasks /Delete /F /TN "OpenClaw Gateway"
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.cmd" -ErrorAction SilentlyContinue
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.vbs" -ErrorAction SilentlyContinue
```

If you used a profile, delete the matching task name and the `gateway.cmd` /
`gateway.vbs` files under `~\.openclaw-<profile>`.

<a id="normal-install-vs-source-checkout" />
<a id="normal-install-(install.sh-%2F-npm-%2F-pnpm-%2F-bun)" />
<a id="normal-install-install-sh-/-npm-/-pnpm-/-bun" />
<a id="source-checkout-(git-clone)" />
<a id="source-checkout-git-clone" />

## Remove the CLI

Remove the Gateway service **before** deleting a checkout, launcher, or prefix. Inspect the resolved command and its target first; if ownership is unclear, leave it in place. Check [Installer internals](/install/installer) for custom checkout and prefix options.

| Installation method                               | CLI owner and removal                                                                                                                                                                                                        |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global npm (`install.sh` / `install.ps1` default) | Run `npm rm -g openclaw` with the npm/prefix that owns this install.                                                                                                                                                         |
| Global pnpm or Bun                                | Run only the matching command: `pnpm remove -g openclaw` or `bun remove -g openclaw`.                                                                                                                                        |
| `install.sh --install-method git`                 | Inspect `~/.local/bin/openclaw`; remove that launcher only if it points to the intended checkout, then remove that checkout.                                                                                                 |
| `install.ps1 -InstallMethod git`                  | Inspect `%USERPROFILE%\.local\bin\openclaw.cmd`; remove that launcher only if it points to the intended checkout, then remove that checkout.                                                                                 |
| `install-cli.sh` (npm or Git)                     | Inspect `<prefix>/bin/openclaw`. The prefix defaults to `~/.openclaw`; `--prefix` / `OPENCLAW_PREFIX` overrides it. Remove a dedicated prefix only after preserving data; Git mode also needs its separate checkout removed. |
| Direct source checkout                            | Remove only your own wrapper/symlink, then the checkout. Keep shims owned by other installations.                                                                                                                            |

Git checkouts default to `~/openclaw` (`%USERPROFILE%\openclaw` on Windows); use the actual target of the launcher, including custom `--git-dir` / `-GitDir` or `OPENCLAW_GIT_DIR`. On POSIX, `OPENCLAW_HOME` can change the default checkout. Remove state/workspaces only as selected above.

Before deleting a prefix, move any state, configuration, and workspaces you want to keep outside it. **Never delete a shared prefix wholesale**: remove only verified OpenClaw files, preserving shared Node runtimes, packages, and tools.

If completion was installed, remove only its `# OpenClaw Completion` block and OpenClaw source line from the [selected shell profile](/cli/completion#install-flow). Remove a legacy `openclaw completion` source/eval line only if it contains no other command; preserve surrounding content.

Remove an installer-added PATH entry only when no other command uses it. Keep shared bin directories such as `~/.local/bin`. On Windows, the same rule applies to portable Node/MinGit and their PATH entries under `%LOCALAPPDATA%\OpenClaw\deps`.

Open a new shell and check `command -v openclaw` (PowerShell: `Get-Command openclaw -ErrorAction SilentlyContinue`). If a command still resolves, inspect it: a second install or foreign wrapper may remain.

## Related

- [Install overview](/install)
- [Migration guide](/install/migrating)
