---
summary: "Draai OpenClaw Gateway 24/7 op een GCP Compute Engine-VM (Docker) met duurzame status"
read_when:
  - Je wilt OpenClaw 24/7 op GCP draaien
  - Je wilt een productieklare, altijd-aan Gateway op je eigen VM
  - Je wilt volledige controle over persistentie, binaries en herstartgedrag
title: "GCP"
---

# OpenClaw op GCP Compute Engine (Docker, productie-VPS-gids)

## Doel

Een persistente OpenClaw Gateway draaien op een GCP Compute Engine-VM met Docker, met duurzame status, ingebakken binaries en veilig herstartgedrag.

Als je “OpenClaw 24/7 voor ~$5-12/maand” wilt, is dit een betrouwbare setup op Google Cloud.
De prijs varieert per machinetype en regio; kies de kleinste VM die bij je workload past en schaal op als je OOM’s tegenkomt.

## Wat doen we (in eenvoudige termen)?

- Een GCP-project aanmaken en billing inschakelen
- Een Compute Engine-VM aanmaken
- Docker installeren (geïsoleerde app-runtime)
- De OpenClaw Gateway in Docker starten
- `~/.openclaw` + `~/.openclaw/workspace` op de host persistent maken (overleeft herstarts/rebuilds)
- De Control UI vanaf je laptop benaderen via een SSH-tunnel

De Gateway is toegankelijk via:

- SSH-port forwarding vanaf je laptop
- Directe poortblootstelling als je zelf firewalling en tokens beheert

Deze gids gebruikt Debian op GCP Compute Engine.
Ubuntu werkt ook; map de pakketten overeenkomstig.
Voor de generieke Docker-flow, zie [Docker](/install/docker).

---

## Snelle route (ervaren operators)

1. Maak een GCP-project en schakel de Compute Engine API in
2. Maak een Compute Engine-VM (e2-small, Debian 12, 20GB)
3. SSH in op de VM
4. Installeer Docker
5. Clone de OpenClaw-repository
6. Maak persistente hostmappen
7. Configureer `.env` en `docker-compose.yml`
8. Bak vereiste binaries, bouw en start

---

## Wat heb je nodig

- GCP-account (free tier komt in aanmerking voor e2-micro)
- gcloud CLI geïnstalleerd (of gebruik Cloud Console)
- SSH-toegang vanaf je laptop
- Basisvaardigheid met SSH + kopiëren/plakken
- ~20–30 minuten
- Docker en Docker Compose
- Model-authenticatiegegevens
- Optionele provider-gegevens
  - WhatsApp QR
  - Telegram bot-token
  - Gmail OAuth

---

## 1. gcloud CLI installeren (of Console gebruiken)

**Optie A: gcloud CLI** (aanbevolen voor automatisering)

