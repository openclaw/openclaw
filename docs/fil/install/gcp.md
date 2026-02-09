---
summary: "Patakbuhin ang OpenClaw Gateway 24/7 sa isang GCP Compute Engine VM (Docker) na may matibay na state"
read_when:
  - Gusto mong tumatakbo ang OpenClaw 24/7 sa GCP
  - Gusto mo ng production-grade, laging-on na Gateway sa sarili mong VM
  - Gusto mo ng ganap na kontrol sa persistence, mga binary, at asal ng restart
title: "GCP"
---

# OpenClaw sa GCP Compute Engine (Docker, Gabay sa Production VPS)

## Layunin

Magpatakbo ng isang persistent na OpenClaw Gateway sa isang GCP Compute Engine VM gamit ang Docker, na may matibay na state, naka-bake na mga binary, at ligtas na asal ng restart.

Kung gusto mo ng "OpenClaw 24/7 sa ~$5–12/buwan", ito ay isang maaasahang setup sa Google Cloud.
Nag-iiba ang presyo ayon sa uri ng makina at rehiyon; piliin ang pinakamaliit na VM na akma sa iyong workload at mag-scale up kung makaranas ka ng OOM.

## Ano ang gagawin natin (sa simpleng termino)?

- Gumawa ng GCP project at i-enable ang billing
- Gumawa ng Compute Engine VM
- I-install ang Docker (isolated na app runtime)
- Simulan ang OpenClaw Gateway sa Docker
- I-persist ang `~/.openclaw` + `~/.openclaw/workspace` sa host (nabubuhay sa mga restart/rebuild)
- I-access ang Control UI mula sa iyong laptop sa pamamagitan ng SSH tunnel

Maaaring ma-access ang Gateway sa pamamagitan ng:

- SSH port forwarding mula sa iyong laptop
- Direktang pag-expose ng port kung ikaw ang magma-manage ng firewalling at mga token

5. Gumagamit ang gabay na ito ng Debian sa GCP Compute Engine.
   Gumagana rin ang Ubuntu; i-map ang mga package nang naaayon.
6. Para sa generic na Docker flow, tingnan ang [Docker](/install/docker).

---

## Mabilis na ruta (para sa may karanasan)

1. Gumawa ng GCP project + i-enable ang Compute Engine API
2. Gumawa ng Compute Engine VM (e2-small, Debian 12, 20GB)
3. Mag-SSH papasok sa VM
4. I-install ang Docker
5. I-clone ang OpenClaw repository
6. Gumawa ng persistent na mga directory sa host
7. I-configure ang `.env` at `docker-compose.yml`
8. I-bake ang mga kinakailangang binary, i-build, at ilunsad

---

## Mga kailangan

- GCP account (free tier eligible para sa e2-micro)
- Naka-install na gcloud CLI (o gumamit ng Cloud Console)
- SSH access mula sa iyong laptop
- Pangunahing kasanayan sa SSH + copy/paste
- ~20-30 minuto
- Docker at Docker Compose
- Mga credential para sa model auth
- Opsyonal na mga credential ng provider
  - WhatsApp QR
  - Telegram bot token
  - Gmail OAuth

---

## 1. I-install ang gcloud CLI (o gumamit ng Console)

**Opsyon A: gcloud CLI** (inirerekomenda para sa automation)

