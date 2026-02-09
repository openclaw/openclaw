---
summary: "Patakbuhin ang OpenClaw Gateway 24/7 sa murang Hetzner VPS (Docker) na may matibay na state at baked-in na mga binary"
read_when:
  - Gusto mo ng OpenClaw na tumatakbo 24/7 sa isang cloud VPS (hindi sa iyong laptop)
  - Gusto mo ng production-grade, laging naka-on na Gateway sa sarili mong VPS
  - Gusto mo ng ganap na kontrol sa persistence, mga binary, at behavior ng restart
  - Pinapatakbo mo ang OpenClaw sa Docker sa Hetzner o katulad na provider
title: "Hetzner"
---

# OpenClaw sa Hetzner (Docker, Gabay sa Production VPS)

## Layunin

Magpatakbo ng persistent na OpenClaw Gateway sa isang Hetzner VPS gamit ang Docker, na may durable na state, baked-in na mga binary, at ligtas na behavior sa restart.

Kung gusto mo ng “OpenClaw 24/7 sa halagang ~$5”, ito ang pinakasimple at maaasahang setup.
23. Nagbabago ang pagpepresyo ng Hetzner; piliin ang pinakamaliit na Debian/Ubuntu VPS at mag-scale up kung makaranas ka ng OOMs.

## Ano ang ginagawa natin (sa simpleng paliwanag)?

- Umupa ng maliit na Linux server (Hetzner VPS)
- Mag-install ng Docker (isolated na app runtime)
- Simulan ang OpenClaw Gateway sa Docker
- I-persist ang `~/.openclaw` + `~/.openclaw/workspace` sa host (nabubuhay kahit mag-restart/mag-rebuild)
- I-access ang Control UI mula sa iyong laptop sa pamamagitan ng SSH tunnel

Maaaring ma-access ang Gateway sa pamamagitan ng:

- SSH port forwarding mula sa iyong laptop
- Direktang pag-expose ng port kung ikaw mismo ang nagma-manage ng firewall at mga token

Ipinapalagay ng gabay na ito ang Ubuntu o Debian sa Hetzner.  
Kung nasa ibang Linux VPS ka, iangkop ang mga package nang naaayon.
Para sa pangkalahatang daloy ng Docker, tingnan ang [Docker](/install/docker).

---

## Mabilis na ruta (para sa bihasang operator)

1. Mag-provision ng Hetzner VPS
2. Mag-install ng Docker
3. I-clone ang OpenClaw repository
4. Gumawa ng persistent na mga directory sa host
5. I-configure ang `.env` at `docker-compose.yml`
6. I-bake ang mga kinakailangang binary sa image
7. `docker compose up -d`
8. I-verify ang persistence at access sa Gateway

---

## Mga kailangan mo

- Hetzner VPS na may root access
- SSH access mula sa iyong laptop
- Pangunahing kumpiyansa sa SSH + copy/paste
- ~20 minuto
- Docker at Docker Compose
- Mga kredensyal sa auth ng model
- Opsyonal na mga kredensyal ng provider
  - WhatsApp QR
  - Telegram bot token
  - Gmail OAuth

---

## 1. Mag-provision ng VPS

Gumawa ng Ubuntu o Debian VPS sa Hetzner.

Kumonek bilang root:

```bash
ssh root@YOUR_VPS_IP
```

27. Ipinapalagay ng gabay na ito na stateful ang VPS.
28. Huwag itong ituring bilang disposable infrastructure.

---

## 2. I-install ang Docker (sa VPS)

```bash
apt-get update
apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sh
```

I-verify:

```bash
docker --version
docker compose version
```

---

## 3. I-clone ang OpenClaw repository

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

Ipinapalagay ng gabay na ito na magbu-build ka ng custom na image para masigurong persistent ang mga binary.

---

## 4. Gumawa ng persistent na mga directory sa host

Ang mga Docker container ay panandalian.
30. Lahat ng pangmatagalang estado ay dapat manatili sa host.

```bash
mkdir -p /root/.openclaw
mkdir -p /root/.openclaw/workspace

# Set ownership to the container user (uid 1000):
chown -R 1000:1000 /root/.openclaw
chown -R 1000:1000 /root/.openclaw/workspace
```

---

## 5. I-configure ang mga environment variable

Gumawa ng `.env` sa root ng repository.

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

Bumuo ng malalakas na secret:

```bash
openssl rand -hex 32
```

**Huwag i-commit ang file na ito.**

---

## 6. Docker Compose configuration

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

## 7. I-bake ang mga kinakailangang binary sa image (kritikal)

Ang pag-install ng mga binary sa loob ng tumatakbong container ay isang bitag.
Anumang na-install sa oras ng pagtakbo ay mawawala kapag nag-restart.

Lahat ng external na binary na kailangan ng Skills ay dapat i-install sa image build time.

Ipinapakita ng mga halimbawa sa ibaba ang tatlong karaniwang binary lamang:

- `gog` para sa Gmail access
- `goplaces` para sa Google Places
- `wacli` para sa WhatsApp

Mga halimbawa lamang ito, hindi kumpletong listahan.
Maaari kang mag-install ng kasing daming binary na kailangan gamit ang parehong pattern.

Kung magdadagdag ka ng mga bagong Skills sa hinaharap na umaasa sa karagdagang mga binary, kailangan mong:

1. I-update ang Dockerfile
2. I-rebuild ang image
3. I-restart ang mga container

**Halimbawa ng Dockerfile**

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

## 8. I-build at ilunsad

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

## 9. I-verify ang Gateway

```bash
docker compose logs -f openclaw-gateway
```

Tagumpay:

```
[gateway] listening on ws://0.0.0.0:18789
```

Mula sa iyong laptop:

```bash
ssh -N -L 18789:127.0.0.1:18789 root@YOUR_VPS_IP
```

Buksan:

`http://127.0.0.1:18789/`

I-paste ang iyong gateway token.

---

## Ano ang persistent at saan (pinagmumulan ng katotohanan)

Tumatakbo ang OpenClaw sa Docker, ngunit ang Docker ay hindi ang source of truth.
36. Lahat ng pangmatagalang estado ay dapat makaligtas sa mga restart, rebuild, at reboot.

| Component           | Lokasyon                          | Mekanismo ng persistence | Mga tala                                  |
| ------------------- | --------------------------------- | ------------------------ | ----------------------------------------- |
| Gateway config      | `/home/node/.openclaw/`           | Host volume mount        | Kasama ang `openclaw.json`, mga token     |
| Model auth profiles | `/home/node/.openclaw/`           | Host volume mount        | OAuth tokens, API keys                    |
| Skill configs       | `/home/node/.openclaw/skills/`    | Host volume mount        | State sa antas ng Skill                   |
| Agent workspace     | `/home/node/.openclaw/workspace/` | Host volume mount        | Code at mga artifact ng agent             |
| WhatsApp session    | `/home/node/.openclaw/`           | Host volume mount        | Pinapanatili ang QR login                 |
| Gmail keyring       | `/home/node/.openclaw/`           | Host volume + password   | Nangangailangan ng `GOG_KEYRING_PASSWORD` |
| External binaries   | `/usr/local/bin/`                 | Docker image             | Dapat i-bake sa build time                |
| Node runtime        | Container filesystem              | Docker image             | Nire-rebuild sa bawat image build         |
| OS packages         | Container filesystem              | Docker image             | Huwag mag-install sa runtime              |
| Docker container    | Ephemeral                         | Restartable              | Ligtas na sirain                          |
