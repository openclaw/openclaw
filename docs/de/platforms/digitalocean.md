---
summary: "„OpenClaw auf DigitalOcean (einfache kostenpflichtige VPS-Option)“"
read_when:
  - OpenClaw auf DigitalOcean einrichten
  - Günstiges VPS-Hosting für OpenClaw suchen
title: "DigitalOcean"
---

# OpenClaw auf DigitalOcean

## Ziel

Einen persistenten OpenClaw Gateway auf DigitalOcean für **6 $/Monat** betreiben (oder 4 $/Monat mit Reservierungspreisen).

Wenn Sie eine Option für 0 $/Monat möchten und ARM + anbieterspezifische Einrichtung in Kauf nehmen, siehe die [Oracle-Cloud-Anleitung](/platforms/oracle).

## Kostenvergleich (2026)

| Anbieter     | Plan            | Spezifikationen          | Preis/Monat                                      | Hinweise                                       |
| ------------ | --------------- | ------------------------ | ------------------------------------------------ | ---------------------------------------------- |
| Oracle Cloud | Always Free ARM | bis zu 4 OCPU, 24 GB RAM | 0 $                                              | ARM, begrenzte Kapazität / Anmelde-Eigenheiten |
| Hetzner      | CX22            | 2 vCPU, 4 GB RAM         | 3,79 € (~4 $) | Günstigste kostenpflichtige Option             |
| DigitalOcean | Basic           | 1 vCPU, 1 GB RAM         | 6 $                                              | Einfache UI, gute Doku                         |
| Vultr        | Cloud Compute   | 1 vCPU, 1 GB RAM         | 6 $                                              | Viele Standorte                                |
| Linode       | Nanode          | 1 vCPU, 1 GB RAM         | 5 $                                              | Jetzt Teil von Akamai                          |

**Anbieterauswahl:**

- DigitalOcean: einfachste UX + vorhersehbares Setup (diese Anleitung)
- Hetzner: gutes Preis-/Leistungsverhältnis (siehe [Hetzner-Anleitung](/install/hetzner))
- Oracle Cloud: kann 0 $/Monat kosten, ist aber heikler und nur ARM (siehe [Oracle-Anleitung](/platforms/oracle))

---

## Voraussetzungen

