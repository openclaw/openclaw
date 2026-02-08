---
summary: "OpenClaw အတွက် Docker အခြေခံ တပ်ဆင်ခြင်းနှင့် စတင်မိတ်ဆက်ခြင်း (ရွေးချယ်နိုင်)"
read_when:
  - ဒေသတွင်း ထည့်သွင်းမှုများအစား containerized Gateway ကို လိုအပ်ပါက
  - Docker flow ကို စစ်ဆေးအတည်ပြုလိုပါက
title: "Docker"
x-i18n:
  source_path: install/docker.md
  source_hash: fb8c7004b18753a2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:18Z
---

# Docker (ရွေးချယ်နိုင်)

Docker သည် **မဖြစ်မနေလိုအပ်ခြင်း မရှိပါ**။ Containerized Gateway ကို လိုအပ်ပါက သို့မဟုတ် Docker flow ကို စစ်ဆေးအတည်ပြုလိုပါကသာ အသုံးပြုပါ။

## Docker က ကိုယ့်အတွက် သင့်တော်ပါသလား?

- **ဟုတ်ကဲ့**: သီးခြားခွဲထားပြီး လွယ်ကူစွာ ဖျက်သိမ်းနိုင်သော Gateway ပတ်ဝန်းကျင်တစ်ခု လိုအပ်ပါက၊ သို့မဟုတ် ဒေသတွင်း ထည့်သွင်းမှုမရှိသော ဟို့စ်ပေါ်တွင် OpenClaw ကို chạy လိုပါက။
- **မဟုတ်ပါ**: ကိုယ့်စက်ပေါ်တွင် chạy နေပြီး ဖွံ့ဖြိုးရေး လှုပ်ရှားမှုကို အမြန်ဆုံး လုပ်ချင်ပါက။ ပုံမှန် install flow ကို အသုံးပြုပါ။
- **Sandboxing မှတ်ချက်**: agent sandboxing သည် Docker ကိုလည်း အသုံးပြုပါသည်၊ သို့သော် Gateway အပြည့်အစုံကို Docker ထဲတွင် chạy ရန် **မလိုအပ်ပါ**။ [Sandboxing](/gateway/sandboxing) ကို ကြည့်ပါ။

ဤလမ်းညွှန်တွင် အောက်ပါအရာများကို ဖော်ပြထားပါသည်—

- Containerized Gateway (Docker ထဲတွင် OpenClaw အပြည့်အစုံ)
- Per-session Agent Sandbox (ဟို့စ် Gateway + Docker ဖြင့် သီးခြားခွဲထားသော agent tools)

Sandboxing အသေးစိတ်: [Sandboxing](/gateway/sandboxing)

## လိုအပ်ချက်များ

- Docker Desktop (သို့မဟုတ် Docker Engine) + Docker Compose v2
- image များနှင့် log များအတွက် လုံလောက်သော disk နေရာ

## Containerized Gateway (Docker Compose)

### Quick start (အကြံပြု)

repo root မှ—

```bash
./docker-setup.sh
```

ဤ script သည်—

- gateway image ကို build လုပ်သည်
- onboarding wizard ကို chạy သည်
- provider setup အတွက် ရွေးချယ်နိုင်သော အကြံပြုချက်များကို ပြသသည်
- Docker Compose ဖြင့် gateway ကို စတင် chạy သည်
- gateway token ကို ဖန်တီးပြီး `.env` သို့ ရေးသားသည်

ရွေးချယ်နိုင်သော env vars—

- `OPENCLAW_DOCKER_APT_PACKAGES` — build အချိန်တွင် extra apt packages များကို ထည့်သွင်းရန်
- `OPENCLAW_EXTRA_MOUNTS` — extra host bind mounts များ ထည့်ရန်
- `OPENCLAW_HOME_VOLUME` — `/home/node` ကို named volume တွင် သိမ်းဆည်းထားရန်

ပြီးဆုံးပြီးနောက်—

