---
summary: "Linux-ondersteuning + status van de companion-app"
read_when:
  - Zoekt naar de status van de Linux companion-app
  - Plant platformdekking of bijdragen
title: "Linux-app"
---

# Linux-app

De Gateway wordt volledig ondersteund op Linux. **Node is de aanbevolen runtime**.
Bun wordt niet aanbevolen voor de Gateway (WhatsApp/Telegram-bugs).

Native Linux companion-apps zijn gepland. Bijdragen zijn welkom als je wilt helpen er een te bouwen.

## Snelle route voor beginners (VPS)

1. Installeer Node 22+
2. `npm i -g openclaw@latest`
3. `openclaw onboard --install-daemon`
4. Vanaf je laptop: `ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
5. Open `http://127.0.0.1:18789/` en plak je token

Stapsgewijze VPS-gids: [exe.dev](/install/exe-dev)

## Installeren

- [Aan de slag](/start/getting-started)
- [Installeren & updates](/install/updating)
- Optionele trajecten: [Bun (experimenteel)](/install/bun), [Nix](/install/nix), [Docker](/install/docker)

## Gateway

- [Gateway-runbook](/gateway)
- [Configuratie](/gateway/configuration)

## Gateway-service installeren (CLI)

Gebruik een van deze:

```
openclaw onboard --install-daemon
```

Of:

```
openclaw gateway install
```

Of:

```
openclaw configure
```

Selecteer **Gateway-service** wanneer hierom wordt gevraagd.

Repareren/migreren:

```
openclaw doctor
```

## Systeembeheer (systemd user unit)

OpenClaw installeert standaard een systemd-**user**-service. Gebruik een **system**
service voor gedeelde of altijd-aan servers. Het volledige unit-voorbeeld en de richtlijnen
staan in het [Gateway-runbook](/gateway).

Minimale installatie:

Maak `~/.config/systemd/user/openclaw-gateway[-<profile>].service` aan:

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

Schakel het in:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```