Installeer via [https://cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install)

Initialiseer en authenticeer:

```bash
gcloud init
gcloud auth login
```

**Optie B: Cloud Console**

Alle stappen kunnen via de web-UI op [https://console.cloud.google.com](https://console.cloud.google.com)

---

## 2. Een GCP-project aanmaken

**CLI:**

```bash
gcloud projects create my-openclaw-project --name="OpenClaw Gateway"
gcloud config set project my-openclaw-project
```

Schakel billing in via [https://console.cloud.google.com/billing](https://console.cloud.google.com/billing) (vereist voor Compute Engine).

Schakel de Compute Engine API in:

```bash
gcloud services enable compute.googleapis.com
```

**Console:**

1. Ga naar IAM & Admin > Project maken
2. Geef een naam en maak het project aan
3. Schakel billing in voor het project
4. Ga naar API’s & Services > API’s inschakelen > zoek “Compute Engine API” > Inschakelen

---

## 3. De VM aanmaken

**Machinetypes:**

| Type     | Specificaties                                | Kosten                     | Opmerkingen     |
| -------- | -------------------------------------------- | -------------------------- | --------------- |
| e2-small | 2 vCPU, 2GB RAM                              | ~$12/maand | Aanbevolen      |
| e2-micro | 2 vCPU (gedeeld), 1GB RAM | Free tier                  | Kan OOM krijgen |

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

1. Ga naar Compute Engine > VM-instanties > Instantie maken
2. Naam: `openclaw-gateway`
3. Regio: `us-central1`, Zone: `us-central1-a`
4. Machinetype: `e2-small`
5. Bootdisk: Debian 12, 20GB
6. Aanmaken

---

## 4. SSH inloggen op de VM

**CLI:**

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

**Console:**

Klik op de knop “SSH” naast je VM in het Compute Engine-dashboard.

Let op: het doorgeven van SSH-sleutels kan 1–2 minuten duren na het aanmaken van de VM. Als de verbinding wordt geweigerd, wacht en probeer opnieuw.

---

## 5. Docker installeren (op de VM)

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

Log uit en weer in zodat de groepswijziging effect heeft:

```bash
exit
```

SSH daarna opnieuw in:

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

Verifiëren:

```bash
docker --version
docker compose version
```

---

## 6. De OpenClaw-repository clonen

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

Deze gids gaat ervan uit dat je een custom image bouwt om binaire persistentie te garanderen.

---

## 7. Persistente hostmappen aanmaken

Docker-containers zijn tijdelijk.
Alle langlevende status moet op de host staan.

```bash
mkdir -p ~/.openclaw
mkdir -p ~/.openclaw/workspace
```

---

## 8. Omgevingsvariabelen configureren

Maak `.env` aan in de root van de repository.

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

Genereer sterke secrets:

```bash
openssl rand -hex 32
```

**Commit dit bestand niet.**

---

## 9. Docker Compose-configuratie

Maak `docker-compose.yml` aan of werk het bij.

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

## 10. Vereiste binaries in het image bakken (kritiek)

Binaries installeren in een draaiende container is een valkuil.
Alles wat tijdens runtime wordt geïnstalleerd, gaat verloren bij een herstart.

Alle externe binaries die Skills vereisen, moeten tijdens het bouwen van het image worden geïnstalleerd.

De voorbeelden hieronder tonen slechts drie veelgebruikte binaries:

- `gog` voor Gmail-toegang
- `goplaces` voor Google Places
- `wacli` voor WhatsApp

Dit zijn voorbeelden, geen volledige lijst.
Je kunt zoveel binaries installeren als nodig met hetzelfde patroon.

Als je later nieuwe Skills toevoegt die extra binaries vereisen, moet je:

1. Het Dockerfile bijwerken
2. Het image opnieuw bouwen
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

## 11. Bouwen en starten

```bash
docker compose build
docker compose up -d openclaw-gateway
```

Binaries verifiëren:

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

## 12. Gateway verifiëren

```bash
docker compose logs -f openclaw-gateway
```

Succes:

```
[gateway] listening on ws://0.0.0.0:18789
```

---

## 13. Toegang vanaf je laptop

Maak een SSH-tunnel om de Gateway-poort door te sturen:

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a -- -L 18789:127.0.0.1:18789
```

Open in je browser:

`http://127.0.0.1:18789/`

Plak je gateway-token.

---

## Wat blijft waar bestaan (bron van waarheid)

OpenClaw draait in Docker, maar Docker is niet de bron van waarheid.
Alle langlevende status moet herstarts, rebuilds en reboots overleven.

| Component           | Locatie                           | Persistentiemechanisme   | Opmerkingen                        |
| ------------------- | --------------------------------- | ------------------------ | ---------------------------------- |
| Gateway-config      | `/home/node/.openclaw/`           | Host volume mount        | Inclusief `openclaw.json`, tokens  |
| Model-authprofielen | `/home/node/.openclaw/`           | Host volume mount        | OAuth-tokens, API-sleutels         |
| Skill-configs       | `/home/node/.openclaw/skills/`    | Host volume mount        | Status per skill                   |
| Agent-werkruimte    | `/home/node/.openclaw/workspace/` | Host volume mount        | Code en agent-artefacten           |
| WhatsApp-sessie     | `/home/node/.openclaw/`           | Host volume mount        | Behoudt QR-login                   |
| Gmail-sleutelring   | `/home/node/.openclaw/`           | Host volume + wachtwoord | Vereist `GOG_KEYRING_PASSWORD`     |
| Externe binaries    | `/usr/local/bin/`                 | Docker-image             | Moeten bij build worden ingebakken |
| Node-runtime        | Container-bestandssysteem         | Docker-image             | Opnieuw gebouwd bij elke build     |
| OS-pakketten        | Container-bestandssysteem         | Docker-image             | Niet tijdens runtime installeren   |
| Docker-container    | Ephemeral                         | Herstartbaar             | Veilig om te vernietigen           |

---

## Updates

OpenClaw op de VM bijwerken:

```bash
cd ~/openclaw
git pull
docker compose build
docker compose up -d
```

---

## Problemen oplossen

**SSH-verbinding geweigerd**

Het doorgeven van SSH-sleutels kan 1–2 minuten duren na het aanmaken van de VM. Wacht en probeer opnieuw.

**OS Login-problemen**

Controleer je OS Login-profiel:

```bash
gcloud compute os-login describe-profile
```

Zorg dat je account de vereiste IAM-rechten heeft (Compute OS Login of Compute OS Admin Login).

**Onvoldoende geheugen (OOM)**

Als je e2-micro gebruikt en OOM krijgt, upgrade naar e2-small of e2-medium:

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

## Serviceaccounts (best practice voor beveiliging)

Voor persoonlijk gebruik volstaat je standaardgebruikersaccount.

Voor automatisering of CI/CD-pijplijnen, maak een dedicated serviceaccount met minimale rechten:

1. Maak een serviceaccount aan:

   ```bash
   gcloud iam service-accounts create openclaw-deploy \
     --display-name="OpenClaw Deployment"
   ```

2. Ken de rol Compute Instance Admin toe (of een beperktere custom rol):

   ```bash
   gcloud projects add-iam-policy-binding my-openclaw-project \
     --member="serviceAccount:openclaw-deploy@my-openclaw-project.iam.gserviceaccount.com" \
     --role="roles/compute.instanceAdmin.v1"
   ```

Vermijd het gebruik van de Owner-rol voor automatisering. Hanteer het principe van minimale rechten.

Zie [https://cloud.google.com/iam/docs/understanding-roles](https://cloud.google.com/iam/docs/understanding-roles) voor details over IAM-rollen.

---

## Volgende stappen

- Messagingkanalen instellen: [Channels](/channels)
- Lokale apparaten koppelen als nodes: [Nodes](/nodes)
- De Gateway configureren: [Gateway configuration](/gateway/configuration)
