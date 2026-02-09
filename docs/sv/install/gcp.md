---
summary: "Kör OpenClaw Gateway dygnet runt på en GCP Compute Engine-VM (Docker) med beständig tillståndshantering"
read_when:
  - Du vill köra OpenClaw dygnet runt på GCP
  - Du vill ha en produktionsklassad, alltid påslagen Gateway på din egen VM
  - Du vill ha full kontroll över persistens, binärer och omstartsbeteende
title: "GCP"
---

# OpenClaw på GCP Compute Engine (Docker, produktionsguide för VPS)

## Mål

Kör en beständig OpenClaw Gateway på en GCP Compute Engine-VM med Docker, med hållbart tillstånd, inbakade binärer och säkert omstartsbeteende.

Om du vill ha "OpenClaw 24/7 för ~$5-12/mo", är detta en tillförlitlig inställning på Google Cloud.
Prissättningen varierar beroende på maskintyp och region; välj den minsta virtuella maskinen som passar din arbetsbelastning och skala upp om du träffar OOMs.

## Vad gör vi (enkelt uttryckt)?

- Skapa ett GCP-projekt och aktivera fakturering
- Skapa en Compute Engine-VM
- Installera Docker (isolerad app-runtime)
- Starta OpenClaw Gateway i Docker
- Persist `~/.openclaw` + `~/.openclaw/workspace` på värden (överlever omstarter/ombyggnader)
- Få åtkomst till Control UI från din laptop via en SSH-tunnel

Gatewayn kan nås via:

- SSH-portvidarebefordran från din laptop
- Direkt portexponering om du själv hanterar brandvägg och tokens

Denna guide använder Debian på GCP Compute Engine.
Ubuntu fungerar också; kartpaket därefter.
För generiska Docker-flödet, se [Docker](/install/docker).

---

## Snabb väg (erfarna operatörer)

1. Skapa GCP-projekt + aktivera Compute Engine API
2. Skapa Compute Engine-VM (e2-small, Debian 12, 20GB)
3. SSH in i VM:n
4. Installera Docker
5. Klona OpenClaw-repositoriet
6. Skapa beständiga värdkataloger
7. Konfigurera `.env` och `docker-compose.yml`
8. Baka in nödvändiga binärer, bygg och starta

---

## Vad du behöver

- GCP-konto (free tier-berättigad för e2-micro)
- gcloud CLI installerad (eller använd Cloud Console)
- SSH-åtkomst från din laptop
- Grundläggande vana vid SSH + copy/paste
- ~20–30 minuter
- Docker och Docker Compose
- Autentiseringsuppgifter för modeller
- Valfria leverantörsuppgifter
  - WhatsApp QR
  - Telegram-bottoken
  - Gmail OAuth

---

## 1. Installera gcloud CLI (eller använd Console)

**Alternativ A: gcloud CLI** (rekommenderas för automatisering)

