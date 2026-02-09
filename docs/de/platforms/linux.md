---
summary: "„Linux-Unterstützung + Status der Companion-App“"
read_when:
  - Status der Linux-Companion-App gesucht wird
  - Plattformabdeckung oder Beiträge geplant werden
title: "„Linux-App“"
---

# Linux-App

Der Gateway wird unter Linux vollständig unterstützt. **Node ist die empfohlene Laufzeitumgebung**.
Bun wird für den Gateway nicht empfohlen (WhatsApp-/Telegram-Bugs).

Native Linux-Companion-Apps sind geplant. Beiträge sind willkommen, wenn Sie beim Aufbau einer solchen App helfen möchten.

## Schneller Einstieg für Anfänger (VPS)

1. Node 22+ installieren
2. `npm i -g openclaw@latest`
3. `openclaw onboard --install-daemon`
4. Von Ihrem Laptop aus: `ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
5. Öffnen Sie `http://127.0.0.1:18789/` und fügen Sie Ihr Token ein

Schritt-für-Schritt-VPS-Anleitung: [exe.dev](/install/exe-dev)

## Installation

- [Erste Schritte](/start/getting-started)
- [Installation & Updates](/install/updating)
- Optionale Abläufe: [Bun (experimentell)](/install/bun), [Nix](/install/nix), [Docker](/install/docker)

## Gateway

- [Gateway-Runbook](/gateway)
- [Konfiguration](/gateway/configuration)

## Gateway-Service installieren (CLI)

Verwenden Sie eine der folgenden Optionen:

```
openclaw onboard --install-daemon
```

Oder:

```
openclaw gateway install
```

Oder:

```
openclaw configure
```

Wählen Sie **Gateway service**, wenn Sie dazu aufgefordert werden.

Reparieren/Migrieren:

```
openclaw doctor
```

## Systemsteuerung (systemd-User-Unit)

OpenClaw installiert standardmäßig einen systemd-**User**-Service. Verwenden Sie einen **System**-Service für gemeinsam genutzte oder dauerhaft laufende Server. Das vollständige Unit-Beispiel und Hinweise finden Sie im [Gateway-Runbook](/gateway).

Minimale Einrichtung:

Erstellen Sie `~/.config/systemd/user/openclaw-gateway[-<profile>].service`:

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

Aktivieren Sie ihn:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```