- DigitalOcean-Konto ([Registrierung mit 200 $ Guthaben](https://m.do.co/c/signup))
- SSH-Schlüsselpaar (oder Bereitschaft, Passwortauthentifizierung zu nutzen)
- ~20 Minuten

## 1. Droplet erstellen

1. Melden Sie sich bei [DigitalOcean](https://cloud.digitalocean.com/) an
2. Klicken Sie auf **Create → Droplets**
3. Wählen Sie:
   - **Region:** Am nächsten zu Ihnen (oder Ihren Nutzern)
   - **Image:** Ubuntu 24.04 LTS
   - **Size:** Basic → Regular → **6 $/Monat** (1 vCPU, 1 GB RAM, 25 GB SSD)
   - **Authentication:** SSH-Schlüssel (empfohlen) oder Passwort
4. Klicken Sie auf **Create Droplet**
5. Notieren Sie die IP-Adresse

## 2) Per SSH verbinden

```bash
ssh root@YOUR_DROPLET_IP
```

## 3. OpenClaw installieren

```bash
# Update system
apt update && apt upgrade -y

# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# Install OpenClaw
curl -fsSL https://openclaw.ai/install.sh | bash

# Verify
openclaw --version
```

## 4. Onboarding ausführen

```bash
openclaw onboard --install-daemon
```

Der Assistent führt Sie durch:

- Modell-Authentifizierung (API-Schlüssel oder OAuth)
- Kanal-Einrichtung (Telegram, WhatsApp, Discord usw.)
- Gateway-Token (automatisch generiert)
- Daemon-Installation (systemd)

## 5. Gateway überprüfen

```bash
# Check status
openclaw status

# Check service
systemctl --user status openclaw-gateway.service

# View logs
journalctl --user -u openclaw-gateway.service -f
```

## 6. Zugriff auf das Dashboard

Der Gateway bindet standardmäßig an den loopback. Um auf die Control UI zuzugreifen:

**Option A: SSH-Tunnel (empfohlen)**

```bash
# From your local machine
ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP

# Then open: http://localhost:18789
```

**Option B: Tailscale Serve (HTTPS, nur loopback)**

```bash
# On the droplet
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# Configure Gateway to use Tailscale Serve
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

Öffnen: `https://<magicdns>/`

Hinweise:

- Serve hält den Gateway ausschließlich auf loopback und authentifiziert über Tailscale-Identitäts-Header.
- Um stattdessen Token/Passwort zu erzwingen, setzen Sie `gateway.auth.allowTailscale: false` oder verwenden Sie `gateway.auth.mode: "password"`.

**Option C: Tailnet-Bind (ohne Serve)**

```bash
openclaw config set gateway.bind tailnet
openclaw gateway restart
```

Öffnen: `http://<tailscale-ip>:18789` (Token erforderlich).

## 7. Ihre Kanäle verbinden

### Telegram

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

### WhatsApp

```bash
openclaw channels login whatsapp
# Scan QR code
```

Siehe [Kanäle](/channels) für weitere Anbieter.

---

## Optimierungen für 1 GB RAM

Der 6-$-Droplet hat nur 1 GB RAM. So bleibt alles stabil:

### Swap hinzufügen (empfohlen)

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### Leichteres Modell verwenden

Wenn Sie OOMs sehen, erwägen Sie:

- API-basierte Modelle (Claude, GPT) statt lokaler Modelle zu verwenden
- `agents.defaults.model.primary` auf ein kleineres Modell zu setzen

### Speicher überwachen

```bash
free -h
htop
```

---

## Dauerhaftigkeit

Der gesamte Zustand befindet sich in:

- `~/.openclaw/` — Konfiguration, Anmeldedaten, Sitzungsdaten
- `~/.openclaw/workspace/` — Workspace (SOUL.md, Speicher usw.)

Diese überstehen Neustarts. Sichern Sie sie regelmäßig:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Oracle-Cloud-Free-Alternative

Oracle Cloud bietet **Always Free** ARM-Instanzen, die deutlich leistungsfähiger sind als jede kostenpflichtige Option hier — für 0 $/Monat.

| Was Sie erhalten        | Spezifikationen               |
| ----------------------- | ----------------------------- |
| **4 OCPUs**             | ARM Ampere A1                 |
| **24 GB RAM**           | Mehr als ausreichend          |
| **200 GB Speicher**     | Block-Volume                  |
| **Dauerhaft kostenlos** | Keine Kreditkartenbelastungen |

**Einschränkungen:**

- Die Anmeldung kann heikel sein (bei Fehlschlag erneut versuchen)
- ARM-Architektur — das meiste funktioniert, einige Binaries benötigen jedoch ARM-Builds

Für die vollständige Einrichtungsanleitung siehe [Oracle Cloud](/platforms/oracle). Für Anmeldetipps und Fehlerbehebung beim Enrollment-Prozess siehe diese [Community-Anleitung](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd).

---

## Fehlerbehebung

### Gateway startet nicht

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl -u openclaw --no-pager -n 50
```

### Port bereits belegt

```bash
lsof -i :18789
kill <PID>
```

### Zu wenig Speicher

```bash
# Check memory
free -h

# Add more swap
# Or upgrade to $12/mo droplet (2GB RAM)
```

---

## Siehe auch

- [Hetzner-Anleitung](/install/hetzner) — günstiger, leistungsfähiger
- [Docker-Installation](/install/docker) — containerisiertes Setup
- [Tailscale](/gateway/tailscale) — sicherer Remote-Zugriff
- [Konfiguration](/gateway/configuration) — vollständige Konfigurationsreferenz
