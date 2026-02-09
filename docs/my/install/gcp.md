---
summary: "တည်တံ့ခိုင်မြဲသော state ဖြင့် GCP Compute Engine VM (Docker) ပေါ်တွင် OpenClaw Gateway ကို ၂၄/၇ လည်ပတ်စေခြင်း"
read_when:
  - GCP ပေါ်တွင် OpenClaw ကို ၂၄/၇ လည်ပတ်စေလိုပါက
  - သင့်ကိုယ်ပိုင် VM ပေါ်တွင် production-grade၊ အမြဲတမ်းလည်ပတ်နေသော Gateway တစ်ခုလိုအပ်ပါက
  - persistence၊ binaries နှင့် restart အပြုအမူများကို အပြည့်အဝ ထိန်းချုပ်လိုပါက
title: "GCP"
---

# GCP Compute Engine ပေါ်ရှိ OpenClaw (Docker, Production VPS လမ်းညွှန်)

## ရည်မှန်းချက်

Docker ကိုအသုံးပြု၍ GCP Compute Engine VM ပေါ်တွင် တည်တံ့ခိုင်မြဲသော state၊ အတွင်းထည့်သွင်းထားသော binaries နှင့် လုံခြုံစိတ်ချရသော restart အပြုအမူတို့ပါဝင်သည့် OpenClaw Gateway ကို တည်မြဲစွာ လည်ပတ်စေပါ။

"OpenClaw ကို တစ်လ ~$5–12 နဲ့ 24/7 run ချင်တယ်" ဆိုရင် Google Cloud ပေါ်မှာ ဒီ setup က ယုံကြည်စိတ်ချရပါတယ်။
စျေးနှုန်းက machine type နဲ့ region အလိုက် ကွာခြားပါတယ်; သင့် workload နဲ့ ကိုက်ညီတဲ့ အသေးဆုံး VM ကို ရွေးပြီး OOM ဖြစ်လာရင် scale up လုပ်ပါ။

## ကျွန်ုပ်တို့ ဘာလုပ်နေပါသလဲ (ရိုးရိုးရှင်းရှင်း)?

- GCP project တစ်ခုဖန်တီးပြီး billing ကို ဖွင့်ခြင်း
- Compute Engine VM တစ်ခုဖန်တီးခြင်း
- Docker ကို ထည့်သွင်းခြင်း (အထီးကျန် app runtime)
- Docker အတွင်း OpenClaw Gateway ကို စတင်လည်ပတ်ခြင်း
- ဟို့စ်ပေါ်တွင် `~/.openclaw` + `~/.openclaw/workspace` ကို သိမ်းဆည်းထားခြင်း (restart/rebuild ပြုလုပ်လည်း မပျက်စီးပါ)
- SSH tunnel ကိုအသုံးပြုပြီး သင့် laptop မှ Control UI ကို ဝင်ရောက်အသုံးပြုခြင်း

Gateway ကို အောက်ပါနည်းလမ်းများဖြင့် ဝင်ရောက်နိုင်ပါသည်—

- သင့် laptop မှ SSH port forwarding ဖြင့်
- firewall နှင့် token များကို ကိုယ်တိုင် စီမံခန့်ခွဲနိုင်ပါက port ကို တိုက်ရိုက် ဖွင့်ထားခြင်းဖြင့်

ဒီ guide က GCP Compute Engine ပေါ်မှာ Debian ကို အသုံးပြုထားပါတယ်။
Ubuntu လည်း အလုပ်လုပ်ပါတယ်; package များကို လိုက်ဖက်အောင် ပြောင်းလဲပါ။
Generic Docker flow အတွက် [Docker](/install/docker) ကို ကြည့်ပါ။

---

## Quick path (အတွေ့အကြုံရှိသော operator များအတွက်)

1. GCP project ဖန်တီးပြီး Compute Engine API ကို ဖွင့်ပါ
2. Compute Engine VM ဖန်တီးပါ (e2-small, Debian 12, 20GB)
3. VM သို့ SSH ဝင်ပါ
4. Docker ကို ထည့်သွင်းပါ
5. OpenClaw repository ကို clone လုပ်ပါ
6. persistent host directory များ ဖန်တီးပါ
7. `.env` နှင့် `docker-compose.yml` ကို ပြင်ဆင်သတ်မှတ်ပါ
8. လိုအပ်သော binaries များကို bake လုပ်ပြီး build နှင့် launch ပြုလုပ်ပါ

