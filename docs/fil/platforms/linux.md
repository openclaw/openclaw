---
summary: "Suporta sa Linux + status ng companion app"
read_when:
  - Naghahanap ng status ng Linux companion app
  - Nagpaplano ng saklaw ng platform o mga kontribusyon
title: "Linux App"
---

# Linux App

Ang Gateway ay ganap na suportado sa Linux. **Inirerekomendang runtime ang Node**.
Hindi inirerekomenda ang Bun para sa Gateway (mga bug sa WhatsApp/Telegram).

May planong mga native Linux companion app. Tinatanggap ang mga kontribusyon kung nais mong tumulong sa paggawa nito.

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
service para sa mga shared o laging-on na server. Ang buong halimbawa ng unit at gabay ay
matatagpuan sa [Gateway runbook](/gateway).

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
