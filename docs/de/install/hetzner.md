---
summary: „Betreiben Sie OpenClaw Gateway rund um die Uhr auf einem günstigen Hetzner‑VPS (Docker) mit dauerhaftem Zustand und fest integrierten Binaries“
read_when:
  - Sie möchten OpenClaw rund um die Uhr auf einem Cloud‑VPS (nicht auf Ihrem Laptop) betreiben
  - Sie möchten ein produktionsreifes, dauerhaft aktives Gateway auf Ihrem eigenen VPS
  - Sie möchten volle Kontrolle über Persistenz, Binaries und Neustartverhalten
  - Sie betreiben OpenClaw in Docker auf Hetzner oder einem ähnlichen Anbieter
title: „Hetzner“
x-i18n:
  source_path: install/hetzner.md
  source_hash: 84d9f24f1a803aa1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:36:43Z
---

# OpenClaw auf Hetzner (Docker, Produktions‑VPS‑Leitfaden)

## Ziel

Ein persistentes OpenClaw Gateway auf einem Hetzner‑VPS mit Docker betreiben – mit dauerhaftem Zustand, fest integrierten Binaries und sicherem Neustartverhalten.

Wenn Sie „OpenClaw 24/7 für ~5 $“ möchten, ist dies das einfachste zuverlässige Setup.
Die Preise bei Hetzner ändern sich; wählen Sie den kleinsten Debian/Ubuntu‑VPS und skalieren Sie hoch, falls OOMs auftreten.

## Was machen wir (in einfachen Worten)?

- Einen kleinen Linux‑Server mieten (Hetzner‑VPS)
- Docker installieren (isolierte App‑Laufzeit)
- Das OpenClaw Gateway in Docker starten
- `~/.openclaw` + `~/.openclaw/workspace` auf dem Host persistieren (übersteht Neustarts/Rebuilds)
- Über einen SSH‑Tunnel von Ihrem Laptop auf die Control UI zugreifen

Auf das Gateway kann zugegriffen werden über:

- SSH‑Port‑Weiterleitung von Ihrem Laptop
- Direkte Port‑Freigabe, wenn Sie Firewalling und Tokens selbst verwalten

Dieser Leitfaden geht von Ubuntu oder Debian auf Hetzner aus.  
Wenn Sie einen anderen Linux‑VPS verwenden, ordnen Sie die Pakete entsprechend zu.
Für den generischen Docker‑Ablauf siehe [Docker](/install/docker).

---

## Schneller Weg (erfahrene Betreiber)

1. Hetzner‑VPS bereitstellen
2. Docker installieren
3. OpenClaw‑Repository klonen
4. Persistente Host‑Verzeichnisse erstellen
5. `.env` und `docker-compose.yml` konfigurieren
6. Erforderliche Binaries in das Image einbacken
7. `docker compose up -d`
8. Persistenz und Gateway‑Zugriff verifizieren

---

## Was Sie benötigen

- Hetzner‑VPS mit Root‑Zugriff
- SSH‑Zugriff von Ihrem Laptop
- Grundlegende Vertrautheit mit SSH + Copy/Paste
- ~20 Minuten
- Docker und Docker Compose
- Modell‑Authentifizierungsdaten
- Optionale Anbieter‑Zugangsdaten
  - WhatsApp‑QR
  - Telegram‑Bot‑Token
  - Gmail‑OAuth

---

## 1) VPS bereitstellen

Erstellen Sie einen Ubuntu‑ oder Debian‑VPS bei Hetzner.

Als Root verbinden:

```bash
ssh root@YOUR_VPS_IP
```

Dieser Leitfaden geht davon aus, dass der VPS zustandsbehaftet ist.
Behandeln Sie ihn nicht als wegwerfbare Infrastruktur.

---

## 2) Docker installieren (auf dem VPS)

```bash
apt-get update
apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sh
```

Verifizieren:

```bash
docker --version
docker compose version
```

---

## 3) OpenClaw‑Repository klonen

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

Dieser Leitfaden geht davon aus, dass Sie ein benutzerdefiniertes Image bauen, um die Persistenz der Binaries zu gewährleisten.

---

## 4) Persistente Host‑Verzeichnisse erstellen

Docker‑Container sind ephemer.
Jeglicher langlebige Zustand muss auf dem Host liegen.

```bash
mkdir -p /root/.openclaw
mkdir -p /root/.openclaw/workspace

# Set ownership to the container user (uid 1000):
chown -R 1000:1000 /root/.openclaw
chown -R 1000:1000 /root/.openclaw/workspace
```