- browser တွင် `http://127.0.0.1:18789/` ကို ဖွင့်ပါ။
- Control UI (Settings → token) ထဲသို့ token ကို ကူးထည့်ပါ။
- URL ကို ပြန်လိုပါသလား? `docker compose run --rm openclaw-cli dashboard --no-open` ကို chạy ပါ။

ဟို့စ်ပေါ်တွင် config/workspace ကို ရေးသားပါသည်—

- `~/.openclaw/`
- `~/.openclaw/workspace`

VPS ပေါ်တွင် chạy နေပါသလား? [Hetzner (Docker VPS)](/install/hetzner) ကို ကြည့်ပါ။

### Manual flow (compose)

```bash
docker build -t openclaw:local -f Dockerfile .
docker compose run --rm openclaw-cli onboard
docker compose up -d openclaw-gateway
```

မှတ်ချက်: repo root မှ `docker compose ...` ကို chạy ပါ။ အကယ်၍
`OPENCLAW_EXTRA_MOUNTS` သို့မဟုတ် `OPENCLAW_HOME_VOLUME` ကို ဖွင့်ထားပါက setup script သည်
`docker-compose.extra.yml` ကို ရေးသားပါသည်; Compose ကို အခြားနေရာတွင် chạy မည်ဆိုပါက ထည့်သွင်းအသုံးပြုပါ—

```bash
docker compose -f docker-compose.yml -f docker-compose.extra.yml <command>
```

### Control UI token + pairing (Docker)

“unauthorized” သို့မဟုတ် “disconnected (1008): pairing required” ကို တွေ့ပါက
dashboard link အသစ်တစ်ခုကို ယူပြီး browser device ကို အတည်ပြုပါ—

```bash
docker compose run --rm openclaw-cli dashboard --no-open
docker compose run --rm openclaw-cli devices list
docker compose run --rm openclaw-cli devices approve <requestId>
```

အသေးစိတ်: [Dashboard](/web/dashboard), [Devices](/cli/devices)

### Extra mounts (ရွေးချယ်နိုင်)

containers ထဲသို့ host directory များကို ထပ်မံ mount လုပ်လိုပါက
`OPENCLAW_EXTRA_MOUNTS` ကို `docker-setup.sh` မ chạy မီ သတ်မှတ်ပါ။ ၎င်းသည် Docker bind mounts များကို comma ဖြင့် ခွဲထားသော စာရင်းအဖြစ် လက်ခံပြီး
`openclaw-gateway` နှင့် `openclaw-cli` နှစ်ခုစလုံးအတွက်
`docker-compose.extra.yml` ကို ဖန်တီးခြင်းဖြင့် အသုံးချပါသည်။

ဥပမာ—

```bash
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

မှတ်ချက်များ—

- macOS/Windows တွင် Docker Desktop နှင့် shared ဖြစ်ရပါမည်။
- `OPENCLAW_EXTRA_MOUNTS` ကို ပြင်ဆင်ပါက `docker-setup.sh` ကို ပြန် chạy လုပ်၍
  extra compose file ကို ပြန်လည် ဖန်တီးပါ။
- `docker-compose.extra.yml` သည် အလိုအလျောက် ဖန်တီးထားသည်။ ကိုယ်တိုင် မပြင်ပါနှင့်။

### Container home အပြည့်အစုံကို သိမ်းဆည်းထားရန် (ရွေးချယ်နိုင်)

container ကို ပြန်ဖန်တီးသည့်အခါ `/home/node` ကို ဆက်လက် ထိန်းသိမ်းလိုပါက
`OPENCLAW_HOME_VOLUME` ဖြင့် named volume တစ်ခု သတ်မှတ်ပါ။ ၎င်းသည် Docker volume ကို ဖန်တီးပြီး
`/home/node` တွင် mount လုပ်ကာ standard config/workspace bind mounts များကို ထိန်းထားပါသည်။ ဒီနေရာတွင် named volume ကို အသုံးပြုပါ (bind path မဟုတ်ပါ); bind mounts အတွက်
`OPENCLAW_EXTRA_MOUNTS` ကို အသုံးပြုပါ။

ဥပမာ—

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

extra mounts များနှင့် တွဲဖက်အသုံးပြုနိုင်ပါသည်—

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

မှတ်ချက်များ—

- `OPENCLAW_HOME_VOLUME` ကို ပြောင်းလဲပါက `docker-setup.sh` ကို ပြန် chạy လုပ်၍
  extra compose file ကို ပြန်လည် ဖန်တီးပါ။
- named volume သည် `docker volume rm <name>` ဖြင့် ဖယ်ရှားမချင်း ဆက်လက် ရှိနေပါမည်။

### Extra apt packages များ ထည့်သွင်းရန် (ရွေးချယ်နိုင်)

image အတွင်းတွင် system packages များ (ဥပမာ build tools သို့မဟုတ် media libraries) လိုအပ်ပါက
`OPENCLAW_DOCKER_APT_PACKAGES` ကို `docker-setup.sh` မ chạy မီ သတ်မှတ်ပါ။
၎င်းသည် image build အချိန်တွင် packages များကို ထည့်သွင်းပေးပြီး container ကို ဖျက်လိုက်သော်လည်း ဆက်လက် ရှိနေပါမည်။

ဥပမာ—

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg build-essential"
./docker-setup.sh
```

