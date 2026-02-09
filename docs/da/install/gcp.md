---
summary: "Kør OpenClaw Gateway 24/7 på en GCP Compute Engine VM (Docker) med vedvarende tilstand"
read_when:
  - Du vil have OpenClaw kørende 24/7 på GCP
  - Du vil have en produktionsklar, altid-aktiv Gateway på din egen VM
  - Du vil have fuld kontrol over persistens, binære filer og genstartsadfærd
title: "GCP"
---

# OpenClaw på GCP Compute Engine (Docker, produktions-VPS-guide)

## Mål

Kør en vedvarende OpenClaw Gateway på en GCP Compute Engine VM ved hjælp af Docker, med holdbar tilstand, indbyggede binære filer og sikker genstartsadfærd.

Hvis du ønsker "OpenClaw 24/7 for ~$5-12/mo", dette er en pålidelig opsætning på Google Cloud.
Priserne varierer efter maskintype og region; vælge den mindste VM, der passer til din arbejdsbyrde og skalere op, hvis du rammer OOMs.

## Hvad gør vi (enkelt forklaret)?

- Opret et GCP-projekt og aktivér fakturering
- Opret en Compute Engine VM
- Installér Docker (isoleret app-runtime)
- Start OpenClaw Gateway i Docker
- Bevar `~/.openclaw` + `~/.openclaw/workspace` på værten (overlever genstarter/genopbygninger)
- Få adgang til kontrol-UI’et fra din laptop via en SSH-tunnel

Gatewayen kan tilgås via:

- SSH-portvideresendelse fra din laptop
- Direkte port-eksponering, hvis du selv håndterer firewall og tokens

Denne guide bruger Debian på GCP Compute Engine.
Ubuntu virker også; kort pakker i overensstemmelse hermed.
For det generiske Dockerflow, se [Docker](/install/docker)

---

## Hurtig vej (erfarne operatører)

1. Opret GCP-projekt + aktivér Compute Engine API
2. Opret Compute Engine VM (e2-small, Debian 12, 20GB)
3. SSH ind på VM’en
4. Installér Docker
5. Klon OpenClaw-repositoriet
6. Opret vedvarende værtsmapper
7. Konfigurér `.env` og `docker-compose.yml`
8. Indbyg nødvendige binære filer, byg og start

---

## Hvad du skal bruge

- GCP-konto (free tier berettiget til e2-micro)
- gcloud CLI installeret (eller brug Cloud Console)
- SSH-adgang fra din laptop
- Grundlæggende komfort med SSH + copy/paste
- ~20-30 minutter
- Docker og Docker Compose
- Model-autentificeringsoplysninger
- Valgfrie udbyderoplysninger
  - WhatsApp QR
  - Telegram bot-token
  - Gmail OAuth

---

## 1. Installér gcloud CLI (eller brug Console)

**Mulighed A: gcloud CLI** (anbefalet til automatisering)