---

## လိုအပ်သောအရာများ

- GCP account (e2-micro အတွက် free tier အသုံးပြုနိုင်သည်)
- gcloud CLI ထည့်သွင်းထားခြင်း (သို့မဟုတ် Cloud Console ကို အသုံးပြုနိုင်သည်)
- သင့် laptop မှ SSH ဝင်ရောက်နိုင်ခြင်း
- SSH နှင့် copy/paste ကို အခြေခံအားဖြင့် အသုံးပြုနိုင်ခြင်း
- ~20-30 မိနစ်
- Docker နှင့် Docker Compose
- Model auth အတွက် အထောက်အထားများ
- ရွေးချယ်စရာ provider အထောက်အထားများ
  - WhatsApp QR
  - Telegram bot token
  - Gmail OAuth

---

## 1. gcloud CLI ကို ထည့်သွင်းခြင်း (သို့မဟုတ် Console ကို အသုံးပြုခြင်း)

**Option A: gcloud CLI** (automation အတွက် အကြံပြု)

[https://cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install) မှ ထည့်သွင်းပါ။

Initialize နှင့် authenticate ပြုလုပ်ပါ—

```bash
gcloud init
gcloud auth login
```

**Option B: Cloud Console**

အဆင့်အားလုံးကို web UI မှတစ်ဆင့် [https://console.cloud.google.com](https://console.cloud.google.com) တွင် ပြုလုပ်နိုင်ပါသည်။

---

## 2. GCP project တစ်ခု ဖန်တီးခြင်း

**CLI:**

```bash
gcloud projects create my-openclaw-project --name="OpenClaw Gateway"
gcloud config set project my-openclaw-project
```

Compute Engine ကို အသုံးပြုရန် billing ကို [https://console.cloud.google.com/billing](https://console.cloud.google.com/billing) တွင် ဖွင့်ပါ (မဖြစ်မနေလိုအပ်သည်)။

Compute Engine API ကို ဖွင့်ပါ—

```bash
gcloud services enable compute.googleapis.com
```

**Console:**

1. IAM & Admin > Create Project သို့ သွားပါ
2. အမည်ပေးပြီး ဖန်တီးပါ
3. Project အတွက် billing ကို ဖွင့်ပါ
4. APIs & Services > Enable APIs သို့ သွားပြီး “Compute Engine API” ကို ရှာကာ Enable ပြုလုပ်ပါ

---

## 3. VM ဖန်တီးခြင်း

**Machine types:**

| Type     | Specs                                       | Cost                    | Notes                      |
| -------- | ------------------------------------------- | ----------------------- | -------------------------- |
| e2-small | 2 vCPU, 2GB RAM                             | ~$12/mo | အကြံပြုထားသည်              |
| e2-micro | 2 vCPU (shared), 1GB RAM | Free tier eligible      | Load များပါက OOM ဖြစ်နိုင် |

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

1. Compute Engine > VM instances > Create instance သို့ သွားပါ
2. Name: `openclaw-gateway`
3. Region: `us-central1`, Zone: `us-central1-a`
4. Machine type: `e2-small`
5. Boot disk: Debian 12, 20GB
6. Create ကိုနှိပ်ပါ

---

## 4. VM သို့ SSH ဝင်ရောက်ခြင်း

**CLI:**

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

**Console:**

Compute Engine dashboard တွင် သင့် VM အနားရှိ “SSH” ခလုတ်ကို နှိပ်ပါ။

မှတ်ချက်: VM ဖန်တီးပြီးနောက် SSH key propagation က ၁–၂ မိနစ် ကြာနိုင်ပါတယ်။ Connection refused ဖြစ်ရင် ခဏစောင့်ပြီး ထပ်ကြိုးစားပါ။

---

## 5. Docker ကို ထည့်သွင်းခြင်း (VM ပေါ်တွင်)

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

group ပြောင်းလဲမှု အကျိုးသက်ရောက်ရန် logout ပြုလုပ်ပြီး ပြန်ဝင်ပါ—

```bash
exit
```

ထို့နောက် SSH ဖြင့် ပြန်ဝင်ပါ—

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

စစ်ဆေးပါ—

```bash
docker --version
docker compose version
```

---

## 6. OpenClaw repository ကို clone လုပ်ခြင်း

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

ဤလမ်းညွှန်သည် binary persistence ကို အာမခံရန် custom image တစ်ခု build ပြုလုပ်မည်ဟု ယူဆထားပါသည်။

---

## 7. persistent host directory များ ဖန်တီးခြင်း

Docker container များက ephemeral ဖြစ်ပါတယ်။
အချိန်ကြာရှည်အသုံးပြုမည့် state အားလုံးကို host ပေါ်တွင်သာ ထားရမည်။

```bash
mkdir -p ~/.openclaw
mkdir -p ~/.openclaw/workspace
```

---

## 8. environment variables ကို ပြင်ဆင်သတ်မှတ်ခြင်း

repository root တွင် `.env` ကို ဖန်တီးပါ။

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

ခိုင်မာသော secret များကို generate ပြုလုပ်ပါ—

```bash
openssl rand -hex 32
```

**ဤဖိုင်ကို commit မလုပ်ပါနှင့်။**

---

## 9. Docker Compose ဖွဲ့စည်းပြင်ဆင်ခြင်း

`docker-compose.yml` ကို ဖန်တီးပါ သို့မဟုတ် update ပြုလုပ်ပါ။

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

## 10. လိုအပ်သော binaries များကို image အတွင်း bake လုပ်ခြင်း (အရေးကြီး)

အလုပ်လုပ်နေတဲ့ container အတွင်း binaries ထည့်သွင်းခြင်းက အန္တရာယ်များတဲ့ လမ်းကြောင်းပါ။
runtime အတွင်း install လုပ်ထားသမျှ အရာအားလုံးသည် restart ပြုလုပ်ပါက ပျောက်ကွယ်သွားမည်ဖြစ်သည်။

Skills များမှ လိုအပ်သော external binaries အားလုံးကို image build လုပ်ချိန်တွင် ထည့်သွင်းရပါမည်။

အောက်ပါ ဥပမာများတွင် အသုံးများသော binaries သုံးခုကိုသာ ပြထားပါသည်—

- Gmail access အတွက် `gog`
- Google Places အတွက် `goplaces`
- WhatsApp အတွက် `wacli`

ဤအရာများသည် ဥပမာများသာဖြစ်ပြီး ပြည့်စုံသောစာရင်းမဟုတ်ပါ။
တူညီသော pattern ကို အသုံးပြုပြီး လိုအပ်သလောက် binaries များကို install လုပ်နိုင်ပါသည်။

နောက်ပိုင်းတွင် အခြား binaries များအပေါ် မူတည်သော skills အသစ်များ ထည့်ပါက—

1. Dockerfile ကို update ပြုလုပ်ပါ
2. image ကို rebuild ပြုလုပ်ပါ
3. containers ကို restart ပြုလုပ်ပါ

**Example Dockerfile**

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

## 11. Build နှင့် launch

```bash
docker compose build
docker compose up -d openclaw-gateway
```

binaries ကို စစ်ဆေးပါ—

```bash
docker compose exec openclaw-gateway which gog
docker compose exec openclaw-gateway which goplaces
docker compose exec openclaw-gateway which wacli
```

မျှော်မှန်းထားသော output—

```
/usr/local/bin/gog
/usr/local/bin/goplaces
/usr/local/bin/wacli
```

---

## 12. Gateway ကို အတည်ပြုခြင်း

```bash
docker compose logs -f openclaw-gateway
```

အောင်မြင်ပါက—

```
[gateway] listening on ws://0.0.0.0:18789
```

---

## 13. သင့် laptop မှ ဝင်ရောက်ခြင်း

Gateway port ကို forward လုပ်ရန် SSH tunnel တစ်ခု ဖန်တီးပါ—

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a -- -L 18789:127.0.0.1:18789
```

Browser တွင် ဖွင့်ပါ—

`http://127.0.0.1:18789/`

သင့် gateway token ကို paste လုပ်ပါ။

---

## ဘာတွေ ဘယ်မှာ သိမ်းဆည်းထားသလဲ (source of truth)

OpenClaw သည် Docker အတွင်း လည်ပတ်သော်လည်း Docker သည် source of truth မဟုတ်ပါ။
အချိန်ကြာရှည်အသုံးပြုမည့် state အားလုံးသည် restarts, rebuilds နှင့် reboots များကို ကျော်လွှားနိုင်ရပါမည်။

| Component           | Location                          | Persistence mechanism  | Notes                              |
| ------------------- | --------------------------------- | ---------------------- | ---------------------------------- |
| Gateway config      | `/home/node/.openclaw/`           | Host volume mount      | `openclaw.json`၊ tokens ပါဝင်      |
| Model auth profiles | `/home/node/.openclaw/`           | Host volume mount      | OAuth tokens၊ API keys             |
| Skill configs       | `/home/node/.openclaw/skills/`    | Host volume mount      | Skill အဆင့် state                  |
| Agent workspace     | `/home/node/.openclaw/workspace/` | Host volume mount      | Code နှင့် agent artifacts         |
| WhatsApp session    | `/home/node/.openclaw/`           | Host volume mount      | QR login ကို ထိန်းသိမ်းထားသည်      |
| Gmail keyring       | `/home/node/.openclaw/`           | Host volume + password | `GOG_KEYRING_PASSWORD` လိုအပ်      |
| External binaries   | `/usr/local/bin/`                 | Docker image           | build အချိန်တွင် bake လုပ်ရမည်     |
| Node runtime        | Container filesystem              | Docker image           | image build တိုင်း ပြန်လည်တည်ဆောက် |
| OS packages         | Container filesystem              | Docker image           | runtime အတွင်း မထည့်သွင်းပါနှင့်   |
| Docker container    | Ephemeral                         | Restartable            | ဖျက်ပစ်လည်း ဘေးကင်း                |

---

## Updates

VM ပေါ်ရှိ OpenClaw ကို update ပြုလုပ်ရန်—

```bash
cd ~/openclaw
git pull
docker compose build
docker compose up -d
```

---

## Troubleshooting

**SSH connection refused**

VM ဖန်တီးပြီးနောက် SSH key propagation အတွက် ၁–၂ မိနစ်ခန့် ကြာနိုင်ပါသည်။ စောင့်ပြီး ပြန်လည်ကြိုးစားပါ။

**OS Login ပြဿနာများ**

သင့် OS Login profile ကို စစ်ဆေးပါ—

```bash
gcloud compute os-login describe-profile
```

သင့် account တွင် လိုအပ်သော IAM permissions (Compute OS Login သို့မဟုတ် Compute OS Admin Login) ရှိကြောင်း သေချာပါစေ။

**Out of memory (OOM)**

e2-micro ကို အသုံးပြုနေပြီး OOM ဖြစ်ပါက e2-small သို့မဟုတ် e2-medium သို့ upgrade ပြုလုပ်ပါ—

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

## Service accounts (လုံခြုံရေးအကောင်းဆုံး အလေ့အကျင့်)

ကိုယ်ပိုင်အသုံးပြုမှုအတွက် default user account ကို အသုံးပြုရုံဖြင့် လုံလောက်ပါသည်။

Automation သို့မဟုတ် CI/CD pipeline များအတွက် permissions အနည်းဆုံးသာရှိသော service account တစ်ခု ဖန်တီးပါ—

1. Service account ဖန်တီးပါ—

   ```bash
   gcloud iam service-accounts create openclaw-deploy \
     --display-name="OpenClaw Deployment"
   ```

2. Compute Instance Admin role (သို့မဟုတ် ပိုကျဉ်းသော custom role) ကို ပေးပါ—

   ```bash
   gcloud projects add-iam-policy-binding my-openclaw-project \
     --member="serviceAccount:openclaw-deploy@my-openclaw-project.iam.gserviceaccount.com" \
     --role="roles/compute.instanceAdmin.v1"
   ```

automation အတွက် Owner role ကို အသုံးမပြုရန် ရှောင်ရှားပါ။ least privilege principle ကို လိုက်နာအသုံးပြုပါ။

IAM role အသေးစိတ်ကို [https://cloud.google.com/iam/docs/understanding-roles](https://cloud.google.com/iam/docs/understanding-roles) တွင် ကြည့်ရှုနိုင်ပါသည်။

---

## Next steps

- Messaging channels များကို တပ်ဆင်ပါ: [Channels](/channels)
- local device များကို node အဖြစ် ချိတ်ဆက်ပါ: [Nodes](/nodes)
- Gateway ကို ပြင်ဆင်သတ်မှတ်ပါ: [Gateway configuration](/gateway/configuration)
