---
summary: "Install Clawdbot (recommended installer, global install, or from source)"
read_when:
  - Installing Clawdbot
  - You want to install from GitHub
---

# Install

Runtime baseline: **Node >=22**.

## Recommended (installer script)

```bash
curl -fsSL https://clawd.bot/install.sh | bash
```

This installs the `clawdbot` CLI globally via npm and then starts onboarding.

See installer flags:

```bash
curl -fsSL https://clawd.bot/install.sh | bash -s -- --help
```

Details: [Installer internals](/install/installer).

Non-interactive (skip onboarding):

```bash
curl -fsSL https://clawd.bot/install.sh | bash -s -- --no-onboard
```

## Install method: npm vs git

The installer supports two methods:

- `npm` (default): `npm install -g clawdbot@latest`
- `git`: clone/build from GitHub and run from a source checkout

### CLI flags

```bash
# Explicit npm
curl -fsSL https://clawd.bot/install.sh | bash -s -- --install-method npm

# Install from GitHub (source checkout)
curl -fsSL https://clawd.bot/install.sh | bash -s -- --install-method git
```

Common flags:

- `--install-method npm|git`
- `--git-dir <path>` (default: `~/clawdbot`)
- `--no-git-update` (skip `git pull` when using an existing checkout)
- `--no-prompt` (disable prompts; required in CI/automation)
- `--dry-run` (print what would happen; make no changes)
- `--no-onboard` (skip onboarding)

### Environment variables

Equivalent env vars (useful for automation):

- `CLAWDBOT_INSTALL_METHOD=git|npm`
- `CLAWDBOT_GIT_DIR=...`
- `CLAWDBOT_GIT_UPDATE=0|1`
- `CLAWDBOT_NO_PROMPT=1`
- `CLAWDBOT_DRY_RUN=1`
- `CLAWDBOT_NO_ONBOARD=1`
- `SHARP_IGNORE_GLOBAL_LIBVIPS=0|1` (default: `1`; avoids `sharp` building against system libvips)

## Global install (manual)

If you already have Node:

```bash
npm install -g clawdbot@latest
```

If you have libvips installed globally (common on macOS via Homebrew) and `sharp` fails to install, force prebuilt binaries:

```bash
SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g clawdbot@latest
```

Or:

```bash
pnpm add -g clawdbot@latest
```

Then:

```bash
clawdbot onboard --install-daemon
```