မှတ်ချက်များ—

- apt package အမည်များကို space ဖြင့် ခွဲထားသော စာရင်းကို လက်ခံပါသည်။
- `OPENCLAW_DOCKER_APT_PACKAGES` ကို ပြောင်းလဲပါက image ကို ပြန် build လုပ်ရန်
  `docker-setup.sh` ကို chạy ပါ။

### Power-user / feature အပြည့်အစုံပါသော container (opt-in)

မူလ Docker image သည် **လုံခြုံရေးကို ဦးစားပေး** ထားပြီး non-root `node`
user အဖြစ် chạy ပါသည်။ ၎င်းကြောင့် attack surface သေးငယ်သော်လည်း—

- runtime တွင် system package များ ထည့်သွင်း၍ မရပါ
- မူလအနေဖြင့် Homebrew မပါဝင်ပါ
- Chromium/Playwright browsers များ မပါဝင်ပါ

feature အပြည့်အစုံပါသော container ကို လိုအပ်ပါက အောက်ပါ opt-in knobs များကို အသုံးပြုပါ—

1. **`/home/node` ကို သိမ်းဆည်းထားပါ** — browser downloads နှင့် tool caches များ မပျောက်စေရန်—

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

2. **system deps များကို image ထဲတွင် bake လုပ်ပါ** (ပြန်လုပ်လို့ရ + တည်မြဲ)—

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="git curl jq"
./docker-setup.sh
```

3. **`npx` မသုံးဘဲ Playwright browsers များ ထည့်သွင်းပါ** (npm override conflicts ကို ရှောင်ရှားရန်)—

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

Playwright ကို system deps များ ထည့်သွင်းစေလိုပါက runtime တွင်
`--with-deps` ကို မသုံးဘဲ image ကို
`OPENCLAW_DOCKER_APT_PACKAGES` ဖြင့် ပြန် build လုပ်ပါ။

4. **Playwright browser downloads များကို သိမ်းဆည်းထားရန်**—

- `docker-compose.yml` တွင် `PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright` ကို သတ်မှတ်ပါ။
- `/home/node` ကို `OPENCLAW_HOME_VOLUME` ဖြင့် ဆက်လက် ထိန်းသိမ်းထားပါ၊ သို့မဟုတ်
  `/home/node/.cache/ms-playwright` ကို `OPENCLAW_EXTRA_MOUNTS` ဖြင့် mount လုပ်ပါ။

### Permissions + EACCES

image သည် `node` (uid 1000) အဖြစ် chạy ပါသည်။
`/home/node/.openclaw` တွင် permission error များ တွေ့ပါက
host bind mounts များကို uid 1000 ပိုင်ဆိုင်ထားကြောင်း သေချာပါစေ။

ဥပမာ (Linux host)—

```bash
sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
```

အဆင်ပြေမှုအတွက် root အဖြစ် chạy လုပ်ရန် ရွေးချယ်ပါက လုံခြုံရေးဆိုင်ရာ အလျော့အစားကို လက်ခံရပါမည်။

### Rebuild ကို ပိုမြန်စေရန် (အကြံပြု)

rebuild များကို မြန်ဆန်စေရန် Dockerfile ကို dependency layers များ cache ဖြစ်အောင် အစီအစဉ်ချထားပါ။
၎င်းဖြင့် lockfiles မပြောင်းလဲမချင်း `pnpm install` ကို ပြန် chạy မလုပ်ရပါ—

```dockerfile
FROM node:22-bookworm

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

