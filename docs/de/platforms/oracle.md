---
summary: "„OpenClaw auf Oracle Cloud (Always Free ARM)“"
read_when:
  - Einrichten von OpenClaw auf Oracle Cloud
  - Suche nach kostengünstigem VPS-Hosting für OpenClaw
  - Wunsch nach 24/7-OpenClaw auf einem kleinen Server
title: "Oracle Cloud"
---

# OpenClaw auf Oracle Cloud (OCI)

## Ziel

Einen persistenten OpenClaw-Gateway auf der **Always Free**-ARM-Stufe von Oracle Cloud betreiben.

Die kostenlose Stufe von Oracle kann sehr gut zu OpenClaw passen (insbesondere, wenn Sie bereits ein OCI-Konto haben), bringt jedoch einige Abwägungen mit sich:

- ARM-Architektur (das meiste funktioniert, aber einige Binärdateien sind möglicherweise nur für x86 verfügbar)
- Kapazität und Anmeldung können wählerisch sein

## Kostenvergleich (2026)

| Anbieter     | Plan            | Spezifikationen          | Preis/Monat          | Hinweise                           |
| ------------ | --------------- | ------------------------ | -------------------- | ---------------------------------- |
| Oracle Cloud | Always Free ARM | bis zu 4 OCPU, 24 GB RAM | $0                   | ARM, begrenzte Kapazität           |
| Hetzner      | CX22            | 2 vCPU, 4 GB RAM         | ~ $4 | Günstigste kostenpflichtige Option |
| DigitalOcean | Basic           | 1 vCPU, 1 GB RAM         | $6                   | Einfache UI, gute Doku             |
| Vultr        | Cloud Compute   | 1 vCPU, 1 GB RAM         | $6                   | Viele Standorte                    |
| Linode       | Nanode          | 1 vCPU, 1 GB RAM         | $5                   | Jetzt Teil von Akamai              |

---

## Voraussetzungen

