---
summary: "စျေးသက်သာသော Hetzner VPS (Docker) ပေါ်တွင် အမြဲလည်ပတ်နေစေရန် OpenClaw Gateway ကို တည်ငြိမ်သော state နှင့် binary များပါဝင်အောင် တပ်ဆင်လုပ်ဆောင်ခြင်း"
read_when:
  - သင် OpenClaw ကို cloud VPS ပေါ်တွင် (သင့်လက်ပ်တော့မဟုတ်ဘဲ) ၂၄/၇ လည်ပတ်စေချင်သောအခါ
  - သင့်ကိုယ်ပိုင် VPS ပေါ်တွင် production အဆင့်၊ အမြဲဖွင့်ထားသော Gateway ကိုလိုအပ်သောအခါ
  - persistence၊ binaries နှင့် restart အပြုအမူများကို အပြည့်အဝ ထိန်းချုပ်လိုသောအခါ
  - Hetzner သို့မဟုတ် ဆင်တူသော provider ပေါ်တွင် Docker ဖြင့် OpenClaw ကို လည်ပတ်နေသောအခါ
title: "Hetzner"
---

# Hetzner ပေါ်ရှိ OpenClaw (Docker, Production VPS လမ်းညွှန်)

## ရည်ရွယ်ချက်

Docker ကို အသုံးပြု၍ Hetzner VPS ပေါ်တွင် တည်ငြိမ်သော state၊ binary များကို image အတွင်း ထည့်သွင်းထားခြင်းနှင့် restart လုပ်ရာတွင် လုံခြုံစိတ်ချရသော အပြုအမူတို့ပါဝင်သည့် OpenClaw Gateway ကို အမြဲတမ်း လည်ပတ်စေခြင်း။

“OpenClaw ကို ~$5 နဲ့ 24/7 သုံးချင်ရင်” ဒီ setup က အလွယ်ဆုံးနဲ့ ယုံကြည်စိတ်ချရဆုံးပါ။
Hetzner စျေးနှုန်းများ ပြောင်းလဲနိုင်ပါသည်။ အသေးဆုံး Debian/Ubuntu VPS ကို ရွေးချယ်ပြီး OOM များ ဖြစ်လာပါက scale up လုပ်ပါ။

## ဘာလုပ်မလဲ (ရိုးရှင်းစွာ)?

- Linux ဆာဗာအသေးတစ်လုံး (Hetzner VPS) ကို ငှားရမ်းမည်
- Docker ကို ထည့်သွင်းမည် (အထီးကျန် app runtime)
- Docker အတွင်း OpenClaw Gateway ကို စတင်မည်
- `~/.openclaw` + `~/.openclaw/workspace` ကို ဟို့စ်ပေါ်တွင် သိမ်းဆည်းထားမည် (restart/rebuild ပြုလုပ်သော်လည်း မပျောက်)
- SSH တန်နယ်ကို အသုံးပြု၍ သင့်လက်ပ်တော့မှ Control UI ကို ဝင်ရောက်မည်

Gateway ကို ဝင်ရောက်နိုင်သော နည်းလမ်းများမှာ-

- သင့်လက်ပ်တော့မှ SSH port forwarding ဖြင့်
- firewall နှင့် token များကို ကိုယ်တိုင် စီမံနိုင်ပါက port ကို တိုက်ရိုက် ဖွင့်၍

ဤလမ်းညွှန်သည် Hetzner ပေါ်ရှိ Ubuntu သို့မဟုတ် Debian ကို အခြေခံထားပါသည်။  
အခြား Linux VPS ကို အသုံးပြုနေပါက packages များကို သင့်လျော်အောင် mapping လုပ်ပါ။
အထွေထွေ Docker flow အတွက် [Docker](/install/docker) ကို ကြည့်ပါ။

---

## အမြန်လမ်းကြောင်း (အတွေ့အကြုံရှိသော operator များ)