# Cache dependencies unless package metadata changes
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN pnpm ui:install
RUN pnpm ui:build

ENV NODE_ENV=production

CMD ["node","dist/index.js"]
```

### Channel setup (ရွေးချယ်နိုင်)

CLI container ကို အသုံးပြု၍ channel များကို ပြင်ဆင်ပြီး လိုအပ်ပါက gateway ကို ပြန်စတင်ပါ။

WhatsApp (QR)—

```bash
docker compose run --rm openclaw-cli channels login
```

Telegram (bot token)—

```bash
docker compose run --rm openclaw-cli channels add --channel telegram --token "<token>"
```

Discord (bot token)—

```bash
docker compose run --rm openclaw-cli channels add --channel discord --token "<token>"
```

Docs: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord)

### OpenAI Codex OAuth (headless Docker)

wizard တွင် OpenAI Codex OAuth ကို ရွေးချယ်ပါက browser URL တစ်ခုကို ဖွင့်ပြီး
`http://127.0.0.1:1455/auth/callback` တွင် callback ကို ဖမ်းယူရန် ကြိုးပမ်းပါသည်။
Docker သို့မဟုတ် headless setup များတွင် ထို callback သည် browser error ပြနိုင်ပါသည်။
ရောက်ရှိသွားသော redirect URL အပြည့်အစုံကို ကူးယူပြီး wizard ထဲသို့ ပြန်ကူးထည့်၍ auth ကို အပြီးသတ်ပါ။

### Health check