I-install mula sa [https://cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install)

I-initialize at mag-authenticate:

```bash
gcloud init
gcloud auth login
```

**Opsyon B: Cloud Console**

Lahat ng hakbang ay maaaring gawin sa web UI sa [https://console.cloud.google.com](https://console.cloud.google.com)

---

## 2. Gumawa ng GCP project

**CLI:**

```bash
gcloud projects create my-openclaw-project --name="OpenClaw Gateway"
gcloud config set project my-openclaw-project
```

I-enable ang billing sa [https://console.cloud.google.com/billing](https://console.cloud.google.com/billing) (kinakailangan para sa Compute Engine).

I-enable ang Compute Engine API:

```bash
gcloud services enable compute.googleapis.com
```

**Console:**

1. Pumunta sa IAM & Admin > Create Project
2. Pangalanan ito at gumawa
3. I-enable ang billing para sa project
4. Pumunta sa APIs & Services > Enable APIs > hanapin ang "Compute Engine API" > Enable

---

## 3. Gumawa ng VM

**Mga uri ng makina:**

| Uri      | Specs                                       | Gastos                     | Mga tala                           |
| -------- | ------------------------------------------- | -------------------------- | ---------------------------------- |
| e2-small | 2 vCPU, 2GB RAM                             | ~$12/buwan | Inirerekomenda                     |
| e2-micro | 2 vCPU (shared), 1GB RAM | Eligible sa free tier      | Maaaring mag-OOM sa ilalim ng load |

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

1. Pumunta sa Compute Engine > VM instances > Create instance
2. Pangalan: `openclaw-gateway`
3. Rehiyon: `us-central1`, Zone: `us-central1-a`
4. Uri ng makina: `e2-small`
5. Boot disk: Debian 12, 20GB
6. Create

---

## 4. Mag-SSH papasok sa VM

**CLI:**

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

**Console:**

I-click ang button na "SSH" sa tabi ng iyong VM sa Compute Engine dashboard.

Tandaan: Maaaring tumagal ng 1–2 minuto ang pag-propagate ng SSH key pagkatapos malikha ang VM. Kung tinatanggihan ang koneksyon, maghintay at subukang muli.

---

## 5. I-install ang Docker (sa VM)

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

Mag-log out at mag-log in muli para magkabisa ang pagbabago sa group:

```bash
exit
```

Pagkatapos, mag-SSH muli:

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

I-verify:

```bash
docker --version
docker compose version
```

---

## 6. I-clone ang OpenClaw repository

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

Ipinapalagay ng gabay na ito na magbu-build ka ng custom image para masiguro ang persistence ng mga binary.

---

## 7. Gumawa ng persistent na mga directory sa host

10. Ang mga Docker container ay ephemeral.
    Lahat ng pangmatagalang state ay dapat manatili sa host.

```bash
mkdir -p ~/.openclaw
mkdir -p ~/.openclaw/workspace
```

---

## 8. I-configure ang mga environment variable

Gumawa ng `.env` sa root ng repository.

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

Bumuo ng malalakas na secret:

```bash
openssl rand -hex 32
```

**Huwag i-commit ang file na ito.**

---

## 9. Docker Compose configuration

Gumawa o i-update ang `docker-compose.yml`.

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

## 10. I-bake ang mga kinakailangang binary sa image (kritikal)

Ang pag-install ng mga binary sa loob ng tumatakbong container ay isang patibong.
Anumang naka-install sa runtime ay mawawala kapag nag-restart.

Lahat ng external na binary na kinakailangan ng Skills ay dapat i-install sa oras ng image build.

Ipinapakita ng mga halimbawa sa ibaba ang tatlong karaniwang binary lamang:

- `gog` para sa Gmail access
- `goplaces` para sa Google Places
- `wacli` para sa WhatsApp

14. Mga halimbawa lamang ito, hindi kumpletong listahan.
    Maaari kang mag-install ng kasing daming binary hangga't kailangan gamit ang parehong pattern.

Kung magdadagdag ka ng bagong Skills sa hinaharap na umaasa sa karagdagang mga binary, kailangan mong:

1. I-update ang Dockerfile
2. I-rebuild ang image
3. I-restart ang mga container

**Halimbawang Dockerfile**

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

## 11. I-build at ilunsad

```bash
docker compose build
docker compose up -d openclaw-gateway
```

I-verify ang mga binary:

```bash
docker compose exec openclaw-gateway which gog
docker compose exec openclaw-gateway which goplaces
docker compose exec openclaw-gateway which wacli
```

Inaasahang output:

```
/usr/local/bin/gog
/usr/local/bin/goplaces
/usr/local/bin/wacli
```

---

## 12. I-verify ang Gateway

```bash
docker compose logs -f openclaw-gateway
```

Tagumpay:

```
[gateway] listening on ws://0.0.0.0:18789
```

---

## 13. I-access mula sa iyong laptop

Gumawa ng SSH tunnel para i-forward ang Gateway port:

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a -- -L 18789:127.0.0.1:18789
```

Buksan sa iyong browser:

`http://127.0.0.1:18789/`

I-paste ang iyong gateway token.

---

## Ano ang nagpe-persist at saan (pinagmumulan ng katotohanan)

Tumatakbo ang OpenClaw sa Docker, ngunit ang Docker ay hindi ang pinagmumulan ng katotohanan.
Lahat ng pangmatagalang state ay dapat makaligtas sa mga restart, rebuild, at reboot.

| Component                 | Lokasyon                          | Mekanismo ng persistence | Mga tala                                  |
| ------------------------- | --------------------------------- | ------------------------ | ----------------------------------------- |
| Gateway config            | `/home/node/.openclaw/`           | Host volume mount        | Kasama ang `openclaw.json`, mga token     |
| Mga profile ng model auth | `/home/node/.openclaw/`           | Host volume mount        | Mga OAuth token, API key                  |
| Mga config ng Skill       | `/home/node/.openclaw/skills/`    | Host volume mount        | State sa antas ng Skill                   |
| Workspace ng agent        | `/home/node/.openclaw/workspace/` | Host volume mount        | Code at mga artifact ng agent             |
| WhatsApp session          | `/home/node/.openclaw/`           | Host volume mount        | Pinapanatili ang QR login                 |
| Gmail keyring             | `/home/node/.openclaw/`           | Host volume + password   | Nangangailangan ng `GOG_KEYRING_PASSWORD` |
| External na mga binary    | `/usr/local/bin/`                 | Docker image             | Dapat i-bake sa oras ng build             |
| Node runtime              | Filesystem ng container           | Docker image             | Nire-rebuild sa bawat image build         |
| Mga OS package            | Filesystem ng container           | Docker image             | Huwag i-install sa runtime                |
| Docker container          | Ephemeral                         | Restartable              | Ligtas sirain                             |

---

## Mga update

Para i-update ang OpenClaw sa VM:

```bash
cd ~/openclaw
git pull
docker compose build
docker compose up -d
```

---

## Pag-troubleshoot

**Tinanggihan ang SSH connection**

Ang pagpapalaganap ng SSH key ay maaaring tumagal ng 1–2 minuto pagkatapos malikha ang VM. Maghintay at subukang muli.

**Mga isyu sa OS Login**

Suriin ang iyong OS Login profile:

```bash
gcloud compute os-login describe-profile
```

Siguraduhing may kinakailangang IAM permissions ang iyong account (Compute OS Login o Compute OS Admin Login).

**Out of memory (OOM)**

Kung gumagamit ng e2-micro at nakakaranas ng OOM, mag-upgrade sa e2-small o e2-medium:

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

## Mga service account (pinakamahusay na kasanayan sa seguridad)

Para sa personal na paggamit, ayos na ang iyong default user account.

Para sa automation o CI/CD pipelines, gumawa ng dedikadong service account na may minimal na permissions:

1. Gumawa ng service account:

   ```bash
   gcloud iam service-accounts create openclaw-deploy \
     --display-name="OpenClaw Deployment"
   ```

2. Ibigay ang Compute Instance Admin role (o mas makitid na custom role):

   ```bash
   gcloud projects add-iam-policy-binding my-openclaw-project \
     --member="serviceAccount:openclaw-deploy@my-openclaw-project.iam.gserviceaccount.com" \
     --role="roles/compute.instanceAdmin.v1"
   ```

Iwasang gamitin ang Owner role para sa automation. Gamitin ang prinsipyo ng pinakamababang pribilehiyo.

Tingnan ang [https://cloud.google.com/iam/docs/understanding-roles](https://cloud.google.com/iam/docs/understanding-roles) para sa detalye ng mga IAM role.

---

## Mga susunod na hakbang

- I-set up ang mga messaging channel: [Channels](/channels)
- I-pair ang mga lokal na device bilang mga node: [Nodes](/nodes)
- I-configure ang Gateway: [Gateway configuration](/gateway/configuration)