1. Hetzner VPS ကို provision ပြုလုပ်ပါ
2. Docker ကို ထည့်သွင်းပါ
3. OpenClaw repository ကို clone လုပ်ပါ
4. persistence အတွက် host directory များကို ဖန်တီးပါ
5. `.env` နှင့် `docker-compose.yml` ကို ဖွဲ့စည်းပြင်ဆင်ပါ
6. လိုအပ်သော binary များကို image အတွင်း bake လုပ်ပါ
7. `docker compose up -d`
8. persistence နှင့် Gateway ဝင်ရောက်မှုကို စစ်ဆေးပါ

---

## လိုအပ်သောအရာများ

- root access ပါသော Hetzner VPS
- သင့်လက်ပ်တော့မှ SSH ဝင်ရောက်နိုင်မှု
- SSH + copy/paste ကို အခြေခံအားဖြင့် သုံးတတ်ရမည်
- အချိန် ~၂၀ မိနစ်
- Docker နှင့် Docker Compose
- Model auth အတွက် အထောက်အထားများ
- ရွေးချယ်စရာ provider အထောက်အထားများ
  - WhatsApp QR
  - Telegram bot token
  - Gmail OAuth

---

## 1. VPS ကို Provision လုပ်ခြင်း

Hetzner တွင် Ubuntu သို့မဟုတ် Debian VPS တစ်လုံးကို ဖန်တီးပါ။

root အဖြစ် ချိတ်ဆက်ပါ-

```bash
ssh root@YOUR_VPS_IP
```

ဤလမ်းညွှန်သည် VPS သည် stateful ဖြစ်သည်ဟု ယူဆထားပါသည်။
၎င်းကို disposable infrastructure အဖြစ် မသတ်မှတ်ပါနှင့်။

---

## 2. Docker ကို ထည့်သွင်းခြင်း (VPS ပေါ်တွင်)

```bash
apt-get update
apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sh
```

အတည်ပြုပါ-

```bash
docker --version
docker compose version
```

---

## 3. OpenClaw repository ကို Clone လုပ်ခြင်း

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

binary persistence ကို အာမခံရန် custom image တစ်ခုကို build လုပ်မည်ဟု ဤလမ်းညွှန်က ယူဆထားပါသည်။

---

## 4. persistence အတွက် host directory များ ဖန်တီးခြင်း

Docker containers များသည် ephemeral ဖြစ်ပါသည်။
အချိန်ကြာရှည်အသုံးပြုမည့် state အားလုံးကို host ပေါ်တွင်သာ ထားရမည်။

```bash
10. mkdir -p /root/.openclaw/workspace

# Set ownership to the container user (uid 1000):
chown -R 1000:1000 /root/.openclaw
```

---

## 5. environment variables ကို ဖွဲ့စည်းပြင်ဆင်ခြင်း

repository root တွင် `.env` ကို ဖန်တီးပါ။

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

ခိုင်မာသော secret များကို ထုတ်လုပ်ပါ-

```bash
openssl rand -hex 32
```

**ဤဖိုင်ကို commit မလုပ်ပါနှင့်။**

---

## 6. Docker Compose ဖွဲ့စည်းမှု

`docker-compose.yml` ကို ဖန်တီးပါ သို့မဟုတ် အပ်ဒိတ်လုပ်ပါ။

```yaml
11. services:
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
        "--allow-unconfigured",
      ]
```

12. `--allow-unconfigured` သည် bootstrap အတွက် အဆင်ပြေစေရန်သာ ဖြစ်ပြီး သင့်တော်သော gateway configuration ကို အစားထိုးနိုင်ခြင်း မရှိပါ။ 13. သင့် deployment အတွက် auth (`gateway.auth.token` သို့မဟုတ် password) ကို သတ်မှတ်ထားပြီး လုံခြုံသော bind setting များကို အသုံးပြုပါ။

---

## 7. လိုအပ်သော binary များကို image အတွင်း bake လုပ်ခြင်း (အရေးကြီး)

လည်ပတ်နေသော container အတွင်း binaries ကို install လုပ်ခြင်းသည် ထောင်ချောက်တစ်ခုဖြစ်သည်။
runtime အတွင်း install လုပ်ထားသမျှ အရာအားလုံးသည် restart ပြုလုပ်ပါက ပျောက်ကွယ်သွားမည်ဖြစ်သည်။