---

## 5) Umgebungsvariablen konfigurieren

Erstellen Sie `.env` im Repository‑Root.

```bash
OPENCLAW_IMAGE=openclaw:latest
OPENCLAW_GATEWAY_TOKEN=change-me-now
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_PORT=18789

OPENCLAW_CONFIG_DIR=/root/.openclaw
OPENCLAW_WORKSPACE_DIR=/root/.openclaw/workspace

GOG_KEYRING_PASSWORD=change-me-now
XDG_CONFIG_HOME=/home/node/.openclaw
```

Starke Geheimnisse erzeugen:

```bash
openssl rand -hex 32
```

**Committen Sie diese Datei nicht.**

---

## 6) Docker‑Compose‑Konfiguration

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
      # Recommended: keep the Gateway loopback-only on the VPS; access via SSH tunnel.
      # To expose it publicly, remove the `127.0.0.1:` prefix and firewall accordingly.
      - "127.0.0.1:${OPENCLAW_GATEWAY_PORT}:18789"

      # Optional: only if you run iOS/Android nodes against this VPS and need Canvas host.
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

## 7) Erforderliche Binaries in das Image einbacken (kritisch)

Binaries in einem laufenden Container zu installieren, ist eine Falle.
Alles, was zur Laufzeit installiert wird, geht beim Neustart verloren.

Alle externen Binaries, die von Skills benötigt werden, müssen zur Build‑Zeit des Images installiert werden.

Die folgenden Beispiele zeigen nur drei gängige Binaries:

- `gog` für Gmail‑Zugriff
- `goplaces` für Google Places
- `wacli` für WhatsApp

Dies sind Beispiele, keine vollständige Liste.
Sie können beliebig viele Binaries nach demselben Muster installieren.

Wenn Sie später neue Skills hinzufügen, die zusätzliche Binaries benötigen, müssen Sie:

1. Das Dockerfile aktualisieren
2. Das Image neu bauen
3. Die Container neu starten

**Beispiel‑Dockerfile**

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

## 8) Build und Start

```bash
docker compose build
docker compose up -d openclaw-gateway
```

Binaries verifizieren:

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

## 9) Gateway verifizieren

```bash
docker compose logs -f openclaw-gateway
```

Erfolg:

```
[gateway] listening on ws://0.0.0.0:18789
```

Von Ihrem Laptop aus:

```bash
ssh -N -L 18789:127.0.0.1:18789 root@YOUR_VPS_IP
```

Öffnen:

`http://127.0.0.1:18789/`

Fügen Sie Ihr Gateway‑Token ein.

---

## Was wo persistiert (Single Source of Truth)

OpenClaw läuft in Docker, aber Docker ist nicht die Single Source of Truth.
Jeglicher langlebige Zustand muss Neustarts, Rebuilds und Reboots überstehen.

| Komponente             | Speicherort                       | Persistenzmechanismus  | Hinweise                                 |
| ---------------------- | --------------------------------- | ---------------------- | ---------------------------------------- |
| Gateway‑Konfiguration  | `/home/node/.openclaw/`           | Host‑Volume‑Mount      | Enthält `openclaw.json`, Tokens          |
| Modell‑Auth‑Profile    | `/home/node/.openclaw/`           | Host‑Volume‑Mount      | OAuth‑Tokens, API‑Schlüssel              |
| Skills‑Konfigurationen | `/home/node/.openclaw/skills/`    | Host‑Volume‑Mount      | Zustand auf Skill‑Ebene                  |
| Agent‑Arbeitsbereich   | `/home/node/.openclaw/workspace/` | Host‑Volume‑Mount      | Code und Agent‑Artefakte                 |
| WhatsApp‑Sitzung       | `/home/node/.openclaw/`           | Host‑Volume‑Mount      | Bewahrt QR‑Login                         |
| Gmail‑Keyring          | `/home/node/.openclaw/`           | Host‑Volume + Passwort | Erfordert `GOG_KEYRING_PASSWORD`         |
| Externe Binaries       | `/usr/local/bin/`                 | Docker‑Image           | Müssen zur Build‑Zeit eingebacken werden |
| Node‑Runtime           | Container‑Dateisystem             | Docker‑Image           | Bei jedem Image‑Build neu gebaut         |
| OS‑Pakete              | Container‑Dateisystem             | Docker‑Image           | Nicht zur Laufzeit installieren          |
| Docker‑Container       | Ephemer                           | Neustartbar            | Sicher zu zerstören                      |
