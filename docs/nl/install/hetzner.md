---
summary: "Draai OpenClaw Gateway 24/7 op een goedkope Hetzner VPS (Docker) met duurzame status en ingebakken binaries"
read_when:
  - Je wilt OpenClaw 24/7 draaien op een cloud-VPS (niet op je laptop)
  - Je wilt een productieklare, altijd actieve Gateway op je eigen VPS
  - Je wilt volledige controle over persistentie, binaries en herstartgedrag
  - Je draait OpenClaw in Docker op Hetzner of een vergelijkbare provider
title: "Hetzner"
---

# OpenClaw op Hetzner (Docker, productie-VPS-handleiding)

## Doel

Draai een persistente OpenClaw Gateway op een Hetzner VPS met Docker, met duurzame status, ingebakken binaries en veilig herstartgedrag.

Als je “OpenClaw 24/7 voor ~$5” wilt, is dit de eenvoudigste betrouwbare setup.
De prijzen van Hetzner veranderen; kies de kleinste Debian/Ubuntu VPS en schaal op als je OOM’s tegenkomt.

## Wat doen we (in eenvoudige bewoordingen)?

- Huur een kleine Linux-server (Hetzner VPS)
- Installeer Docker (geïsoleerde app-runtime)
- Start de OpenClaw Gateway in Docker
- Persisteer `~/.openclaw` + `~/.openclaw/workspace` op de host (overleeft herstarts/herbuilds)
- Benader de Control UI vanaf je laptop via een SSH-tunnel

De Gateway kan worden benaderd via:

- SSH-port forwarding vanaf je laptop
- Directe poortblootstelling als je zelf firewalling en tokens beheert

Deze handleiding gaat uit van Ubuntu of Debian op Hetzner.  
Als je op een andere Linux-VPS zit, pas de pakketten dienovereenkomstig aan.
Voor de generieke Docker-flow, zie [Docker](/install/docker).

---

## Snelle route (ervaren operators)

1. Provisioneer een Hetzner VPS
2. Installeer Docker
3. Clone de OpenClaw-repository
4. Maak persistente hostmappen aan
5. Configureer `.env` en `docker-compose.yml`
6. Bak vereiste binaries in de image
7. `docker compose up -d`
8. Verifieer persistentie en Gateway-toegang

---

## Wat je nodig hebt

- Hetzner VPS met root-toegang
- SSH-toegang vanaf je laptop
- Basisvaardigheid met SSH + copy/paste
- ~20 minuten
- Docker en Docker Compose
- Model-authenticatiegegevens
- Optionele provider-credentials
  - WhatsApp QR
  - Telegram bot-token
  - Gmail OAuth

---

## 1. Provisioneer de VPS

Maak een Ubuntu- of Debian-VPS aan bij Hetzner.

Verbind als root:

```bash
ssh root@YOUR_VPS_IP
```

Deze handleiding gaat ervan uit dat de VPS stateful is.
Behandel deze niet als wegwerpinfrastructuur.

---

## 2. Installeer Docker (op de VPS)

```bash
apt-get update
apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sh
```

Verifiëren:

```bash
docker --version
docker compose version
```

---

## 3. Clone de OpenClaw-repository

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

Deze handleiding gaat ervan uit dat je een aangepaste image bouwt om binaire persistentie te garanderen.

---

## 4. Maak persistente hostmappen aan

Docker-containers zijn efemeer.
Alle langlevende status moet op de host staan.

```bash
mkdir -p /root/.openclaw
mkdir -p /root/.openclaw/workspace

# Set ownership to the container user (uid 1000):
chown -R 1000:1000 /root/.openclaw
chown -R 1000:1000 /root/.openclaw/workspace
```

---

## 5. Configureer omgevingsvariabelen

Maak `.env` aan in de root van de repository.

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

Genereer sterke geheimen:

```bash
openssl rand -hex 32
```

**Commit dit bestand niet.**

---

## 6. Docker Compose-configuratie

Maak of werk `docker-compose.yml` bij.

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

## 7. Bak vereiste binaries in de image (kritisch)

Het installeren van binaries in een draaiende container is een valkuil.
Alles wat tijdens runtime wordt geïnstalleerd, gaat verloren bij een herstart.

Alle externe binaries die door Skills vereist zijn, moeten tijdens het bouwen van de image worden geïnstalleerd.

De onderstaande voorbeelden tonen slechts drie veelvoorkomende binaries:

- `gog` voor Gmail-toegang
- `goplaces` voor Google Places
- `wacli` voor WhatsApp

Dit zijn voorbeelden, geen volledige lijst.
Je kunt zoveel binaries installeren als nodig met hetzelfde patroon.

Als je later nieuwe Skills toevoegt die afhankelijk zijn van extra binaries, moet je:

1. De Dockerfile bijwerken
2. De image opnieuw bouwen
3. De containers herstarten

**Voorbeeld Dockerfile**

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

## 8. Bouwen en starten

```bash
docker compose build
docker compose up -d openclaw-gateway
```

Verifieer binaries:

```bash
docker compose exec openclaw-gateway which gog
docker compose exec openclaw-gateway which goplaces
docker compose exec openclaw-gateway which wacli
```

Verwachte uitvoer:

```
/usr/local/bin/gog
/usr/local/bin/goplaces
/usr/local/bin/wacli
```

---

## 9. Verifieer de Gateway

```bash
docker compose logs -f openclaw-gateway
```

Succes:

```
[gateway] listening on ws://0.0.0.0:18789
```

Vanaf je laptop:

```bash
ssh -N -L 18789:127.0.0.1:18789 root@YOUR_VPS_IP
```

Open:

`http://127.0.0.1:18789/`

Plak je gateway-token.

---

## Wat persisteert waar (bron van waarheid)

OpenClaw draait in Docker, maar Docker is niet de bron van waarheid.
Alle langlevende status moet herstarts, herbuilds en reboots overleven.

| Component           | Locatie                           | Persistentiemechanisme   | Notities                               |
| ------------------- | --------------------------------- | ------------------------ | -------------------------------------- |
| Gateway-config      | `/home/node/.openclaw/`           | Host-volume mount        | Inclusief `openclaw.json`, tokens      |
| Model-authprofielen | `/home/node/.openclaw/`           | Host-volume mount        | OAuth-tokens, API-sleutels             |
| Skill-configs       | `/home/node/.openclaw/skills/`    | Host-volume mount        | Status op skill-niveau                 |
| Agent-werkruimte    | `/home/node/.openclaw/workspace/` | Host-volume mount        | Code en agent-artefacten               |
| WhatsApp-sessie     | `/home/node/.openclaw/`           | Host-volume mount        | Behoudt QR-login                       |
| Gmail-sleutelbos    | `/home/node/.openclaw/`           | Host-volume + wachtwoord | Vereist `GOG_KEYRING_PASSWORD`         |
| Externe binaries    | `/usr/local/bin/`                 | Docker-image             | Moeten tijdens build worden ingebakken |
| Node-runtime        | Containerbestandssysteem          | Docker-image             | Opnieuw opgebouwd bij elke image-build |
| OS-pakketten        | Containerbestandssysteem          | Docker-image             | Niet tijdens runtime installeren       |
| Docker-container    | Efemeer                           | Herstartbaar             | Veilig om te vernietigen               |