Skills များလိုအပ်သော အပြင်ဘက် binary အားလုံးကို image build အချိန်တွင် ထည့်သွင်းရပါမည်။

အောက်ပါ ဥပမာများတွင် အသုံးများသော binary သုံးမျိုးကိုသာ ပြထားပါသည်-

- Gmail ဝင်ရောက်မှုအတွက် `gog`
- Google Places အတွက် `goplaces`
- WhatsApp အတွက် `wacli`

ဒါတွေက ဥပမာတွေသာ ဖြစ်ပြီး အပြည့်အစုံ စာရင်း မဟုတ်ပါ။
တူညီသော pattern ကို အသုံးပြုပြီး လိုအပ်သလောက် binaries များကို install လုပ်နိုင်ပါသည်။

နောက်ပိုင်းတွင် binary အသစ်များကို မူတည်သော Skills အသစ်များ ထည့်ပါက-

1. Dockerfile ကို အပ်ဒိတ်လုပ်ပါ
2. image ကို ပြန်လည် build လုပ်ပါ
3. container များကို restart လုပ်ပါ

**Dockerfile ဥပမာ**

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

## 8. Build နှင့် Launch

```bash
docker compose build
docker compose up -d openclaw-gateway
```

binary များကို စစ်ဆေးပါ-

```bash
docker compose exec openclaw-gateway which gog
docker compose exec openclaw-gateway which goplaces
docker compose exec openclaw-gateway which wacli
```

မျှော်မှန်းထားသော output-

```
/usr/local/bin/gog
/usr/local/bin/goplaces
/usr/local/bin/wacli
```

---

## 9. Gateway ကို စစ်ဆေးခြင်း

```bash
docker compose logs -f openclaw-gateway
```

အောင်မြင်ပါက-

```
[gateway] listening on ws://0.0.0.0:18789
```

သင့်လက်ပ်တော့မှ-

```bash
ssh -N -L 18789:127.0.0.1:18789 root@YOUR_VPS_IP
```

ဖွင့်ပါ-

`http://127.0.0.1:18789/`

gateway token ကို ကူးထည့်ပါ။

---

## ဘာတွေ ဘယ်နေရာမှာ သိမ်းဆည်းထားသလဲ (source of truth)

OpenClaw သည် Docker အတွင်း လည်ပတ်သော်လည်း Docker သည် source of truth မဟုတ်ပါ။
အချိန်ကြာရှည်အသုံးပြုမည့် state အားလုံးသည် restarts, rebuilds နှင့် reboots များကို ကျော်လွှားနိုင်ရပါမည်။

| Component           | Location                          | Persistence mechanism  | Notes                             |
| ------------------- | --------------------------------- | ---------------------- | --------------------------------- |
| Gateway config      | `/home/node/.openclaw/`           | Host volume mount      | `openclaw.json`၊ token များ ပါဝင် |
| Model auth profiles | `/home/node/.openclaw/`           | Host volume mount      | OAuth token များ၊ API key များ    |
| Skill configs       | `/home/node/.openclaw/skills/`    | Host volume mount      | Skill အဆင့် state                 |
| Agent workspace     | `/home/node/.openclaw/workspace/` | Host volume mount      | ကုဒ်နှင့် agent artifacts         |
| WhatsApp session    | `/home/node/.openclaw/`           | Host volume mount      | QR login ကို ထိန်းသိမ်းထားသည်     |
| Gmail keyring       | `/home/node/.openclaw/`           | Host volume + စကားဝှက် | `GOG_KEYRING_PASSWORD` လိုအပ်     |
| External binaries   | `/usr/local/bin/`                 | Docker image           | build အချိန်တွင် bake လုပ်ရမည်    |
| Node runtime        | Container filesystem              | Docker image           | image build တိုင်း ပြန်တည်ဆောက်   |
| OS packages         | Container filesystem              | Docker image           | runtime အတွင်း မထည့်သွင်းပါနှင့်  |
| Docker container    | Ephemeral                         | Restartable            | ဖျက်သိမ်းနိုင်သည်                 |
