---
summary: "OpenClaw အတွက် Docker အခြေခံ တပ်ဆင်ခြင်းနှင့် စတင်မိတ်ဆက်ခြင်း (ရွေးချယ်နိုင်)"
read_when:
  - ဒေသတွင်း ထည့်သွင်းမှုများအစား containerized Gateway ကို လိုအပ်ပါက
  - Docker flow ကို စစ်ဆေးအတည်ပြုလိုပါက
title: "Docker"
---

# Docker (ရွေးချယ်နိုင်)

Docker is **optional**. Use it only if you want a containerized gateway or to validate the Docker flow.

## Docker က ကိုယ့်အတွက် သင့်တော်ပါသလား?

- **ဟုတ်ကဲ့**: သီးခြားခွဲထားပြီး လွယ်ကူစွာ ဖျက်သိမ်းနိုင်သော Gateway ပတ်ဝန်းကျင်တစ်ခု လိုအပ်ပါက၊ သို့မဟုတ် ဒေသတွင်း ထည့်သွင်းမှုမရှိသော ဟို့စ်ပေါ်တွင် OpenClaw ကို chạy လိုပါက။
- **No**: you’re running on your own machine and just want the fastest dev loop. Use the normal install flow instead.
- **Sandboxing note**: agent sandboxing uses Docker too, but it does **not** require the full gateway to run in Docker. See [Sandboxing](/gateway/sandboxing).

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
- Need the URL again? Run `docker compose run --rm openclaw-cli dashboard --no-open`.

ဟို့စ်ပေါ်တွင် config/workspace ကို ရေးသားပါသည်—

- `~/.openclaw/`
- `~/.openclaw/workspace`

Running on a VPS? See [Hetzner (Docker VPS)](/install/hetzner).

### Manual flow (compose)

```bash
docker build -t openclaw:local -f Dockerfile .
docker compose run --rm openclaw-cli onboard
docker compose up -d openclaw-gateway
```

Note: run `docker compose ...` from the repo root. If you enabled
`OPENCLAW_EXTRA_MOUNTS` or `OPENCLAW_HOME_VOLUME`, the setup script writes
`docker-compose.extra.yml`; include it when running Compose elsewhere:

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

If you want to mount additional host directories into the containers, set
`OPENCLAW_EXTRA_MOUNTS` before running `docker-setup.sh`. This accepts a
comma-separated list of Docker bind mounts and applies them to both
`openclaw-gateway` and `openclaw-cli` by generating `docker-compose.extra.yml`.

ဥပမာ—

```bash
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

မှတ်ချက်များ—

- macOS/Windows တွင် Docker Desktop နှင့် shared ဖြစ်ရပါမည်။
- `OPENCLAW_EXTRA_MOUNTS` ကို ပြင်ဆင်ပါက `docker-setup.sh` ကို ပြန် chạy လုပ်၍
  extra compose file ကို ပြန်လည် ဖန်တီးပါ။
- `docker-compose.extra.yml` is generated. Don’t hand-edit it.

### Container home အပြည့်အစုံကို သိမ်းဆည်းထားရန် (ရွေးချယ်နိုင်)

If you want `/home/node` to persist across container recreation, set a named
volume via `OPENCLAW_HOME_VOLUME`. ဒါက Docker volume တစ်ခု ဖန်တီးပြီး `/home/node` မှာ mount လုပ်ပေးသလို၊ ပုံမှန် config/workspace bind mounts တွေကိုလည်း ဆက်လက် ထိန်းသိမ်းထားပါတယ်။ Use a
named volume here (not a bind path); for bind mounts, use
`OPENCLAW_EXTRA_MOUNTS`.

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

If you need system packages inside the image (for example, build tools or media
libraries), set `OPENCLAW_DOCKER_APT_PACKAGES` before running `docker-setup.sh`.
This installs the packages during the image build, so they persist even if the
container is deleted.

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

The default Docker image is **security-first** and runs as the non-root `node`
user. This keeps the attack surface small, but it means:

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

The image runs as `node` (uid 1000). If you see permission errors on
`/home/node/.openclaw`, make sure your host bind mounts are owned by uid 1000.

ဥပမာ (Linux host)—

```bash
sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
```

အဆင်ပြေမှုအတွက် root အဖြစ် chạy လုပ်ရန် ရွေးချယ်ပါက လုံခြုံရေးဆိုင်ရာ အလျော့အစားကို လက်ခံရပါမည်။

### Rebuild ကို ပိုမြန်စေရန် (အကြံပြု)

To speed up rebuilds, order your Dockerfile so dependency layers are cached.
This avoids re-running `pnpm install` unless lockfiles change:

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

If you pick OpenAI Codex OAuth in the wizard, it opens a browser URL and tries
to capture a callback on `http://127.0.0.1:1455/auth/callback`. In Docker or
headless setups that callback can show a browser error. Copy the full redirect
URL you land on and paste it back into the wizard to finish auth.

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
- Dockerfile CMD uses `--allow-unconfigured`; mounted config with `gateway.mode` not `local` will still start. Override CMD to enforce the guard.
- gateway container သည် sessions များအတွက် source of truth ဖြစ်သည် (`~/.openclaw/agents/<agentId>/sessions/`)။

