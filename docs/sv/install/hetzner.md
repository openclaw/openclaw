---
summary: "Kör OpenClaw Gateway dygnet runt på en billig Hetzner VPS (Docker) med beständig state och inbakade binärer"
read_when:
  - Du vill köra OpenClaw dygnet runt på en moln-VPS (inte din laptop)
  - Du vill ha en produktionsklassad, alltid-på Gateway på din egen VPS
  - Du vill ha full kontroll över persistens, binärer och omstartsbeteende
  - Du kör OpenClaw i Docker på Hetzner eller en liknande leverantör
title: "Hetzner"
---

# OpenClaw på Hetzner (Docker, produktionsguide för VPS)

## Mål

Kör en beständig OpenClaw Gateway på en Hetzner VPS med Docker, med hållbar state, inbakade binärer och säkert omstartsbeteende.

Om du vill ha “OpenClaw 24/7 för ~$5”, är detta den enklaste tillförlitliga inställningen.
Hetzner ändrar pris; välj de minsta Debian/Ubuntu VPS och skala upp om du träffar OOMs.

## Vad gör vi (enkelt förklarat)?

- Hyr en liten Linux‑server (Hetzner VPS)
- Installera Docker (isolerad app‑runtime)
- Starta OpenClaw Gateway i Docker
- Persist `~/.openclaw` + `~/.openclaw/workspace` på värden (överlever omstarter/ombyggen)
- Få åtkomst till Control UI från din laptop via en SSH‑tunnel

Gateway kan nås via:

- SSH‑portvidarebefordran från din laptop
- Direkt portexponering om du själv hanterar brandvägg och tokens

Denna guide förutsätter Ubuntu eller Debian på Hetzner.  
Om du är på en annan Linux VPS, kartpaket i enlighet därmed.
För generiska Docker-flödet, se [Docker](/install/docker).

---

## Snabb väg (erfarna operatörer)

1. Provisionera Hetzner VPS
2. Installera Docker
3. Klona OpenClaw‑repo
4. Skapa beständiga kataloger på värden
5. Konfigurera `.env` och `docker-compose.yml`
6. Baka in nödvändiga binärer i imagen
7. `docker compose up -d`
8. Verifiera persistens och Gateway‑åtkomst

---

## Vad du behöver

- Hetzner VPS med root‑åtkomst
- SSH‑åtkomst från din laptop
- Grundläggande vana vid SSH + kopiera/klistra in
- ~20 minuter
- Docker och Docker Compose
- Autentiseringsuppgifter för modeller
- Valfria leverantörsuppgifter
  - WhatsApp‑QR
  - Telegram‑bottoken
  - Gmail OAuth

---

## 1. Provisionera VPS:en

Skapa en Ubuntu‑ eller Debian‑VPS i Hetzner.

Anslut som root:

```bash
ssh root@YOUR_VPS_IP
```

Denna guide antar att VPS är stateful.
Behandla det inte som engångsinfrastruktur.

---

## 2. Installera Docker (på VPS:en)

```bash
apt-get update
apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sh
```

Verifiera:

```bash
docker --version
docker compose version
```

---

## 3. Klona OpenClaw‑repo:t

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

Den här guiden förutsätter att du bygger en anpassad image för att garantera binär persistens.

---

## 4. Skapa beständiga kataloger på värden

Docker behållare är efhemeral.
Alla långlivade stater måste leva på värden.

```bash
mkdir -p /root/.openclaw
mkdir -p /root/.openclaw/workspace

# Set ownership to the container user (uid 1000):
chown -R 1000:1000 /root/.openclaw
chown -R 1000:1000 /root/.openclaw/workspace
```

---

## 5. Konfigurera miljövariabler

Skapa `.env` i repo‑roten.

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

Generera starka hemligheter:

```bash
openssl rand -hex 32
```

**Committa inte den här filen.**

---

## 6. Docker Compose‑konfiguration

Skapa eller uppdatera `docker-compose.yml`.

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

## 7. Baka in nödvändiga binärer i imagen (kritiskt)

Installera binärer i en fungerande behållare är en fälla.
Allt som är installerat vid körtiden kommer att gå förlorat vid omstart.

Alla externa binärer som krävs av skills måste installeras vid image‑build‑tid.

Exemplen nedan visar endast tre vanliga binärer:

- `gog` för Gmail‑åtkomst
- `goplaces` för Google Places
- `wacli` för WhatsApp

Detta är exempel, inte en fullständig lista.
Du kan installera så många binärer som behövs med samma mönster.

Om du senare lägger till nya skills som beror på ytterligare binärer måste du:

1. Uppdatera Dockerfile
2. Bygga om imagen
3. Starta om containrarna

**Exempel på Dockerfile**

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

## 8. Bygg och starta

```bash
docker compose build
docker compose up -d openclaw-gateway
```

Verifiera binärer:

```bash
docker compose exec openclaw-gateway which gog
docker compose exec openclaw-gateway which goplaces
docker compose exec openclaw-gateway which wacli
```

Förväntad utdata:

```
/usr/local/bin/gog
/usr/local/bin/goplaces
/usr/local/bin/wacli
```

---

## 9. Verifiera Gateway

```bash
docker compose logs -f openclaw-gateway
```

Lyckat:

```
[gateway] listening on ws://0.0.0.0:18789
```

Från din laptop:

```bash
ssh -N -L 18789:127.0.0.1:18789 root@YOUR_VPS_IP
```

Öppna:

`http://127.0.0.1:18789/`

Klistra in din gateway‑token.

---

## Vad persisterar var (källan till sanning)

OpenClaw körs i Docker, men Docker är inte sanningens källa.
Alla långlivade tillstånd måste överleva omstarter, återuppbygga och starta om.

| Komponent                           | Plats                             | Persistensmekanism   | Noteringar                         |
| ----------------------------------- | --------------------------------- | -------------------- | ---------------------------------- |
| Gateway‑konfig                      | `/home/node/.openclaw/`           | Värdvolym‑montering  | Inkluderar `openclaw.json`, tokens |
| Autentiseringsprofiler för modeller | `/home/node/.openclaw/`           | Värdvolym‑montering  | OAuth‑tokens, API‑nycklar          |
| Skill‑konfig                        | `/home/node/.openclaw/skills/`    | Värdvolym‑montering  | State på skill‑nivå                |
| Agent‑arbetsyta                     | `/home/node/.openclaw/workspace/` | Värdvolym‑montering  | Kod och agent‑artefakter           |
| WhatsApp‑session                    | `/home/node/.openclaw/`           | Värdvolym‑montering  | Bevarar QR‑inloggning              |
| Gmail‑nyckelring                    | `/home/node/.openclaw/`           | Värdvolym + lösenord | Kräver `GOG_KEYRING_PASSWORD`      |
| Externa binärer                     | `/usr/local/bin/`                 | Docker‑image         | Måste bakas in vid build‑tid       |
| Node‑runtime                        | Containerfilsystem                | Docker‑image         | Byggs om vid varje image‑build     |
| OS‑paket                            | Containerfilsystem                | Docker‑image         | Installera inte vid runtime        |
| Docker‑container                    | Flyktig                           | Omstartbar           | Säker att förstöra                 |