- Oracle-Cloud-Konto ([Anmeldung](https://www.oracle.com/cloud/free/)) — siehe [Community-Anmeldeleitfaden](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd), falls Probleme auftreten
- Tailscale-Konto (kostenlos unter [tailscale.com](https://tailscale.com))
- ~30 Minuten

## 1. OCI-Instanz erstellen

1. Melden Sie sich bei der [Oracle Cloud Console](https://cloud.oracle.com/) an
2. Navigieren Sie zu **Compute → Instances → Create Instance**
3. Konfigurieren Sie:
   - **Name:** `openclaw`
   - **Image:** Ubuntu 24.04 (aarch64)
   - **Shape:** `VM.Standard.A1.Flex` (Ampere ARM)
   - **OCPUs:** 2 (oder bis zu 4)
   - **Memory:** 12 GB (oder bis zu 24 GB)
   - **Boot volume:** 50 GB (bis zu 200 GB kostenlos)
   - **SSH key:** Fügen Sie Ihren öffentlichen Schlüssel hinzu
4. Klicken Sie auf **Create**
5. Notieren Sie sich die öffentliche IP-Adresse

**Tipp:** Wenn die Erstellung der Instanz mit „Out of capacity“ fehlschlägt, versuchen Sie eine andere Availability Domain oder versuchen Sie es später erneut. Die Kapazität der kostenlosen Stufe ist begrenzt.

## 2. Verbinden und aktualisieren

```bash
# Connect via public IP
ssh ubuntu@YOUR_PUBLIC_IP

# Update system
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential
```

**Hinweis:** `build-essential` ist für die ARM-Kompilierung einiger Abhängigkeiten erforderlich.

## 3. Benutzer und Hostname konfigurieren

```bash
# Set hostname
sudo hostnamectl set-hostname openclaw

# Set password for ubuntu user
sudo passwd ubuntu

# Enable lingering (keeps user services running after logout)
sudo loginctl enable-linger ubuntu
```

## 4. Tailscale installieren

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname=openclaw
```

Dies aktiviert Tailscale-SSH, sodass Sie sich von jedem Gerät in Ihrem Tailnet über `ssh openclaw` verbinden können — keine öffentliche IP erforderlich.

Überprüfen:

```bash
tailscale status
```

**Ab jetzt verbinden Sie sich über Tailscale:** `ssh ubuntu@openclaw` (oder verwenden Sie die Tailscale-IP).

## 5. OpenClaw installieren

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
source ~/.bashrc
```

Wenn die Frage „How do you want to hatch your bot?“ erscheint, wählen Sie **„Do this later“**.

> Hinweis: Wenn Sie auf ARM-native Build-Probleme stoßen, beginnen Sie mit Systempaketen (z. B. `sudo apt install -y build-essential`), bevor Sie zu Homebrew greifen.

## 6. Gateway konfigurieren (loopback + Token-Auth) und Tailscale Serve aktivieren

Verwenden Sie Token-Auth als Standard. Es ist vorhersehbar und vermeidet die Notwendigkeit von „insecure auth“-Flags in der Control-UI.

```bash
# Keep the Gateway private on the VM
openclaw config set gateway.bind loopback

# Require auth for the Gateway + Control UI
openclaw config set gateway.auth.mode token
openclaw doctor --generate-gateway-token

# Expose over Tailscale Serve (HTTPS + tailnet access)
openclaw config set gateway.tailscale.mode serve
openclaw config set gateway.trustedProxies '["127.0.0.1"]'

systemctl --user restart openclaw-gateway
```

## 7. Überprüfen

```bash
# Check version
openclaw --version

# Check daemon status
systemctl --user status openclaw-gateway

# Check Tailscale Serve
tailscale serve status

# Test local response
curl http://localhost:18789
```

## 8. VCN-Sicherheit absichern

Nachdem alles funktioniert, sichern Sie das VCN ab, um sämtlichen Traffic außer Tailscale zu blockieren. Das Virtual Cloud Network von OCI fungiert als Firewall am Netzwerkrand — der Traffic wird blockiert, bevor er Ihre Instanz erreicht.

1. Gehen Sie in der OCI-Konsole zu **Networking → Virtual Cloud Networks**
2. Klicken Sie auf Ihr VCN → **Security Lists** → Default Security List
3. **Entfernen** Sie alle Ingress-Regeln außer:
   - `0.0.0.0/0 UDP 41641` (Tailscale)
4. Behalten Sie die Standard-Egress-Regeln bei (aller ausgehender Traffic erlaubt)

Dies blockiert SSH auf Port 22, HTTP, HTTPS und alles andere am Netzwerkrand. Ab jetzt können Sie sich nur noch über Tailscale verbinden.

---

## Zugriff auf die Control UI

Von jedem Gerät in Ihrem Tailscale-Netzwerk:

```
https://openclaw.<tailnet-name>.ts.net/
```

Ersetzen Sie `<tailnet-name>` durch Ihren Tailnet-Namen (sichtbar in `tailscale status`).

Kein SSH-Tunnel erforderlich. Tailscale bietet:

- HTTPS-Verschlüsselung (automatische Zertifikate)
- Authentifizierung über die Tailscale-Identität
- Zugriff von jedem Gerät in Ihrem Tailnet (Laptop, Telefon usw.)

---

## Sicherheit: VCN + Tailscale (empfohlene Basis)

Mit gesperrtem VCN (nur UDP 41641 offen) und an loopback gebundenem Gateway erhalten Sie eine starke Defense-in-Depth: Öffentlicher Traffic wird am Netzwerkrand blockiert, und der Admin-Zugriff erfolgt über Ihr Tailnet.

Dieses Setup macht zusätzliche hostbasierte Firewall-Regeln allein zum Stoppen von internetweitem SSH-Brute-Force oft _überflüssig_ — dennoch sollten Sie das Betriebssystem aktuell halten, `openclaw security audit` ausführen und überprüfen, dass Sie nicht versehentlich auf öffentlichen Interfaces lauschen.

### Was bereits geschützt ist

| Traditioneller Schritt  | Benötigt?   | Warum                                                                                           |
| ----------------------- | ----------- | ----------------------------------------------------------------------------------------------- |
| UFW-Firewall            | Nein        | VCN blockiert, bevor Traffic die Instanz erreicht                                               |
| fail2ban                | Nein        | Kein Brute-Force, wenn Port 22 im VCN blockiert ist                                             |
| sshd-Härtung            | Nein        | Tailscale-SSH verwendet kein sshd                                                               |
| Root-Login deaktivieren | Nein        | Tailscale nutzt Tailscale-Identität, keine Systembenutzer                                       |
| Nur-SSH-Key-Auth        | Nein        | Tailscale authentifiziert über Ihr Tailnet                                                      |
| IPv6-Härtung            | Meist nicht | Abhängig von VCN-/Subnetz-Einstellungen; prüfen Sie, was tatsächlich zugewiesen/freigegeben ist |

### Weiterhin empfohlen

- **Berechtigungen für Zugangsdaten:** `chmod 700 ~/.openclaw`
- **Sicherheitsaudit:** `openclaw security audit`
- **System-Updates:** `sudo apt update && sudo apt upgrade` regelmäßig
- **Tailscale überwachen:** Geräte in der [Tailscale-Admin-Konsole](https://login.tailscale.com/admin) prüfen

### Sicherheitslage überprüfen

```bash
# Confirm no public ports listening
sudo ss -tlnp | grep -v '127.0.0.1\|::1'

# Verify Tailscale SSH is active
tailscale status | grep -q 'offers: ssh' && echo "Tailscale SSH active"

# Optional: disable sshd entirely
sudo systemctl disable --now ssh
```

---

## Fallback: SSH-Tunnel

Wenn Tailscale Serve nicht funktioniert, verwenden Sie einen SSH-Tunnel:

```bash
# From your local machine (via Tailscale)
ssh -L 18789:127.0.0.1:18789 ubuntu@openclaw
```

Öffnen Sie dann `http://localhost:18789`.

---

## Fehlerbehebung

### Instanzerstellung schlägt fehl („Out of capacity“)

ARM-Instanzen der kostenlosen Stufe sind beliebt. Versuchen Sie:

- Eine andere Availability Domain
- Wiederholung zu Nebenzeiten (früher Morgen)
- Verwenden Sie beim Auswählen der Shape den Filter „Always Free“

### Tailscale verbindet sich nicht

```bash
# Check status
sudo tailscale status

# Re-authenticate
sudo tailscale up --ssh --hostname=openclaw --reset
```

### Gateway startet nicht

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl --user -u openclaw-gateway -n 50
```

### Control UI nicht erreichbar

```bash
# Verify Tailscale Serve is running
tailscale serve status

# Check gateway is listening
curl http://localhost:18789

# Restart if needed
systemctl --user restart openclaw-gateway
```

### ARM-Binärprobleme

Einige Werkzeuge haben möglicherweise keine ARM-Builds. Prüfen Sie:

```bash
uname -m  # Should show aarch64
```

Die meisten npm-Pakete funktionieren problemlos. Bei Binärdateien suchen Sie nach `linux-arm64`- oder `aarch64`-Releases.

---

## Dauerhaftigkeit

Der gesamte Zustand liegt in:

- `~/.openclaw/` — Konfiguration, Zugangsdaten, Sitzungsdaten
- `~/.openclaw/workspace/` — Workspace (SOUL.md, Speicher, Artefakte)

periodisch sichern:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Siehe auch

- [Gateway remote access](/gateway/remote) — weitere Muster für den Fernzugriff
- [Tailscale integration](/gateway/tailscale) — vollständige Tailscale-Dokumentation
- [Gateway configuration](/gateway/configuration) — alle Konfigurationsoptionen
- [DigitalOcean guide](/platforms/digitalocean) — falls Sie kostenpflichtig + einfachere Anmeldung möchten
- [Hetzner guide](/install/hetzner) — Docker-basierte Alternative