## Agent Sandbox (ဟို့စ် Gateway + Docker tools)

အနက်ရှိုင်းလေ့လာရန်: [Sandboxing](/gateway/sandboxing)

### ဘာလုပ်ပေးသလဲ

When `agents.defaults.sandbox` is enabled, **non-main sessions** run tools inside a Docker
container. The gateway stays on your host, but the tool execution is isolated:

- scope: မူလအားဖြင့် `"agent"` (agent တစ်ခုလျှင် container + workspace တစ်ခု)
- scope: per-session သီးခြားခွဲထားရန် `"session"`
- per-scope workspace folder ကို `/workspace` တွင် mount လုပ်ထားသည်
- agent workspace ကို ဝင်ရောက်ခွင့် ရွေးချယ်နိုင်သည် (`agents.defaults.sandbox.workspaceAccess`)
- allow/deny tool policy (deny က အနိုင်ရ)
- inbound media များကို active sandbox workspace (`media/inbound/*`) သို့ ကူးယူထားပြီး tools များ ဖတ်နိုင်စေရန် ( `workspaceAccess: "rw"` ဖြင့် agent workspace ထဲသို့ ရောက်ပါသည်)

Warning: `scope: "shared"` disables cross-session isolation. All sessions share
one container and one workspace.

### Per-agent sandbox profiles (multi-agent)

If you use multi-agent routing, each agent can override sandbox + tool settings:
`agents.list[].sandbox` and `agents.list[].tools` (plus `agents.list[].tools.sandbox.tools`). This lets you run
mixed access levels in one gateway:

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
- `user` must be root for `apt-get` (omit `user` or set `user: "0:0"`).
  OpenClaw auto-recreates containers when `setupCommand` (or docker config) changes
  unless the container was **recently used** (within ~5 minutes). Hot containers
  log a warning with the exact `openclaw sandbox recreate ...` command.

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

This builds `openclaw-sandbox-common:bookworm-slim`. To use it:

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

This builds `openclaw-sandbox-browser:bookworm-slim` using
`Dockerfile.sandbox-browser`. The container runs Chromium with CDP enabled and
an optional noVNC observer (headful via Xvfb).

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

Remember: if you use an allowlist for tools, add `browser` (and remove it from
deny) or the tool remains blocked.
Prune rules (`agents.defaults.sandbox.prune`) apply to browser containers too.

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
- Custom tools not found: OpenClaw runs commands with `sh -lc` (login shell), which
  sources `/etc/profile` and may reset PATH. `docker.env.PATH` ကို သင့်စိတ်ကြိုက် tool path များ (ဥပမာ `/custom/bin:/usr/local/share/npm-global/bin`) ကို အရှေ့မှာထည့်ပေးအောင် သတ်မှတ်ပါ၊ သို့မဟုတ် သင့် Dockerfile ထဲတွင် `/etc/profile.d/` အောက်မှာ script တစ်ခု ထည့်ပါ။