Installér fra [https://cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install)

Initialisér og autentificér:

```bash
gcloud init
gcloud auth login
```

**Mulighed B: Cloud Console**

Alle trin kan udføres via web-UI’et på [https://console.cloud.google.com](https://console.cloud.google.com)

---

## 2. Opret et GCP-projekt

**CLI:**

```bash
gcloud projects create my-openclaw-project --name="OpenClaw Gateway"
gcloud config set project my-openclaw-project
```

Aktivér fakturering på [https://console.cloud.google.com/billing](https://console.cloud.google.com/billing) (påkrævet for Compute Engine).

Aktivér Compute Engine API:

```bash
gcloud services enable compute.googleapis.com
```

**Console:**

1. Gå til IAM & Admin > Create Project
2. Navngiv det og opret
3. Aktivér fakturering for projektet
4. Gå til APIs & Services > Enable APIs > søg efter "Compute Engine API" > Enable

---

## 3. Opret VM’en

**Maskintyper:**

| Type     | Specifikationer                           | Pris                                     | Noter                       |
| -------- | ----------------------------------------- | ---------------------------------------- | --------------------------- |
| e2-small | 2 vCPU, 2GB RAM                           | ~$12/md. | Anbefalet                   |
| e2-micro | 2 vCPU (delt), 1GB RAM | Free tier-berettiget                     | Kan få OOM under belastning |

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

1. Gå til Compute Engine > VM instances > Create instance
2. Navn: `openclaw-gateway`
3. Region: `us-central1`, Zone: `us-central1-a`
4. Maskintype: `e2-small`
5. Boot-disk: Debian 12, 20GB
6. Opret

---

## 4. SSH ind på VM’en

**CLI:**

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

**Console:**

Klik på "SSH"-knappen ved siden af din VM i Compute Engine-dashboardet.

Bemærk: SSH nøgleformering kan tage 1-2 minutter efter VM oprettelse. Hvis forbindelse nægtes, så vent og prøv igen.

---

## 5. Installér Docker (på VM’en)

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

Log ud og ind igen for at gruppeændringen træder i kraft:

```bash
exit
```

SSH derefter ind igen:

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

Verificér:

```bash
docker --version
docker compose version
```

---

## 6. Klon OpenClaw-repositoriet

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

Denne guide antager, at du bygger et brugerdefineret image for at garantere persistens af binære filer.

---

## 7. Opret vedvarende værtsmapper

Docker containere er flydende.
Alle langvarige stater skal leve på værten.

```bash
mkdir -p ~/.openclaw
mkdir -p ~/.openclaw/workspace
```

---

## 8. Konfigurér miljøvariabler

Opret `.env` i roden af repositoriet.

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

Generér stærke hemmeligheder:

```bash
openssl rand -hex 32
```

**Commit ikke denne fil.**

---

## 9. Docker Compose-konfiguration

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

## 10. Indbyg nødvendige binære filer i imaget (kritisk)

Installation af binære filer i en kørende beholder er en fælde.
Alt installeret på runtime vil gå tabt ved genstart.

Alle eksterne binære filer, som Skills kræver, skal installeres ved image-build-tid.

Eksemplerne nedenfor viser kun tre almindelige binære filer:

- `gog` til Gmail-adgang
- `goplaces` til Google Places
- `wacli` til WhatsApp

Dette er eksempler, ikke en komplet liste.
Du kan installere så mange binære filer efter behov ved hjælp af det samme mønster.

Hvis du senere tilføjer nye Skills, der afhænger af yderligere binære filer, skal du:

1. Opdatere Dockerfile
2. Genbygge imaget
3. Genstarte containerne

**Eksempel på Dockerfile**

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

## 11. Byg og start

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

## 12. Verificér Gateway

```bash
docker compose logs -f openclaw-gateway
```

Succes:

```
[gateway] listening on ws://0.0.0.0:18789
```

---

## 13. Få adgang fra din laptop

Opret en SSH-tunnel for at videresende Gateway-porten:

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a -- -L 18789:127.0.0.1:18789
```

Åbn i din browser:

`http://127.0.0.1:18789/`

Indsæt dit gateway-token.

---

## Hvad gemmes hvor (sandhedskilde)

OpenClaw kører i Docker, men Docker er ikke kilden til sandhed.
Alle langlivede stater skal overleve genstarter, genopbygger og genstarter.

| Komponent             | Placering                         | Persistensmekanisme        | Noter                              |
| --------------------- | --------------------------------- | -------------------------- | ---------------------------------- |
| Gateway-konfiguration | `/home/node/.openclaw/`           | Værtsvolumen-mount         | Indeholder `openclaw.json`, tokens |
| Model-auth-profiler   | `/home/node/.openclaw/`           | Værtsvolumen-mount         | OAuth-tokens, API-nøgler           |
| Skill-konfigurationer | `/home/node/.openclaw/skills/`    | Værtsvolumen-mount         | Tilstand på Skill-niveau           |
| Agent-arbejdsområde   | `/home/node/.openclaw/workspace/` | Værtsvolumen-mount         | Kode og agent-artefakter           |
| WhatsApp-session      | `/home/node/.openclaw/`           | Værtsvolumen-mount         | Bevarer QR-login                   |
| Gmail-nøglering       | `/home/node/.openclaw/`           | Værtsvolumen + adgangskode | Kræver `GOG_KEYRING_PASSWORD`      |
| Eksterne binære filer | `/usr/local/bin/`                 | Docker-image               | Skal indbygges ved build-tid       |
| Node-runtime          | Container-filsystem               | Docker-image               | Genbygges ved hvert image-build    |
| OS-pakker             | Container-filsystem               | Docker-image               | Installér ikke ved runtime         |
| Docker-container      | Flygtig                           | Genstartbar                | Sikker at destruere                |

---

## Opdateringer

For at opdatere OpenClaw på VM’en:

```bash
cd ~/openclaw
git pull
docker compose build
docker compose up -d
```

---

## Fejlfinding

**SSH-forbindelse afvist**

SSH nøgleformering kan tage 1-2 minutter efter VM oprettelse. Vent og prøv igen.

**OS Login-problemer**

Tjek din OS Login-profil:

```bash
gcloud compute os-login describe-profile
```

Sørg for, at din konto har de nødvendige IAM-tilladelser (Compute OS Login eller Compute OS Admin Login).

**Ikke nok hukommelse (OOM)**

Hvis du bruger e2-micro og rammer OOM, så opgradér til e2-small eller e2-medium:

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

## Servicekonti (sikkerhedsbest practice)

Til personligt brug fungerer din standardbrugerkonto fint.

Til automatisering eller CI/CD-pipelines skal du oprette en dedikeret servicekonto med minimale rettigheder:

1. Opret en servicekonto:

   ```bash
   gcloud iam service-accounts create openclaw-deploy \
     --display-name="OpenClaw Deployment"
   ```

2. Tildel rollen Compute Instance Admin (eller en smallere brugerdefineret rolle):

   ```bash
   gcloud projects add-iam-policy-binding my-openclaw-project \
     --member="serviceAccount:openclaw-deploy@my-openclaw-project.iam.gserviceaccount.com" \
     --role="roles/compute.instanceAdmin.v1"
   ```

Undgå at bruge ejeren rolle for automatisering. Brug princippet om mindst privilegium.

Se [https://cloud.google.com/iam/docs/understanding-roles](https://cloud.google.com/iam/docs/understanding-roles) for detaljer om IAM-roller.

---

## Næste trin

- Opsæt beskedkanaler: [Channels](/channels)
- Par lokale enheder som noder: [Nodes](/nodes)
- Konfigurér Gateway: [Gateway configuration](/gateway/configuration)
