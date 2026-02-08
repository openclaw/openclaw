---
summary: "Kør OpenClaw Gateway 24/7 på en billig Hetzner VPS (Docker) med vedvarende tilstand og indbyggede binære filer"
read_when:
  - Du vil have OpenClaw kørende 24/7 på en cloud-VPS (ikke din laptop)
  - Du vil have en produktionsklar, altid-aktiv Gateway på din egen VPS
  - Du vil have fuld kontrol over persistens, binære filer og genstartsadfærd
  - Du kører OpenClaw i Docker på Hetzner eller en tilsvarende udbyder
title: "Hetzner"
x-i18n:
  source_path: install/hetzner.md
  source_hash: 84d9f24f1a803aa1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:28Z
---

# OpenClaw på Hetzner (Docker, produktions-VPS-guide)

## Mål

Kør en vedvarende OpenClaw Gateway på en Hetzner VPS ved hjælp af Docker, med holdbar tilstand, indbyggede binære filer og sikker genstartsadfærd.

Hvis du vil have “OpenClaw 24/7 for ~$5”, er dette den enkleste pålidelige opsætning.
Hetzners priser ændrer sig; vælg den mindste Debian/Ubuntu VPS og skalér op, hvis du rammer OOMs.

## Hvad gør vi (enkelt forklaret)?

- Lejer en lille Linux-server (Hetzner VPS)
- Installerer Docker (isoleret app-runtime)
- Starter OpenClaw Gateway i Docker
- Bevarer `~/.openclaw` + `~/.openclaw/workspace` på værten (overlever genstarter/genopbygninger)
- Får adgang til Control UI fra din laptop via en SSH-tunnel

Gatewayen kan tilgås via:

- SSH-portforwarding fra din laptop
- Direkte port-eksponering, hvis du selv håndterer firewall og tokens

Denne guide forudsætter Ubuntu eller Debian på Hetzner.  
Hvis du bruger en anden Linux VPS, så tilpas pakkerne tilsvarende.
For det generiske Docker-flow, se [Docker](/install/docker).

---

## Hurtig vej (erfarne operatører)

1. Provisionér Hetzner VPS
2. Installer Docker
3. Klon OpenClaw-repositoriet
4. Opret vedvarende værtsmapper
5. Konfigurér `.env` og `docker-compose.yml`
6. Indbyg påkrævede binære filer i imaget
7. `docker compose up -d`
8. Verificér persistens og Gateway-adgang

---

## Hvad du skal bruge

- Hetzner VPS med root-adgang
- SSH-adgang fra din laptop
- Grundlæggende fortrolighed med SSH + copy/paste
- ~20 minutter
- Docker og Docker Compose
- Model-autentificeringsoplysninger
- Valgfrie udbyderoplysninger
  - WhatsApp QR
  - Telegram bot-token
  - Gmail OAuth

---

## 1) Provisionér VPS’en

Opret en Ubuntu- eller Debian-VPS hos Hetzner.

Forbind som root:

```bash
ssh root@YOUR_VPS_IP
```

Denne guide antager, at VPS’en er stateful.
Behandl den ikke som forbrugelig infrastruktur.

---

## 2) Installér Docker (på VPS’en)

```bash
apt-get update
apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sh
```

Verificér:

```bash
docker --version
docker compose version
```

---

## 3) Klon OpenClaw-repositoriet

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

Denne guide antager, at du vil bygge et tilpasset image for at garantere persistens af binære filer.

---

## 4) Opret vedvarende værtsmapper

Docker-containere er flygtige.
Al langtidsholdbar tilstand skal ligge på værten.

```bash
mkdir -p /root/.openclaw
mkdir -p /root/.openclaw/workspace

# Set ownership to the container user (uid 1000):
chown -R 1000:1000 /root/.openclaw
chown -R 1000:1000 /root/.openclaw/workspace
```

---

## 5) Konfigurér miljøvariabler

Opret `.env` i roden af repositoriet.

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

Generér stærke hemmeligheder:

```bash
openssl rand -hex 32
```

**Commit ikke denne fil.**

---

## 6) Docker Compose-konfiguration

Opret eller opdatér `docker-compose.yml`.

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

## 7) Indbyg påkrævede binære filer i imaget (kritisk)

At installere binære filer inde i en kørende container er en fælde.
Alt, hvad der installeres ved runtime, går tabt ved genstart.

Alle eksterne binære filer, som Skills kræver, skal installeres ved image-build.

Eksemplerne nedenfor viser kun tre almindelige binære filer:

- `gog` til Gmail-adgang
- `goplaces` til Google Places
- `wacli` til WhatsApp

Dette er eksempler, ikke en komplet liste.
Du kan installere så mange binære filer som nødvendigt ved at bruge samme mønster.

Hvis du senere tilføjer nye Skills, der afhænger af yderligere binære filer, skal du:

1. Opdatere Dockerfile
2. Genbygge imaget
3. Genstarte containerne

**Eksempel Dockerfile**

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

## 8) Byg og start

```bash
docker compose build
docker compose up -d openclaw-gateway
```

Verificér binære filer:

```bash
docker compose exec openclaw-gateway which gog
docker compose exec openclaw-gateway which goplaces
docker compose exec openclaw-gateway which wacli
```

Forventet output:

```
/usr/local/bin/gog
/usr/local/bin/goplaces
/usr/local/bin/wacli
```

---

## 9) Verificér Gateway

```bash
docker compose logs -f openclaw-gateway
```

Succes:

```
[gateway] listening on ws://0.0.0.0:18789
```

Fra din laptop:

```bash
ssh -N -L 18789:127.0.0.1:18789 root@YOUR_VPS_IP
```

Åbn:

`http://127.0.0.1:18789/`

Indsæt dit gateway-token.

---

## Hvad persisterer hvor (sandhedskilde)

OpenClaw kører i Docker, men Docker er ikke sandhedskilden.
Al langtidsholdbar tilstand skal overleve genstarter, genopbygninger og reboots.

| Komponent                      | Placering                         | Persistensmekanisme        | Noter                              |
| ------------------------------ | --------------------------------- | -------------------------- | ---------------------------------- |
| Gateway-konfiguration          | `/home/node/.openclaw/`           | Værts-volume mount         | Inkluderer `openclaw.json`, tokens |
| Model-autentificeringsprofiler | `/home/node/.openclaw/`           | Værts-volume mount         | OAuth-tokens, API-nøgler           |
| Skill-konfigurationer          | `/home/node/.openclaw/skills/`    | Værts-volume mount         | Tilstand på Skill-niveau           |
| Agent-arbejdsområde            | `/home/node/.openclaw/workspace/` | Værts-volume mount         | Kode og agent-artefakter           |
| WhatsApp-session               | `/home/node/.openclaw/`           | Værts-volume mount         | Bevarer QR-login                   |
| Gmail-nøglering                | `/home/node/.openclaw/`           | Værts-volume + adgangskode | Kræver `GOG_KEYRING_PASSWORD`      |
| Eksterne binære filer          | `/usr/local/bin/`                 | Docker-image               | Skal indbygges ved build-tid       |
| Node-runtime                   | Container-filsystem               | Docker-image               | Genopbygges ved hvert image-build  |
| OS-pakker                      | Container-filsystem               | Docker-image               | Installer ikke ved runtime         |
| Docker-container               | Flygtig                           | Genstartbar                | Sikker at slette                   |