```bash
docker compose exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

### E2E smoke test (Docker)

```bash
scripts/e2e/onboard-docker.sh
```

### QR import smoke test (Docker)

```bash
pnpm test:docker:qr
```

### မှတ်ချက်များ

- container အသုံးပြုရန် Gateway bind သည် မူလအားဖြင့် `lan` ဖြစ်သည်။
- Dockerfile CMD သည် `--allow-unconfigured` ကို အသုံးပြုသည်; `gateway.mode` ဖြင့် mount လုပ်ထားသော config သည် `local` မရှိသော်လည်း စတင် chạy ပါမည်။ guard ကို အတင်းအကျပ် ချမှတ်လိုပါက CMD ကို override လုပ်ပါ။
- gateway container သည် sessions များအတွက် source of truth ဖြစ်သည် (`~/.openclaw/agents/<agentId>/sessions/`)။

## Agent Sandbox (ဟို့စ် Gateway + Docker tools)

အနက်ရှိုင်းလေ့လာရန်: [Sandboxing](/gateway/sandboxing)

### ဘာလုပ်ပေးသလဲ

`agents.defaults.sandbox` ကို ဖွင့်ထားပါက **main မဟုတ်သော sessions** များသည် Docker
container အတွင်းတွင် tools များကို chạy ပါသည်။ Gateway သည် ဟို့စ်ပေါ်တွင် ဆက်လက် chạy နေပြီး tool execution ကို သီးခြားခွဲထားပါသည်—

- scope: မူလအားဖြင့် `"agent"` (agent တစ်ခုလျှင် container + workspace တစ်ခု)
- scope: per-session သီးခြားခွဲထားရန် `"session"`
- per-scope workspace folder ကို `/workspace` တွင် mount လုပ်ထားသည်
- agent workspace ကို ဝင်ရောက်ခွင့် ရွေးချယ်နိုင်သည် (`agents.defaults.sandbox.workspaceAccess`)
- allow/deny tool policy (deny က အနိုင်ရ)
- inbound media များကို active sandbox workspace (`media/inbound/*`) သို့ ကူးယူထားပြီး tools များ ဖတ်နိုင်စေရန် ( `workspaceAccess: "rw"` ဖြင့် agent workspace ထဲသို့ ရောက်ပါသည်)

သတိပေးချက်: `scope: "shared"` သည် cross-session isolation ကို ပိတ်ပင်ပါသည်။
sessions အားလုံးသည် container တစ်ခုနှင့် workspace တစ်ခုကို မျှဝေပါသည်။

### Per-agent sandbox profiles (multi-agent)

multi-agent routing ကို အသုံးပြုပါက agent တစ်ခုချင်းစီသည် sandbox + tool settings များကို
`agents.list[].sandbox` နှင့် `agents.list[].tools` (အပြင် `agents.list[].tools.sandbox.tools`) ဖြင့် override လုပ်နိုင်ပါသည်။
Gateway တစ်ခုအတွင်း access level မတူညီသော အခြေအနေများကို chạy လုပ်နိုင်ပါသည်—

- Full access (ပုဂ္ဂိုလ်ရေး agent)
- Read-only tools + read-only workspace (မိသားစု/အလုပ် agent)
- Filesystem/shell tools မရှိ (public agent)

ဥပမာများ၊ precedence နှင့် troubleshooting အတွက်
[Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) ကို ကြည့်ပါ။

### Default behavior

- Image: `openclaw-sandbox:bookworm-slim`
- Agent တစ်ခုလျှင် container တစ်ခု
- Agent workspace access: မူလ `workspaceAccess: "none"` သည် `~/.openclaw/sandboxes` ကို အသုံးပြုသည်
  - `"ro"` သည် sandbox workspace ကို `/workspace` တွင် ထားပြီး agent workspace ကို `/agent` တွင် read-only အဖြစ် mount လုပ်သည် (`write`/`edit`/`apply_patch` ကို ပိတ်ထားသည်)
  - `"rw"` သည် agent workspace ကို `/workspace` တွင် read/write အဖြစ် mount လုပ်သည်
- Auto-prune: idle > 24 နာရီ သို့မဟုတ် age > 7 ရက်
- Network: မူလအားဖြင့် `none` (egress လိုအပ်ပါက ထင်ရှားစွာ opt-in လုပ်ပါ)
- Default allow: `exec`, `process`, `read`, `write`, `edit`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- Default deny: `browser`, `canvas`, `nodes`, `cron`, `discord`, `gateway`

### Sandboxing ကို ဖွင့်ရန်

`setupCommand` ထဲတွင် packages များ ထည့်သွင်းရန် စီစဉ်ထားပါက အောက်ပါအချက်များကို သတိပြုပါ—

- မူလ `docker.network` သည် `"none"` ဖြစ်သည် (egress မရှိ)။
- `readOnlyRoot: true` သည် package ထည့်သွင်းမှုကို ပိတ်ဆို့ပါသည်။
- `user` သည် `apt-get` အတွက် root ဖြစ်ရပါမည် (`user` ကို ချန်ထားပါ သို့မဟုတ် `user: "0:0"` ကို သတ်မှတ်ပါ)။
  OpenClaw သည် `setupCommand` (သို့မဟုတ် docker config) ပြောင်းလဲသည့်အခါ container များကို အလိုအလျောက် ပြန်ဖန်တီးပါသည်၊ သို့သော် container ကို **မကြာသေးမီက အသုံးပြုထားပါက** (~၅ မိနစ်အတွင်း) မပြန်ဖန်တီးပါ။
  Hot containers များသည် တိကျသော `openclaw sandbox recreate ...` command ဖြင့် warning ကို log ထုတ်ပါသည်။

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        scope: "agent", // session | agent | shared (agent is default)
        workspaceAccess: "none", // none | ro | rw
        workspaceRoot: "~/.openclaw/sandboxes",
        docker: {
          image: "openclaw-sandbox:bookworm-slim",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: ["/tmp", "/var/tmp", "/run"],
          network: "none",
          user: "1000:1000",
          capDrop: ["ALL"],
          env: { LANG: "C.UTF-8" },
          setupCommand: "apt-get update && apt-get install -y git curl jq",
          pidsLimit: 256,
          memory: "1g",
          memorySwap: "2g",
          cpus: 1,
          ulimits: {
            nofile: { soft: 1024, hard: 2048 },
            nproc: 256,
          },
          seccompProfile: "/path/to/seccomp.json",
          apparmorProfile: "openclaw-sandbox",
          dns: ["1.1.1.1", "8.8.8.8"],
          extraHosts: ["internal.service:10.0.0.5"],
        },
        prune: {
          idleHours: 24, // 0 disables idle pruning
          maxAgeDays: 7, // 0 disables max-age pruning
        },
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        allow: [
          "exec",
          "process",
          "read",
          "write",
          "edit",
          "sessions_list",
          "sessions_history",
          "sessions_send",
          "sessions_spawn",
          "session_status",
        ],
        deny: ["browser", "canvas", "nodes", "cron", "discord", "gateway"],
      },
    },
  },
}
```

Hardening knobs များသည် `agents.defaults.sandbox.docker` အောက်တွင် ရှိပါသည်—
`network`, `user`, `pidsLimit`, `memory`, `memorySwap`, `cpus`, `ulimits`,
`seccompProfile`, `apparmorProfile`, `dns`, `extraHosts`။

Multi-agent: agent တစ်ခုချင်းစီအတွက် `agents.list[].sandbox.{docker,browser,prune}.*` ဖြင့် `agents.defaults.sandbox.{docker,browser,prune}.*` ကို override လုပ်နိုင်ပါသည်
(`agents.defaults.sandbox.scope` / `agents.list[].sandbox.scope` သည် `"shared"` ဖြစ်ပါက လျစ်လျူရှုပါသည်)။

### Default sandbox image ကို build လုပ်ရန်

```bash
scripts/sandbox-setup.sh
```

၎င်းသည် `Dockerfile.sandbox` ကို အသုံးပြု၍ `openclaw-sandbox:bookworm-slim` ကို build လုပ်ပါသည်။

### Sandbox common image (ရွေးချယ်နိုင်)

Node, Go, Rust စသည့် common build tooling ပါသော sandbox image ကို လိုအပ်ပါက common image ကို build လုပ်ပါ—

```bash
scripts/sandbox-common-setup.sh
```

၎င်းသည် `openclaw-sandbox-common:bookworm-slim` ကို build လုပ်ပါသည်။ အသုံးပြုရန်—

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "openclaw-sandbox-common:bookworm-slim" } },
    },
  },
}
```

### Sandbox browser image

sandbox အတွင်း browser tool ကို chạy လုပ်ရန် browser image ကို build လုပ်ပါ—

```bash
scripts/sandbox-browser-setup.sh
```

၎င်းသည် `Dockerfile.sandbox-browser` ကို အသုံးပြု၍ `openclaw-sandbox-browser:bookworm-slim` ကို build လုပ်ပါသည်။
container သည် CDP ဖွင့်ထားသော Chromium ကို chạy လုပ်ပြီး
ရွေးချယ်နိုင်သော noVNC observer (Xvfb ဖြင့် headful) ပါဝင်ပါသည်။

မှတ်ချက်များ—

- Headful (Xvfb) သည် headless ထက် bot blocking ကို လျော့ချပေးသည်။
- `agents.defaults.sandbox.browser.headless=true` ကို သတ်မှတ်ခြင်းဖြင့် headless ကို ဆက်လက် အသုံးပြုနိုင်ပါသည်။
- Desktop environment (GNOME) အပြည့်အစုံ မလိုအပ်ပါ; Xvfb သည် display ကို ပံ့ပိုးပေးပါသည်။

config အသုံးပြုရန်—

```json5
{
  agents: {
    defaults: {
      sandbox: {
        browser: { enabled: true },
      },
    },
  },
}
```

Custom browser image—

```json5
{
  agents: {
    defaults: {
      sandbox: { browser: { image: "my-openclaw-browser" } },
    },
  },
}
```

ဖွင့်ထားပါက agent သည် အောက်ပါအရာများကို ရရှိပါသည်—

- sandbox browser control URL ( `browser` tool အတွက်)
- noVNC URL (ဖွင့်ထားပြီး headless=false ဖြစ်ပါက)

သတိပြုရန်: tools အတွက် allowlist ကို အသုံးပြုပါက `browser` ကို ထည့်သွင်းပြီး
deny မှ ဖယ်ရှားပါ၊ မဟုတ်ပါက tool သည် ဆက်လက် ပိတ်ထားပါမည်။
Prune rules (`agents.defaults.sandbox.prune`) သည် browser containers များအတွက်လည်း သက်ရောက်ပါသည်။

### Custom sandbox image

ကိုယ်ပိုင် image ကို build လုပ်ပြီး config ကို ညွှန်ပြပါ—

```bash
docker build -t my-openclaw-sbx -f Dockerfile.sandbox .
```

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "my-openclaw-sbx" } },
    },
  },
}
```

### Tool policy (allow/deny)

- `deny` သည် `allow` ကို အနိုင်ယူပါသည်။
- `allow` ဗလာဖြစ်ပါက: deny မှ လွဲ၍ tools အားလုံး အသုံးပြုနိုင်ပါသည်။
- `allow` ဗလာမဟုတ်ပါက: `allow` ထဲရှိ tools များသာ အသုံးပြုနိုင်ပါသည် (deny ကို လျှော့ချပြီးနောက်)။

### Pruning strategy

knobs နှစ်ခု—

- `prune.idleHours`: X နာရီ မအသုံးပြုထားသော containers များကို ဖယ်ရှားရန် (0 = ပိတ်)
- `prune.maxAgeDays`: X ရက်ထက် အရွယ်ကြီးသော containers များကို ဖယ်ရှားရန် (0 = ပိတ်)

ဥပမာ—

- အလုပ်များနေသော sessions များကို ထိန်းထားပြီး သက်တမ်းကို ကန့်သတ်ရန်—
  `idleHours: 24`, `maxAgeDays: 7`
- မည်သည့်အခါမျှ prune မလုပ်ရန်—
  `idleHours: 0`, `maxAgeDays: 0`

### လုံခြုံရေး မှတ်ချက်များ

- Hard wall သည် **tools** (exec/read/write/edit/apply_patch) များအတွက်သာ သက်ရောက်ပါသည်။
- browser/camera/canvas ကဲ့သို့ ဟို့စ်သာမက tools များကို မူလအားဖြင့် ပိတ်ထားပါသည်။
- sandbox အတွင်း `browser` ကို ခွင့်ပြုပါက **isolation ပျက်ကွက်ပါသည်** (browser သည် ဟို့စ်ပေါ်တွင် chạy ပါသည်)။

## Troubleshooting

- Image မရှိပါက: [`scripts/sandbox-setup.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/sandbox-setup.sh) ဖြင့် build လုပ်ပါ သို့မဟုတ် `agents.defaults.sandbox.docker.image` ကို သတ်မှတ်ပါ။
- Container မ chạy ပါက: session လိုအပ်သည့်အခါ အလိုအလျောက် ဖန်တီးပါမည်။
- Sandbox အတွင်း permission error များ: mount လုပ်ထားသော workspace ပိုင်ဆိုင်မှုနှင့် ကိုက်ညီသော UID:GID သို့ `docker.user` ကို သတ်မှတ်ပါ (သို့မဟုတ် workspace folder ကို chown လုပ်ပါ)။
- Custom tools မတွေ့ပါက: OpenClaw သည် commands များကို `sh -lc` (login shell) ဖြင့် chạy ပါသည်၊ ၎င်းသည် `/etc/profile` ကို source လုပ်ပြီး PATH ကို ပြန်သတ်မှတ်နိုင်ပါသည်။ ကိုယ်ပိုင် tool paths များကို ရှေ့တွင် ထည့်ရန် `docker.env.PATH` ကို သတ်မှတ်ပါ (ဥပမာ `/custom/bin:/usr/local/share/npm-global/bin`)၊ သို့မဟုတ် Dockerfile ထဲတွင် `/etc/profile.d/` အောက်၌ script တစ်ခု ထည့်ပါ။
