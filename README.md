<p align="center">
  <a href="https://denchclaw.com">
    <img src="assets/denchclaw-hero.png" alt="DenchClaw — AI CRM, hosted locally on your Mac. Built on OpenClaw." width="680" />
  </a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/denchclaw"><img src="https://img.shields.io/npm/v/denchclaw?style=for-the-badge&color=000" alt="npm version"></a>&nbsp;
  <a href="https://discord.gg/PDFXNVQj9n"><img src="https://img.shields.io/discord/1456350064065904867?label=Discord&logo=discord&logoColor=white&color=5865F2&style=for-the-badge" alt="Discord"></a>&nbsp;
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

<p align="center">
  <a href="https://denchclaw.com">Website</a> · <a href="https://discord.gg/PDFXNVQj9n">Discord</a> · <a href="https://skills.sh">Skills Store</a> · <a href="https://www.youtube.com/watch?v=pfACTbc3Bh4&t=44s">Demo Video</a>
</p>

<br />

<p align="center">
  <a href="https://denchclaw.com">
    <img src="assets/denchclaw-app.png" alt="DenchClaw Web UI — workspace, object tables, and AI chat" width="780" />
  </a>
  <br />
  <a href="https://www.youtube.com/watch?v=pfACTbc3Bh4&t=44s">Demo Video</a> · <a href="https://discord.gg/PDFXNVQj9n">Join our Discord Server</a>
</p>

<br />

## Install

**Node 22+ required.**

```bash
npx denchclaw@latest
```

Opens at `localhost:3100` after completing onboarding wizard.

---

## Commands

```bash
npx denchclaw@latest # runs onboarding again for openclaw --profile dench
npx denchclaw@latest update # updates denchclaw web-runtime with current settings as is
npx denchclaw restart # restarts denchclaw web server
npx denchclaw start # starts denchclaw web server
npx denchclaw stop # stops denchclaw web server

# some examples
openclaw --profile dench <any openclaw command>
openclaw --profile dench gateway restart

openclaw --profile dench config set gateway.port 19001
openclaw --profile dench gateway install --force --port 19001
openclaw --profile dench gateway restart
openclaw --profile dench uninstall
```

### Daemonless / Docker

For containers or environments without systemd/launchd, set the environment variable once:

```bash
export DENCHCLAW_DAEMONLESS=1
```

This skips all gateway daemon management (install/start/stop/restart) and launchd LaunchAgent installation across all commands. You must start the gateway yourself as a foreground process:

```bash
openclaw --profile dench gateway --port 19001
```

Alternatively, pass `--skip-daemon-install` to individual commands:

```bash
npx denchclaw --skip-daemon-install
npx denchclaw update --skip-daemon-install
npx denchclaw start --skip-daemon-install
```

---

## Development

```bash
git clone https://github.com/DenchHQ/DenchClaw.git
cd denchclaw

pnpm install
pnpm build

pnpm dev
```

Web UI development:

```bash
pnpm install
pnpm web:dev
```

---

## Open Source

MIT Licensed. Fork it, extend it, make it yours.

<p align="center">
  <a href="https://star-history.com/?repos=DenchHQ%2FDenchClaw&type=date&legend=top-left">
    <img src="https://api.star-history.com/image?repos=DenchHQ/DenchClaw&type=date&legend=top-left" alt="Star History" width="620" />
  </a>
</p>

<p align="center">
  <a href="https://github.com/DenchHQ/DenchClaw"><img src="https://img.shields.io/github/stars/DenchHQ/DenchClaw?style=for-the-badge" alt="GitHub stars"></a>
</p>
