---
summary: "Linux-understøttelse + status for companion-app"
read_when:
  - Leder efter status for Linux companion-app
  - Planlægger platformsdækning eller bidrag
title: "Linux-app"
---

# Linux-app

Gateway er fuldt understøttet på Linux. **Node er den anbefalede runtime**.
Bun anbefales ikke til Gateway (WhatsApp/Telegram bugs).

Indfødte Linux følgesvend apps er planlagt. Bidrag er velkomne, hvis du ønsker at hjælpe med at opbygge en.

## Hurtig vej for begyndere (VPS)

1. Installér Node 22+
2. `npm i -g openclaw@latest`
3. `openclaw onboard --install-daemon`
4. Fra din laptop: `ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
5. Åbn `http://127.0.0.1:18789/` og indsæt dit token

Trin-for-trin VPS-guide: [exe.dev](/install/exe-dev)

## Installér

- [Kom godt i gang](/start/getting-started)
- [Installér & opdateringer](/install/updating)
- Valgfrie flows: [Bun (eksperimentel)](/install/bun), [Nix](/install/nix), [Docker](/install/docker)

## Gateway

- [Gateway runbook](/gateway)
- [Konfiguration](/gateway/configuration)

## Installation af Gateway-tjeneste (CLI)

Brug en af disse:

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

Vælg **Gateway-tjeneste** når du bliver spurgt.

Reparer/migrér:

```
openclaw doctor
```

## Systemstyring (systemd bruger-enhed)

OpenClaw installerer en systemd **user** service som standard. Brug en **system**
-tjeneste til delte eller altid-på servere. The full unit example and guidance
live in the [Gateway runbook](/gateway).

Minimal opsætning:

Opret `~/.config/systemd/user/openclaw-gateway[-<profile>].service`:

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

Aktivér den:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```
