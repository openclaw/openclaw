---
summary: "Automatisierte, gehärtete OpenClaw-Installation mit Ansible, Tailscale-VPN und Firewall-Isolation"
read_when:
  - Sie möchten eine automatisierte Serverbereitstellung mit Sicherheits-Härtung
  - Sie benötigen ein firewall-isoliertes Setup mit VPN-Zugriff
  - Sie stellen auf entfernten Debian-/Ubuntu-Servern bereit
title: "Ansible"
---

# Ansible-Installation

Der empfohlene Weg, OpenClaw auf Produktionsservern bereitzustellen, ist **[openclaw-ansible](https://github.com/openclaw/openclaw-ansible)** — ein automatisierter Installer mit sicherheitsorientierter Architektur.

## Schnellstart

Installation mit einem Befehl:

```bash
curl -fsSL https://raw.githubusercontent.com/openclaw/openclaw-ansible/main/install.sh | bash
```

> **📦 Vollständige Anleitung: [github.com/openclaw/openclaw-ansible](https://github.com/openclaw/openclaw-ansible)**
>
> Das openclaw-ansible-Repository ist die maßgebliche Quelle für die Ansible-Bereitstellung. Diese Seite bietet einen kurzen Überblick.

## Was Sie erhalten

- 🔒 **Firewall-first-Sicherheit**: UFW + Docker-Isolation (nur SSH + Tailscale erreichbar)
- 🔐 **Tailscale VPN**: Sicherer Remote-Zugriff ohne öffentliche Exponierung von Diensten
- 🐳 **Docker**: Isolierte Sandbox-Container, Bindings nur an localhost
- 🛡️ **Defense in depth**: 4‑schichtige Sicherheitsarchitektur
- 🚀 **Ein-Befehl-Setup**: Vollständige Bereitstellung in wenigen Minuten
- 🔧 **Systemd-Integration**: Automatischer Start beim Booten mit Härtung

## Anforderungen

- **OS**: Debian 11+ oder Ubuntu 20.04+
- **Zugriff**: Root- oder sudo-Rechte
- **Netzwerk**: Internetverbindung für Paketinstallation
- **Ansible**: 2.14+ (wird vom Schnellstart-Skript automatisch installiert)

## Was wird installiert

Das Ansible-Playbook installiert und konfiguriert:

1. **Tailscale** (Mesh-VPN für sicheren Remote-Zugriff)
2. **UFW-Firewall** (nur SSH- und Tailscale-Ports)
3. **Docker CE + Compose V2** (für Agent-sandboxes)
4. **Node.js 22.x + pnpm** (Runtime-Abhängigkeiten)
5. **OpenClaw** (hostbasiert, nicht containerisiert)
6. **Systemd-Dienst** (Autostart mit Sicherheits-Härtung)

Hinweis: Das Gateway läuft **direkt auf dem Host** (nicht in Docker), Agent-sandboxes nutzen jedoch Docker zur Isolation. Details finden Sie unter [Sandboxing](/gateway/sandboxing).

## Post-Install-Einrichtung

Nach Abschluss der Installation wechseln Sie zum Benutzer openclaw:

```bash
sudo -i -u openclaw
```

Das Post-Install-Skript führt Sie durch:

1. **Onboarding-Assistent**: OpenClaw-Einstellungen konfigurieren
2. **Anbieter-Login**: WhatsApp/Telegram/Discord/Signal verbinden
3. **Gateway-Test**: Installation verifizieren
4. **Tailscale-Einrichtung**: Verbindung zu Ihrem VPN-Mesh herstellen

### Schnelle Befehle

```bash
# Check service status
sudo systemctl status openclaw

# View live logs
sudo journalctl -u openclaw -f

# Restart gateway
sudo systemctl restart openclaw

# Provider login (run as openclaw user)
sudo -i -u openclaw
openclaw channels login
```

## Sicherheitsarchitektur

### 4‑schichtige Verteidigung

1. **Firewall (UFW)**: Öffentlich nur SSH (22) + Tailscale (41641/udp)
2. **VPN (Tailscale)**: Gateway nur über das VPN-Mesh erreichbar
3. **Docker-Isolation**: DOCKER-USER-iptables-Chain verhindert externe Portfreigaben
4. **Systemd-Härtung**: NoNewPrivileges, PrivateTmp, nicht privilegierter Benutzer

### Verifikation

Externe Angriffsfläche testen:

```bash
nmap -p- YOUR_SERVER_IP
```

Es sollte **nur Port 22** (SSH) offen sein. Alle anderen Dienste (Gateway, Docker) sind abgeschottet.

### Docker-Verfügbarkeit

Docker ist für **Agent-sandboxes** (isolierte Werkzeugausführung) installiert, nicht für den Betrieb des Gateways selbst. Das Gateway bindet ausschließlich an localhost und ist über das Tailscale-VPN erreichbar.

Siehe [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) für die Sandbox-Konfiguration.

## Manuelle Installation

Wenn Sie manuelle Kontrolle gegenüber der Automatisierung bevorzugen:

```bash
# 1. Install prerequisites
sudo apt update && sudo apt install -y ansible git

# 2. Clone repository
git clone https://github.com/openclaw/openclaw-ansible.git
cd openclaw-ansible

# 3. Install Ansible collections
ansible-galaxy collection install -r requirements.yml

# 4. Run playbook
./run-playbook.sh

# Or run directly (then manually execute /tmp/openclaw-setup.sh after)
# ansible-playbook playbook.yml --ask-become-pass
```

## OpenClaw aktualisieren

Der Ansible-Installer richtet OpenClaw für manuelle Updates ein. Siehe [Updating](/install/updating) für den standardmäßigen Update-Ablauf.

Um das Ansible-Playbook erneut auszuführen (z. B. für Konfigurationsänderungen):

```bash
cd openclaw-ansible
./run-playbook.sh
```

Hinweis: Dies ist idempotent und kann gefahrlos mehrfach ausgeführt werden.

## Fehlerbehebung

### Firewall blockiert meine Verbindung

Wenn Sie ausgesperrt sind:

- Stellen Sie sicher, dass Sie zuerst über das Tailscale-VPN zugreifen können
- SSH-Zugriff (Port 22) ist immer erlaubt
- Das Gateway ist **ausschließlich** über Tailscale erreichbar — absichtlich so konzipiert

### Dienst startet nicht

```bash
# Check logs
sudo journalctl -u openclaw -n 100

# Verify permissions
sudo ls -la /opt/openclaw

# Test manual start
sudo -i -u openclaw
cd ~/openclaw
pnpm start
```

### Docker-Sandbox-Probleme

```bash
# Verify Docker is running
sudo systemctl status docker

# Check sandbox image
sudo docker images | grep openclaw-sandbox

# Build sandbox image if missing
cd /opt/openclaw/openclaw
sudo -u openclaw ./scripts/sandbox-setup.sh
```

### Anbieter-Login schlägt fehl

Stellen Sie sicher, dass Sie als Benutzer `openclaw` arbeiten:

```bash
sudo -i -u openclaw
openclaw channels login
```

## Erweiterte Konfiguration

Für detaillierte Sicherheitsarchitektur und Fehlerbehebung:

- [Sicherheitsarchitektur](https://github.com/openclaw/openclaw-ansible/blob/main/docs/security.md)
- [Technische Details](https://github.com/openclaw/openclaw-ansible/blob/main/docs/architecture.md)
- [Fehlerbehebungsleitfaden](https://github.com/openclaw/openclaw-ansible/blob/main/docs/troubleshooting.md)

## Verwandt

- [openclaw-ansible](https://github.com/openclaw/openclaw-ansible) — vollständige Bereitstellungsanleitung
- [Docker](/install/docker) — containerisierte Gateway-Einrichtung
- [Sandboxing](/gateway/sandboxing) — Agent-Sandbox-Konfiguration
- [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) — Isolation pro Agent
