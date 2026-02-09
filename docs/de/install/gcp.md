---
summary: "„OpenClaw Gateway 24/7 auf einer GCP-Compute-Engine-VM (Docker) mit dauerhaftem Zustand betreiben“"
read_when:
  - Sie möchten OpenClaw 24/7 auf GCP betreiben
  - Sie möchten ein produktionsreifes, dauerhaft laufendes Gateway auf Ihrer eigenen VM
  - Sie möchten volle Kontrolle über Persistenz, Binärdateien und Neustartverhalten
title: "„GCP“"
---

# OpenClaw auf GCP Compute Engine (Docker, Produktions‑VPS‑Leitfaden)

## Ziel

Betreiben Sie ein persistentes OpenClaw Gateway auf einer GCP-Compute-Engine-VM mit Docker, mit dauerhaftem Zustand, eingebetteten Binärdateien und sicherem Neustartverhalten.

Wenn Sie „OpenClaw 24/7 für ~5–12 $/Monat“ möchten, ist dies ein zuverlässiges Setup auf Google Cloud.
Die Preise variieren je nach Maschinentyp und Region; wählen Sie die kleinste VM, die zu Ihrer Arbeitslast passt, und skalieren Sie hoch, wenn OOMs auftreten.

## Was machen wir (einfach erklärt)?

- Ein GCP-Projekt erstellen und Abrechnung aktivieren
- Eine Compute-Engine-VM erstellen
- Docker installieren (isolierte App-Laufzeit)
- Das OpenClaw Gateway in Docker starten
- `~/.openclaw` + `~/.openclaw/workspace` auf dem Host persistieren (überlebt Neustarts/Neubauten)
- Zugriff auf die Control UI von Ihrem Laptop über einen SSH-Tunnel

Auf das Gateway kann zugegriffen werden über:

- SSH-Portweiterleitung von Ihrem Laptop
- Direkte Portfreigabe, wenn Sie Firewalling und Tokens selbst verwalten

Dieser Leitfaden verwendet Debian auf GCP Compute Engine.
Ubuntu funktioniert ebenfalls; passen Sie die Pakete entsprechend an.
Für den generischen Docker‑Ablauf siehe [Docker](/install/docker).

---

## Schneller Weg (erfahrene Operatoren)

1. GCP-Projekt erstellen + Compute Engine API aktivieren
2. Compute-Engine-VM erstellen (e2-small, Debian 12, 20 GB)
3. Per SSH auf die VM verbinden
4. Docker installieren
5. OpenClaw-Repository klonen
6. Persistente Host-Verzeichnisse erstellen
7. `.env` und `docker-compose.yml` konfigurieren
8. Benötigte Binärdateien, Build und Start backen

---

## Was Sie benötigen

- GCP-Konto (Free Tier für e2-micro verfügbar)
- gcloud CLI installiert (oder Cloud Console verwenden)
- SSH-Zugriff von Ihrem Laptop
- Grundlegende Vertrautheit mit SSH + Copy/Paste
- ~20–30 Minuten
- Docker und Docker Compose
- Modell-Authentifizierungsdaten
- Optionale Anbieter-Zugangsdaten
  - WhatsApp-QR
  - Telegram-Bot-Token
  - Gmail-OAuth

---

## 1. gcloud CLI installieren (oder Console verwenden)

**Option A: gcloud CLI** (empfohlen für Automatisierung)

