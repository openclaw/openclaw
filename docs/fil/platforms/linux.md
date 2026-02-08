---
summary: "Suporta sa Linux + status ng companion app"
read_when:
  - Naghahanap ng status ng Linux companion app
  - Nagpaplano ng saklaw ng platform o mga kontribusyon
title: "Linux App"
x-i18n:
  source_path: platforms/linux.md
  source_hash: 93b8250cd1267004
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:37Z
---

# Linux App

Ang Gateway ay ganap na sinusuportahan sa Linux. **Node ang inirerekomendang runtime**.
Hindi inirerekomenda ang Bun para sa Gateway (mga bug sa WhatsApp/Telegram).

Planado ang mga native Linux companion app. Bukas ang mga kontribusyon kung gusto mong tumulong sa pagbuo ng isa.

## Mabilis na ruta para sa baguhan (VPS)

1. I-install ang Node 22+
2. `npm i -g openclaw@latest`
3. `openclaw onboard --install-daemon`
4. Mula sa iyong laptop: `ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
5. Buksan ang `http://127.0.0.1:18789/` at i-paste ang iyong token

Hakbang-hakbang na gabay sa VPS: [exe.dev](/install/exe-dev)

## I-install

- [Pagsisimula](/start/getting-started)
- [Install at mga update](/install/updating)
- Mga opsyonal na daloy: [Bun (eksperimental)](/install/bun), [Nix](/install/nix), [Docker](/install/docker)

## Gateway

- [Gateway runbook](/gateway)
- [Konpigurasyon](/gateway/configuration)

## Pag-install ng Gateway service (CLI)

Gamitin ang isa sa mga ito:

```
openclaw onboard --install-daemon
```

O:

```
openclaw gateway install
```

O:

```
openclaw configure
```

Piliin ang **Gateway service** kapag tinanong.

Ayusin/mag-migrate:

```
openclaw doctor
```

## Kontrol ng system (systemd user unit)

Bilang default, nag-i-install ang OpenClaw ng systemd **user** service. Gumamit ng **system**
service para sa mga shared o palaging naka-on na server. Ang buong halimbawa ng unit at gabay ay
nasa [Gateway runbook](/gateway).

Minimal na setup:

Gumawa ng `~/.config/systemd/user/openclaw-gateway[-<profile>].service`:

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

I-enable ito:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```
