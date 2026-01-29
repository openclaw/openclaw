# Installation Guide

## Prerequisites

- macOS (any version, Intel or Apple Silicon)
- Node.js 22+ (`brew install node@22` or use nvm)
- 2GB RAM minimum (4GB+ for browser automation)
- Anthropic API key or Claude Pro/Max subscription

## Installation Methods

### Method 1: Quick Install (Recommended)

```bash
curl -fsSL https://clawd.bot/install.sh | bash
```

### Method 2: npm/pnpm Global Install

```bash
npm install -g dna@latest
# or
pnpm add -g dna@latest
```

### Method 3: From Source (Development)

```bash
git clone https://github.com/dna/dna.git
cd dna && pnpm install && pnpm build
pnpm dna onboard --install-daemon
```

## Onboarding Wizard

After installation, run:

```bash
dna onboard --install-daemon
```

The wizard walks through:
- Model selection (Claude Opus 4.5 recommended)
- Channel setup (WhatsApp most popular)
- Security settings
- macOS LaunchAgent installation for background operation

## macOS Companion App

Native menu bar integration with system notifications and TCC permission handling:

```bash
cd apps/macos && swift build
```

Exposes Mac-specific tools like Canvas and system.run.

## First Test

Send "Hello" from your approved WhatsApp number. If the lobster emoji 🦞 greets you back, you're operational.

## Common First-Day Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| Installation fails | Node version < 22 | `nvm install 22 && nvm use 22` |
| WhatsApp QR expires | Takes longer than 60s | Re-run `dna channels login` |
| Discord not working | MESSAGE CONTENT INTENT disabled | Enable in Discord Developer Portal |
| Messages blocked | Unknown sender | Use `dna pairing approve whatsapp <code>` |

## Update Procedure

```bash
curl -fsSL https://clawd.bot/install.sh | bash
dna doctor
dna daemon restart
dna health
```

**Update channels:** `stable` (default), `beta` (prerelease), `dev` (main branch HEAD)