Installation über [https://cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install)

Initialisieren und authentifizieren:

```bash
gcloud init
gcloud auth login
```

**Option B: Cloud Console**

Alle Schritte können über die Web-UI unter [https://console.cloud.google.com](https://console.cloud.google.com) durchgeführt werden.

---

## 2. GCP-Projekt erstellen

**CLI:**

```bash
gcloud projects create my-openclaw-project --name="OpenClaw Gateway"
gcloud config set project my-openclaw-project
```

Abrechnung unter [https://console.cloud.google.com/billing](https://console.cloud.google.com/billing) aktivieren (erforderlich für Compute Engine).

Compute-Engine-API aktivieren:

```bash
gcloud services enable compute.googleapis.com
```

**Console:**

1. Zu IAM & Admin > Projekt erstellen gehen
2. Benennen und erstellen
3. Abrechnung für das Projekt aktivieren
4. Zu APIs & Services > APIs aktivieren > nach „Compute Engine API“ suchen > Aktivieren

---

## 3. VM erstellen

**Maschinentypen:**

| Typ      | Spezifikationen                               | Kosten                      | Hinweise                        |
| -------- | --------------------------------------------- | --------------------------- | ------------------------------- |
| e2-small | 2 vCPU, 2 GB RAM                              | ~12 $/Monat | Empfohlen                       |
| e2-micro | 2 vCPU (geteilt), 1 GB RAM | Free-Tier-fähig             | Kann unter Last OOM verursachen |

**CLI:**

```bash
gcloud compute instances create openclaw-gateway \
  --zone=us-central1-a \
  --machine-type=e2-small \
  --boot-disk-size=20GB \
  --image-family=debian-12 \
  --image-project=debian-cloud
```

**Console:**

1. Zu Compute Engine > VM-Instanzen > Instanz erstellen gehen
2. Name: `openclaw-gateway`
3. Region: `us-central1`, Zone: `us-central1-a`
4. Maschinentyp: `e2-small`
5. Boot-Datenträger: Debian 12, 20 GB
6. Erstellen

---

## 4. Per SSH auf die VM verbinden

**CLI:**

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

**Console:**

Klicken Sie im Compute-Engine-Dashboard neben Ihrer VM auf die Schaltfläche „SSH“.

Hinweis: Die SSH-Schlüsselübertragung kann nach der VM-Erstellung 1–2 Minuten dauern. Wenn die Verbindung abgelehnt wird, warten Sie und versuchen Sie es erneut.

---

## 5. Docker installieren (auf der VM)

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

Ab- und wieder anmelden, damit die Gruppenänderung wirksam wird:

```bash
exit
```

Dann erneut per SSH verbinden:

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

Überprüfen:

```bash
docker --version
docker compose version
```

---

## 6. OpenClaw-Repository klonen

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

Dieser Leitfaden geht davon aus, dass Sie ein benutzerdefiniertes Image bauen, um die Persistenz der Binärdateien zu garantieren.

---

## 7. Persistente Host-Verzeichnisse erstellen

Docker-Container sind flüchtig.
Alle langlebigen Zustände müssen auf dem Host liegen.

```bash
mkdir -p ~/.openclaw
mkdir -p ~/.openclaw/workspace
```

---

## 8. Umgebungsvariablen konfigurieren

Erstellen Sie `.env` im Repository-Stammverzeichnis.

```bash
OPENCLAW_IMAGE=openclaw:latest
OPENCLAW_GATEWAY_TOKEN=change-me-now
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_PORT=18789

OPENCLAW_CONFIG_DIR=/home/$USER/.openclaw
OPENCLAW_WORKSPACE_DIR=/home/$USER/.openclaw/workspace

GOG_KEYRING_PASSWORD=change-me-now
XDG_CONFIG_HOME=/home/node/.openclaw
```

Starke Geheimnisse generieren:

```bash
openssl rand -hex 32
```

**Diese Datei nicht committen.**

---

## 9. Docker-Compose-Konfiguration

Erstellen oder aktualisieren Sie `docker-compose.yml`.

```yaml
services:
  openclaw-gateway:
    image: ${OPENCLAW_IMAGE}
    build: .
    restart: unless-stopped
    env_file:
      - .env
    environment:
      - HOME=/home/node
      - NODE_ENV=production
      - TERM=xterm-256color
      - OPENCLAW_GATEWAY_BIND=${OPENCLAW_GATEWAY_BIND}
      - OPENCLAW_GATEWAY_PORT=${OPENCLAW_GATEWAY_PORT}
      - OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}
      - GOG_KEYRING_PASSWORD=${GOG_KEYRING_PASSWORD}
      - XDG_CONFIG_HOME=${XDG_CONFIG_HOME}
      - PATH=/home/linuxbrew/.linuxbrew/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    volumes:
      - ${OPENCLAW_CONFIG_DIR}:/home/node/.openclaw
      - ${OPENCLAW_WORKSPACE_DIR}:/home/node/.openclaw/workspace
    ports:
      # Recommended: keep the Gateway loopback-only on the VM; access via SSH tunnel.
      # To expose it publicly, remove the `127.0.0.1:` prefix and firewall accordingly.
      - "127.0.0.1:${OPENCLAW_GATEWAY_PORT}:18789"

      # Optional: only if you run iOS/Android nodes against this VM and need Canvas host.
      # If you expose this publicly, read /gateway/security and firewall accordingly.
      # - "18793:18793"
    command:
      [
        "node",
        "dist/index.js",
        "gateway",
        "--bind",
        "${OPENCLAW_GATEWAY_BIND}",
        "--port",
        "${OPENCLAW_GATEWAY_PORT}",
      ]
```

---

## 10. Erforderliche Binärdateien in das Image einbacken (kritisch)

Das Installieren von Binärdateien in einem laufenden Container ist eine Falle.
Alles, was zur Laufzeit installiert wird, geht beim Neustart verloren.

Alle externen Binärdateien, die von Skills benötigt werden, müssen zur Build-Zeit des Images installiert werden.

Die folgenden Beispiele zeigen nur drei gängige Binärdateien:

- `gog` für Gmail-Zugriff
- `goplaces` für Google Places
- `wacli` für WhatsApp

Dies sind Beispiele, keine vollständige Liste.
Sie können beliebig viele Binärdateien nach demselben Muster installieren.

Wenn Sie später neue Skills hinzufügen, die zusätzliche Binärdateien benötigen, müssen Sie:

1. Das Dockerfile aktualisieren
2. Das Image neu bauen
3. Die Container neu starten

**Beispiel-Dockerfile**

```dockerfile
FROM node:22-bookworm

RUN apt-get update && apt-get install -y socat && rm -rf /var/lib/apt/lists/*

# Example binary 1: Gmail CLI
RUN curl -L https://github.com/steipete/gog/releases/latest/download/gog_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/gog

# Example binary 2: Google Places CLI
RUN curl -L https://github.com/steipete/goplaces/releases/latest/download/goplaces_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/goplaces

# Example binary 3: WhatsApp CLI
RUN curl -L https://github.com/steipete/wacli/releases/latest/download/wacli_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/wacli

# Add more binaries below using the same pattern

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY scripts ./scripts

RUN corepack enable
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN pnpm ui:install
RUN pnpm ui:build

ENV NODE_ENV=production

CMD ["node","dist/index.js"]
```

---

## 11. Bauen und starten

```bash
docker compose build
docker compose up -d openclaw-gateway
```

Binärdateien überprüfen:

```bash
docker compose exec openclaw-gateway which gog
docker compose exec openclaw-gateway which goplaces
docker compose exec openclaw-gateway which wacli
```

Erwartete Ausgabe:

```
/usr/local/bin/gog
/usr/local/bin/goplaces
/usr/local/bin/wacli
```

---

## 12. Gateway verifizieren

```bash
docker compose logs -f openclaw-gateway
```

Erfolg:

```
[gateway] listening on ws://0.0.0.0:18789
```

---

## 13. Zugriff von Ihrem Laptop

Erstellen Sie einen SSH-Tunnel zur Weiterleitung des Gateway-Ports:

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a -- -L 18789:127.0.0.1:18789
```

Im Browser öffnen:

`http://127.0.0.1:18789/`

Fügen Sie Ihr Gateway-Token ein.

---

## Was wo persistiert (Single Source of Truth)

OpenClaw läuft in Docker, aber Docker ist nicht die Single Source of Truth.
Alle langlebigen Zustände müssen Neustarts, Neubauten und Reboots überleben.

| Komponente            | Speicherort                       | Persistenzmechanismus  | Hinweise                                 |
| --------------------- | --------------------------------- | ---------------------- | ---------------------------------------- |
| Gateway-Konfiguration | `/home/node/.openclaw/`           | Host-Volume-Mount      | Enthält `openclaw.json`, Tokens          |
| Modell-Auth-Profile   | `/home/node/.openclaw/`           | Host-Volume-Mount      | OAuth-Tokens, API-Schlüssel              |
| Skill-Konfigurationen | `/home/node/.openclaw/skills/`    | Host-Volume-Mount      | Skill-spezifischer Zustand               |
| Agent-Arbeitsbereich  | `/home/node/.openclaw/workspace/` | Host-Volume-Mount      | Code und Agent-Artefakte                 |
| WhatsApp-Sitzung      | `/home/node/.openclaw/`           | Host-Volume-Mount      | Erhält QR-Login                          |
| Gmail-Schlüsselbund   | `/home/node/.openclaw/`           | Host-Volume + Passwort | Erfordert `GOG_KEYRING_PASSWORD`         |
| Externe Binärdateien  | `/usr/local/bin/`                 | Docker-Image           | Müssen zur Build-Zeit eingebettet werden |
| Node-Laufzeit         | Container-Dateisystem             | Docker-Image           | Bei jedem Image-Build neu erstellt       |
| OS-Pakete             | Container-Dateisystem             | Docker-Image           | Nicht zur Laufzeit installieren          |
| Docker-Container      | Ephemer                           | Neustartbar            | Kann gefahrlos gelöscht werden           |

---

## Updates

So aktualisieren Sie OpenClaw auf der VM:

```bash
cd ~/openclaw
git pull
docker compose build
docker compose up -d
```

---

## Fehlerbehebung

**SSH-Verbindung abgelehnt**

Die SSH-Schlüsselübertragung kann nach der VM-Erstellung 1–2 Minuten dauern. Warten Sie und versuchen Sie es erneut.

**OS-Login-Probleme**

Überprüfen Sie Ihr OS-Login-Profil:

```bash
gcloud compute os-login describe-profile
```

Stellen Sie sicher, dass Ihr Konto über die erforderlichen IAM-Berechtigungen verfügt (Compute OS Login oder Compute OS Admin Login).

**Nicht genügend Speicher (OOM)**

Wenn Sie e2-micro verwenden und OOMs auftreten, wechseln Sie zu e2-small oder e2-medium:

```bash
# Stop the VM first
gcloud compute instances stop openclaw-gateway --zone=us-central1-a

# Change machine type
gcloud compute instances set-machine-type openclaw-gateway \
  --zone=us-central1-a \
  --machine-type=e2-small

# Start the VM
gcloud compute instances start openclaw-gateway --zone=us-central1-a
```

---

## Service Accounts (Sicherheits-Best-Practice)

Für den persönlichen Gebrauch ist Ihr Standard-Benutzerkonto ausreichend.

Für Automatisierung oder CI/CD-Pipelines erstellen Sie einen dedizierten Service Account mit minimalen Berechtigungen:

1. Service Account erstellen:

   ```bash
   gcloud iam service-accounts create openclaw-deploy \
     --display-name="OpenClaw Deployment"
   ```

2. Rolle „Compute Instance Admin“ gewähren (oder eine engere benutzerdefinierte Rolle):

   ```bash
   gcloud projects add-iam-policy-binding my-openclaw-project \
     --member="serviceAccount:openclaw-deploy@my-openclaw-project.iam.gserviceaccount.com" \
     --role="roles/compute.instanceAdmin.v1"
   ```

Vermeiden Sie die Verwendung der Owner-Rolle für Automatisierung. Befolgen Sie das Prinzip der geringsten Rechte.

Siehe [https://cloud.google.com/iam/docs/understanding-roles](https://cloud.google.com/iam/docs/understanding-roles) für Details zu IAM-Rollen.

---

## Nächste Schritte

- Messaging-Kanäle einrichten: [Channels](/channels)
- Lokale Geräte als Nodes koppeln: [Nodes](/nodes)
- Das Gateway konfigurieren: [Gateway configuration](/gateway/configuration)
