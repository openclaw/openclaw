---
summary: "How the installer scripts work (install.sh + install-cli.sh), flags, and automation"
read_when:
  - You want to understand `openclaw.ai/install.sh`
  - You want to automate installs (CI / headless)
  - You want to install from a GitHub checkout
title: "Installer Internals"
---

# Installer internals

OpenClaw ships two installer scripts (served from `openclaw.ai`):

- `https://openclaw.ai/install.sh` - "recommended" installer (global npm install by default; can also install from a GitHub checkout)
- `https://openclaw.ai/install-cli.sh` - non-root-friendly CLI installer (installs into a prefix with its own Node)
- `https://openclaw.ai/install.ps1` - Windows PowerShell installer (npm by default; optional git install)

To see the current flags/behavior, run:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --help
```

Windows (PowerShell) help:

```powershell
& ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -?
```

If the installer completes but `openclaw` is not found in a new terminal, it's usually a Node/npm PATH issue. See: [Node.js](/install/node#troubleshooting).

## Flags and environment variables

### CLI flags (install.sh)

| Flag                        | Description                                      |
| --------------------------- | ------------------------------------------------ |
| `--install-method npm\|git` | Choose install method (default: `npm`)           |
| `--git-dir <path>`          | Source checkout location (default: `~/openclaw`) |
| `--no-git-update`           | Skip `git pull` when using an existing checkout  |
| `--no-prompt`               | Disable prompts (required in CI/automation)      |
| `--dry-run`                 | Print what would happen; make no changes         |
| `--no-onboard`              | Skip onboarding after install                    |

### PowerShell flags (install.ps1)

| Flag                      | Description                                     |
| ------------------------- | ----------------------------------------------- |
| `-InstallMethod npm\|git` | Choose install method (default: `npm`)          |
| `-GitDir <path>`          | Source checkout location                        |
| `-NoOnboard`              | Skip onboarding after install                   |
| `-NoGitUpdate`            | Skip `git pull` when using an existing checkout |
| `-DryRun`                 | Print what would happen; make no changes        |
| `-Tag <tag>`              | npm dist-tag to install (default: `latest`)     |

### Environment variables

Equivalent env vars (useful for CI/automation):

| Variable                           | Description                                                  |
| ---------------------------------- | ------------------------------------------------------------ |
| `OPENCLAW_INSTALL_METHOD=git\|npm` | Install method                                               |
| `OPENCLAW_GIT_DIR=<path>`          | Source checkout location                                     |
| `OPENCLAW_GIT_UPDATE=0\|1`         | Toggle git pull                                              |
| `OPENCLAW_NO_PROMPT=1`             | Disable prompts                                              |
| `OPENCLAW_DRY_RUN=1`               | Dry run mode                                                 |
| `OPENCLAW_NO_ONBOARD=1`            | Skip onboarding                                              |
| `SHARP_IGNORE_GLOBAL_LIBVIPS=0\|1` | Avoid `sharp` building against system libvips (default: `1`) |

## install.sh (recommended)

What it does (high level):

- Detect OS (macOS / Linux / WSL).
- Ensure Node.js **22+** (macOS via Homebrew; Linux via NodeSource).
- Choose install method:
  - `npm` (default): `npm install -g openclaw@latest`
  - `git`: clone/build a source checkout and install a wrapper script
- On Linux: avoid global npm permission errors by switching npm's prefix to `~/.npm-global` when needed.
- If upgrading an existing install: runs `openclaw doctor --non-interactive` (best effort).
- For git installs: runs `openclaw doctor --non-interactive` after install/update (best effort).
- Mitigates `sharp` native install gotchas by defaulting `SHARP_IGNORE_GLOBAL_LIBVIPS=1` (avoids building against system libvips).

If you _want_ `sharp` to link against a globally-installed libvips (or you're debugging), set:

```bash
SHARP_IGNORE_GLOBAL_LIBVIPS=0 curl -fsSL https://openclaw.ai/install.sh | bash
```

### Discoverability / "git install" prompt

If you run the installer while **already inside a OpenClaw source checkout** (detected via `package.json` + `pnpm-workspace.yaml`), it prompts:

- update and use this checkout (`git`)
- or migrate to the global npm install (`npm`)

In non-interactive contexts (no TTY / `--no-prompt`), you must pass `--install-method git|npm` (or set `OPENCLAW_INSTALL_METHOD`), otherwise the script exits with code `2`.

### Why Git is needed

Git is required for the `--install-method git` path (clone / pull).

For `npm` installs, Git is _usually_ not required, but some environments still end up needing it (e.g. when a package or dependency is fetched via a git URL). The installer currently ensures Git is present to avoid `spawn git ENOENT` surprises on fresh distros.

### Why npm hits `EACCES` on fresh Linux

On some Linux setups (especially after installing Node via the system package manager or NodeSource), npm's global prefix points at a root-owned location. Then `npm install -g ...` fails with `EACCES` / `mkdir` permission errors.

`install.sh` mitigates this by switching the prefix to:

- `~/.npm-global` (and adding it to `PATH` in `~/.bashrc` / `~/.zshrc` when present)

## install-cli.sh (non-root CLI installer)

This script installs `openclaw` into a prefix (default: `~/.openclaw`) and also installs a dedicated Node runtime under that prefix, so it can work on machines where you don't want to touch the system Node/npm.

Help:

```bash
curl -fsSL https://openclaw.ai/install-cli.sh | bash -s -- --help
```

## install.ps1 (Windows PowerShell)

What it does (high level):

- Ensure Node.js **22+** (winget/Chocolatey/Scoop or manual).
- Choose install method:
  - `npm` (default): `npm install -g openclaw@latest`
  - `git`: clone/build a source checkout and install a wrapper script
- Runs `openclaw doctor --non-interactive` on upgrades and git installs (best effort).

Examples:

```powershell
iwr -useb https://openclaw.ai/install.ps1 | iex
```

```powershell
iwr -useb https://openclaw.ai/install.ps1 | iex -InstallMethod git
```

```powershell
iwr -useb https://openclaw.ai/install.ps1 | iex -InstallMethod git -GitDir "C:\\openclaw"
```

Environment variables:

- `OPENCLAW_INSTALL_METHOD=git|npm`
- `OPENCLAW_GIT_DIR=...`

Git requirement:

If you choose `-InstallMethod git` and Git is missing, the installer will print the
Git for Windows link (`https://git-scm.com/download/win`) and exit.

Common Windows issues:

- **npm error spawn git / ENOENT**: install Git for Windows and reopen PowerShell, then rerun the installer.
- **"openclaw" is not recognized**: your npm global bin folder is not on PATH. Most systems use
  `%AppData%\\npm`. You can also run `npm config get prefix` and add `\\bin` to PATH, then reopen PowerShell.