Installera från [https://cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install)

Initiera och autentisera:

```bash
gcloud init
gcloud auth login
```

**Alternativ B: Cloud Console**

Alla steg kan göras via webbgränssnittet på [https://console.cloud.google.com](https://console.cloud.google.com)

---

## 2. Skapa ett GCP-projekt

**CLI:**

```bash
gcloud projects create my-openclaw-project --name="OpenClaw Gateway"
gcloud config set project my-openclaw-project
```

Aktivera fakturering på [https://console.cloud.google.com/billing](https://console.cloud.google.com/billing) (krävs för Compute Engine).

Aktivera Compute Engine API:

```bash
gcloud services enable compute.googleapis.com
```

**Console:**

1. Gå till IAM & Admin > Create Project
2. Namnge det och skapa
3. Aktivera fakturering för projektet
4. Navigera till APIs & Services > Enable APIs > sök ”Compute Engine API” > Enable

---

## 3. Skapa VM:n

**Maskintyper:**

| Typ      | Specifikationer                            | Kostnad                  | Noteringar          |
| -------- | ------------------------------------------ | ------------------------ | ------------------- |
| e2-small | 2 vCPU, 2GB RAM                            | ~$12/mån | Rekommenderad       |
| e2-micro | 2 vCPU (delad), 1GB RAM | Free tier-berättigad     | Kan få OOM vid last |

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

1. Gå till Compute Engine > VM instances > Create instance
2. Namn: `openclaw-gateway`
3. Region: `us-central1`, Zon: `us-central1-a`
4. Maskintyp: `e2-small`
5. Startdisk: Debian 12, 20GB
6. Skapa

---

## 4. SSH in i VM:n

**CLI:**

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

**Console:**

Klicka på ”SSH”-knappen bredvid din VM i Compute Engine-instrumentpanelen.

Obs: SSH-nyckelförökning kan ta 1-2 minuter efter skapande av virtuella datorer. Om anslutningen avslås, vänta och försök igen.

---

## 5. Installera Docker (på VM:n)

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

Logga ut och in igen för att gruppändringen ska träda i kraft:

```bash
exit
```

SSH:a sedan in igen:

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

Verifiera:

```bash
docker --version
docker compose version
```

---

## 6. Klona OpenClaw-repositoriet

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

Den här guiden förutsätter att du bygger en anpassad image för att garantera binär persistens.

---

## 7. Skapa beständiga värdkataloger

Docker behållare är efhemeral.
Alla långlivade stater måste leva på värden.

```bash
mkdir -p ~/.openclaw
mkdir -p ~/.openclaw/workspace
```

---

## 8. Konfigurera miljövariabler

Skapa `.env` i repositoriets rot.

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

Generera starka hemligheter:

```bash
openssl rand -hex 32
```

**Committa inte denna fil.**

---

## 9. Docker Compose-konfiguration

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

## 10. Baka in nödvändiga binärer i imagen (kritiskt)

Installera binärer i en fungerande behållare är en fälla.
Allt som är installerat vid körtiden kommer att gå förlorat vid omstart.

Alla externa binärer som krävs av Skills måste installeras vid image-build-tid.

Exemplen nedan visar endast tre vanliga binärer:

- `gog` för Gmail-åtkomst
- `goplaces` för Google Places
- `wacli` för WhatsApp

Detta är exempel, inte en fullständig lista.
Du kan installera så många binärer som behövs med samma mönster.

Om du senare lägger till nya Skills som beror på ytterligare binärer måste du:

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

## 11. Bygg och starta

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

## 12. Verifiera Gateway

```bash
docker compose logs -f openclaw-gateway
```

Lyckat resultat:

```
[gateway] listening on ws://0.0.0.0:18789
```

---

## 13. Åtkomst från din laptop

Skapa en SSH-tunnel för att vidarebefordra Gateway-porten:

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a -- -L 18789:127.0.0.1:18789
```

Öppna i din webbläsare:

`http://127.0.0.1:18789/`

Klistra in din gateway-token.

---

## Vad persisterar var (sanningskälla)

OpenClaw körs i Docker, men Docker är inte sanningens källa.
Alla långlivade tillstånd måste överleva omstarter, återuppbygga och starta om.

| Komponent                    | Plats                             | Persistensmekanism   | Noteringar                         |
| ---------------------------- | --------------------------------- | -------------------- | ---------------------------------- |
| Gateway-konfig               | `/home/node/.openclaw/`           | Värdvolym-mount      | Inkluderar `openclaw.json`, tokens |
| Modellautentiseringsprofiler | `/home/node/.openclaw/`           | Värdvolym-mount      | OAuth-tokens, API-nycklar          |
| Skill-konfig                 | `/home/node/.openclaw/skills/`    | Värdvolym-mount      | Status på Skill-nivå               |
| Agent-arbetsyta              | `/home/node/.openclaw/workspace/` | Värdvolym-mount      | Kod och agentartefakter            |
| WhatsApp-session             | `/home/node/.openclaw/`           | Värdvolym-mount      | Bevarar QR-inloggning              |
| Gmail-nyckelring             | `/home/node/.openclaw/`           | Värdvolym + lösenord | Kräver `GOG_KEYRING_PASSWORD`      |
| Externa binärer              | `/usr/local/bin/`                 | Docker-image         | Måste bakas in vid build-tid       |
| Node-runtime                 | Containerfilsystem                | Docker-image         | Byggs om vid varje image-build     |
| OS-paket                     | Containerfilsystem                | Docker-image         | Installera inte vid runtime        |
| Docker-container             | Flyktig                           | Omstartbar           | Säker att förstöra                 |

---

## Uppdateringar

För att uppdatera OpenClaw på VM:n:

```bash
cd ~/openclaw
git pull
docker compose build
docker compose up -d
```

---

## Felsökning

**SSH-anslutning nekas**

SSH-nyckelförökning kan ta 1-2 minuter efter skapande av virtuella datorer. Vänta och försök igen.

**OS Login-problem**

Kontrollera din OS Login-profil:

```bash
gcloud compute os-login describe-profile
```

Se till att ditt konto har nödvändiga IAM-behörigheter (Compute OS Login eller Compute OS Admin Login).

**Slut på minne (OOM)**

Om du använder e2-micro och får OOM, uppgradera till e2-small eller e2-medium:

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

## Tjänstekonton (säkerhetsrekommendation)

För personligt bruk fungerar ditt standardanvändarkonto bra.

För automatisering eller CI/CD-pipelines, skapa ett dedikerat tjänstekonto med minsta möjliga behörigheter:

1. Skapa ett tjänstekonto:

   ```bash
   gcloud iam service-accounts create openclaw-deploy \
     --display-name="OpenClaw Deployment"
   ```

2. Tilldela rollen Compute Instance Admin (eller en snävare anpassad roll):

   ```bash
   gcloud projects add-iam-policy-binding my-openclaw-project \
     --member="serviceAccount:openclaw-deploy@my-openclaw-project.iam.gserviceaccount.com" \
     --role="roles/compute.instanceAdmin.v1"
   ```

Undvik att använda ägarrollen för automatisering. Använd principen om minst privilegium.

Se [https://cloud.google.com/iam/docs/understanding-roles](https://cloud.google.com/iam/docs/understanding-roles) för detaljer om IAM-roller.

---

## Nästa steg

- Sätt upp meddelandekanaler: [Channels](/channels)
- Para lokala enheter som noder: [Nodes](/nodes)
- Konfigurera Gateway: [Gateway configuration](/gateway/configuration)
