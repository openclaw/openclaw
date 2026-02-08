---
summary: "Linux-stöd + status för Companion-appar"
read_when:
  - Letar efter status för Linux Companion-app
  - Planerar plattformsstöd eller bidrag
title: "Linux-app"
x-i18n:
  source_path: platforms/linux.md
  source_hash: 93b8250cd1267004
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:54Z
---

# Linux-app

Gateway stöds fullt ut på Linux. **Node är den rekommenderade runtime-miljön**.
Bun rekommenderas inte för Gateway (WhatsApp/Telegram-buggar).

Inbyggda Linux Companion-appar är planerade. Bidrag är välkomna om du vill hjälpa till att bygga en.

## Snabb väg för nybörjare (VPS)

1. Installera Node 22+
2. `npm i -g openclaw@latest`
3. `openclaw onboard --install-daemon`
4. Från din laptop: `ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
5. Öppna `http://127.0.0.1:18789/` och klistra in din token

Steg-för-steg-guide för VPS: [exe.dev](/install/exe-dev)

## Installera

- [Kom igång](/start/getting-started)
- [Installation och uppdateringar](/install/updating)
- Valfria flöden: [Bun (experimentell)](/install/bun), [Nix](/install/nix), [Docker](/install/docker)

## Gateway

- [Gateway-runbook](/gateway)
- [Konfiguration](/gateway/configuration)

## Installation av Gateway-tjänst (CLI)

Använd ett av dessa:

```
openclaw onboard --install-daemon
```

Eller:

```
openclaw gateway install
```

Eller:

```
openclaw configure
```

Välj **Gateway service** när du blir tillfrågad.

Reparera/migrera:

```
openclaw doctor
```

## Systemkontroll (systemd user unit)

OpenClaw installerar som standard en systemd-**user**-tjänst. Använd en **system**-tjänst för delade eller alltid-på-servrar. Ett fullständigt exempel på enhet och vägledning finns i [Gateway-runbook](/gateway).

Minimal konfiguration:

Skapa `~/.config/systemd/user/openclaw-gateway[-<profile>].service`:

```
[Unit]
Description=OpenClaw Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Aktivera den:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```
