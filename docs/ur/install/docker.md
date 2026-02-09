---
summary: "OpenClaw کے لیے اختیاری Docker پر مبنی سیٹ اپ اور آن بورڈنگ"
read_when:
  - آپ مقامی انسٹالیشن کے بجائے کنٹینرائزڈ گیٹ وے چاہتے ہیں
  - آپ Docker فلو کی توثیق کر رہے ہیں
title: "Docker"
---

# Docker (اختیاری)

Docker is **optional**. Use it only if you want a containerized gateway or to validate the Docker flow.

## کیا Docker میرے لیے درست ہے؟

- **ہاں**: آپ ایک علیحدہ، وقتی گیٹ وے ماحول چاہتے ہیں یا ایسے ہوسٹ پر OpenClaw چلانا چاہتے ہیں جہاں مقامی انسٹالیشن ممکن نہ ہو۔
- 40. **نہیں**: آپ اپنی مشین پر چلا رہے ہیں اور صرف تیز ترین dev loop چاہتے ہیں۔ Use the normal install flow instead.
- **Sandboxing note**: agent sandboxing uses Docker too, but it does **not** require the full gateway to run in Docker. See [Sandboxing](/gateway/sandboxing).

یہ رہنما شامل کرتا ہے:

- کنٹینرائزڈ Gateway (Docker میں مکمل OpenClaw)
- فی سیشن Agent Sandbox (ہوسٹ گیٹ وے + Docker میں علیحدہ ایجنٹ ٹولز)

Sandboxing کی تفصیلات: [Sandboxing](/gateway/sandboxing)

## ضروریات

- Docker Desktop (یا Docker Engine) + Docker Compose v2
- امیجز + لاگز کے لیے مناسب ڈسک اسپیس

## کنٹینرائزڈ Gateway (Docker Compose)

### فوری آغاز (سفارش کردہ)

ریپو کی روٹ سے:

```bash
./docker-setup.sh
```

یہ اسکرپٹ:

- گیٹ وے امیج بناتا ہے
- آن بورڈنگ وزارڈ چلاتا ہے
- اختیاری فراہم کنندہ سیٹ اپ کے اشارے پرنٹ کرتا ہے
- Docker Compose کے ذریعے گیٹ وے شروع کرتا ہے
- ایک گیٹ وے ٹوکن بناتا ہے اور اسے `.env` میں لکھتا ہے

اختیاری env vars:

- `OPENCLAW_DOCKER_APT_PACKAGES` — بلڈ کے دوران اضافی apt پیکجز انسٹال کریں
- `OPENCLAW_EXTRA_MOUNTS` — اضافی ہوسٹ bind mounts شامل کریں
- `OPENCLAW_HOME_VOLUME` — نامزد والیوم میں `/home/node` کو برقرار رکھیں

مکمل ہونے کے بعد:

- اپنے براؤزر میں `http://127.0.0.1:18789/` کھولیں۔
- کنٹرول UI میں ٹوکن پیسٹ کریں (Settings → token)۔
- 41. URL دوبارہ چاہیے؟ Run `docker compose run --rm openclaw-cli dashboard --no-open`.

یہ ہوسٹ پر کنفیگ/ورک اسپیس لکھتا ہے:

- `~/.openclaw/`
- `~/.openclaw/workspace`

Running on a VPS? See [Hetzner (Docker VPS)](/install/hetzner).

### دستی فلو (compose)

```bash
docker build -t openclaw:local -f Dockerfile .
docker compose run --rm openclaw-cli onboard
docker compose up -d openclaw-gateway
```

42. نوٹ: `docker compose ...` کو repo root سے چلائیں۔ If you enabled
    `OPENCLAW_EXTRA_MOUNTS` or `OPENCLAW_HOME_VOLUME`, the setup script writes
    `docker-compose.extra.yml`; include it when running Compose elsewhere:

```bash
docker compose -f docker-compose.yml -f docker-compose.extra.yml <command>
```

### کنٹرول UI ٹوکن + pairing (Docker)

اگر آپ کو “unauthorized” یا “disconnected (1008): pairing required” نظر آئے، تو
نیا ڈیش بورڈ لنک حاصل کریں اور براؤزر ڈیوائس کی منظوری دیں:

```bash
docker compose run --rm openclaw-cli dashboard --no-open
docker compose run --rm openclaw-cli devices list
docker compose run --rm openclaw-cli devices approve <requestId>
```

مزید تفصیل: [Dashboard](/web/dashboard)، [Devices](/cli/devices)۔

### اضافی mounts (اختیاری)

If you want to mount additional host directories into the containers, set
`OPENCLAW_EXTRA_MOUNTS` before running `docker-setup.sh`. یہ Docker bind mounts کی comma-separated فہرست قبول کرتا ہے اور `docker-compose.extra.yml` بنا کر انہیں `openclaw-gateway` اور `openclaw-cli` دونوں پر لاگو کرتا ہے۔

مثال:

```bash
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

نوٹس:

- macOS/Windows پر راستے Docker Desktop کے ساتھ شیئر ہونے چاہییں۔
- اگر آپ `OPENCLAW_EXTRA_MOUNTS` میں ترمیم کریں، تو اضافی compose فائل دوبارہ بنانے کے لیے `docker-setup.sh` چلائیں۔
- `docker-compose.extra.yml` تیار کیا جاتا ہے۔ اسے ہاتھ سے ایڈٹ مت کریں۔

### پورے کنٹینر ہوم کو برقرار رکھیں (اختیاری)

اگر آپ چاہتے ہیں کہ `/home/node` کنٹینر کو دوبارہ بنانے پر برقرار رہے، تو `OPENCLAW_HOME_VOLUME` کے ذریعے ایک named volume سیٹ کریں۔ یہ ایک Docker volume بناتا ہے اور اسے `/home/node` پر ماؤنٹ کرتا ہے، جبکہ معیاری config/workspace bind mounts برقرار رکھتا ہے۔ یہاں named volume استعمال کریں (bind path نہیں)؛ bind mounts کے لیے `OPENCLAW_EXTRA_MOUNTS` استعمال کریں۔

مثال:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

آپ اسے اضافی mounts کے ساتھ ملا سکتے ہیں:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

نوٹس:

- اگر آپ `OPENCLAW_HOME_VOLUME` تبدیل کریں، تو اضافی compose فائل دوبارہ بنانے کے لیے `docker-setup.sh` چلائیں۔
- نامزد والیوم `docker volume rm <name>` کے ذریعے ہٹانے تک برقرار رہتا ہے۔

### اضافی apt پیکجز انسٹال کریں (اختیاری)

43. اگر آپ کو امیج کے اندر سسٹم پیکجز درکار ہوں (مثلاً build tools یا میڈیا لائبریریز)، تو `docker-setup.sh` چلانے سے پہلے `OPENCLAW_DOCKER_APT_PACKAGES` سیٹ کریں۔
    یہ امیج build کے دوران پیکجز انسٹال کرتا ہے، اس لیے کنٹینر حذف ہونے پر بھی یہ برقرار رہتے ہیں۔

مثال:

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg build-essential"
./docker-setup.sh
```

نوٹس:

- یہ apt پیکج ناموں کی اسپیس سے جدا فہرست قبول کرتا ہے۔
- اگر آپ `OPENCLAW_DOCKER_APT_PACKAGES` تبدیل کریں، تو امیج دوبارہ بنانے کے لیے `docker-setup.sh` چلائیں۔

### پاور یوزر / مکمل خصوصیات والا کنٹینر (آپشنل)

ڈیفالٹ Docker امیج **security-first** ہے اور non-root `node` یوزر کے طور پر چلتی ہے۔ 44. اس سے attack surface چھوٹا رہتا ہے، لیکن اس کا مطلب یہ ہے:

- رَن ٹائم پر سسٹم پیکجز انسٹال نہیں ہو سکتے
- بطورِ طے شدہ Homebrew نہیں
- بنڈل شدہ Chromium/Playwright براؤزرز نہیں

اگر آپ زیادہ مکمل خصوصیات والا کنٹینر چاہتے ہیں، تو یہ آپشنل کنٹرولز استعمال کریں:

1. **`/home/node` کو برقرار رکھیں** تاکہ براؤزر ڈاؤن لوڈز اور ٹول کیشز محفوظ رہیں:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

2. **سسٹم ڈیپس امیج میں شامل کریں** (قابلِ تکرار + مستقل):

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="git curl jq"
./docker-setup.sh
```

3. **`npx` کے بغیر Playwright براؤزرز انسٹال کریں** (npm اوور رائیڈ تنازعات سے بچاؤ):

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

اگر Playwright کو سسٹم ڈیپس انسٹال کرنے کی ضرورت ہو، تو رَن ٹائم پر `--with-deps` استعمال کرنے کے بجائے
`OPENCLAW_DOCKER_APT_PACKAGES` کے ساتھ امیج دوبارہ بنائیں۔

4. **Playwright براؤزر ڈاؤن لوڈز کو برقرار رکھیں**:

- `docker-compose.yml` میں `PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright` سیٹ کریں۔
- یقینی بنائیں کہ `/home/node`، `OPENCLAW_HOME_VOLUME` کے ذریعے برقرار رہے، یا
  `/home/node/.cache/ms-playwright` کو `OPENCLAW_EXTRA_MOUNTS` کے ذریعے ماؤنٹ کریں۔

### اجازتیں + EACCES

امیج `node` (uid 1000) کے طور پر چلتی ہے۔ اگر آپ کو `/home/node/.openclaw` پر permission errors نظر آئیں، تو یقینی بنائیں کہ آپ کے host bind mounts uid 1000 کے مالک ہوں۔

مثال (Linux ہوسٹ):

```bash
sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
```

اگر آپ سہولت کے لیے روٹ کے طور پر چلانے کا انتخاب کرتے ہیں، تو آپ سکیورٹی کے سمجھوتے کو قبول کرتے ہیں۔

### تیز تر ری بلڈز (سفارش کردہ)

45. rebuilds کو تیز کرنے کے لیے اپنے Dockerfile کو اس طرح ترتیب دیں کہ dependency layers کیش ہو سکیں۔
46. اس سے `pnpm install` دوبارہ نہیں چلتا جب تک lockfiles تبدیل نہ ہوں:

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

### چینل سیٹ اپ (اختیاری)

چینلز کنفیگر کرنے کے لیے CLI کنٹینر استعمال کریں، پھر ضرورت ہو تو گیٹ وے ری اسٹارٹ کریں۔

WhatsApp (QR):

```bash
docker compose run --rm openclaw-cli channels login
```

Telegram (بوٹ ٹوکن):

```bash
docker compose run --rm openclaw-cli channels add --channel telegram --token "<token>"
```

Discord (بوٹ ٹوکن):

```bash
docker compose run --rm openclaw-cli channels add --channel discord --token "<token>"
```

دستاویزات: [WhatsApp](/channels/whatsapp)، [Telegram](/channels/telegram)، [Discord](/channels/discord)

### OpenAI Codex OAuth (ہیڈ لیس Docker)

47. اگر آپ وزارڈ میں OpenAI Codex OAuth منتخب کریں تو یہ ایک براؤزر URL کھولتا ہے اور `http://127.0.0.1:1455/auth/callback` پر callback کیپچر کرنے کی کوشش کرتا ہے۔ Docker یا headless setups میں یہ callback browser error دکھا سکتا ہے۔ جس مکمل redirect URL پر آپ پہنچیں اسے کاپی کریں اور auth مکمل کرنے کے لیے اسے واپس wizard میں پیسٹ کریں۔

### ہیلتھ چیک

```bash
docker compose exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

### E2E اسموک ٹیسٹ (Docker)

```bash
scripts/e2e/onboard-docker.sh
```

### QR امپورٹ اسموک ٹیسٹ (Docker)

```bash
pnpm test:docker:qr
```

### نوٹس

- کنٹینر استعمال کے لیے Gateway bind بطورِ طے شدہ `lan` پر ہوتا ہے۔
- Dockerfile CMD میں `--allow-unconfigured` استعمال ہوتا ہے؛ `gateway.mode` اگر `local` نہ ہو تو بھی mounted config کے ساتھ اسٹارٹ ہو جائے گا۔ guard نافذ کرنے کے لیے CMD override کریں۔
- گیٹ وے کنٹینر سیشنز کے لیے سورس آف ٹروتھ ہے (`~/.openclaw/agents/<agentId>/sessions/`)۔

## Agent Sandbox (ہوسٹ گیٹ وے + Docker ٹولز)

گہری جانچ: [Sandboxing](/gateway/sandboxing)

### یہ کیا کرتا ہے

جب `agents.defaults.sandbox` فعال ہو، تو **non-main sessions** ٹولز کو Docker کنٹینر کے اندر چلاتی ہیں۔ gateway آپ کے host پر رہتا ہے، لیکن ٹول کی execution isolate ہوتی ہے:

- دائرہ: بطورِ طے شدہ `"agent"` (ہر ایجنٹ کے لیے ایک کنٹینر + ورک اسپیس)
- دائرہ: فی سیشن علیحدگی کے لیے `"session"`
- فی دائرہ ورک اسپیس فولڈر `/workspace` پر ماؤنٹ ہوتا ہے
- اختیاری ایجنٹ ورک اسپیس رسائی (`agents.defaults.sandbox.workspaceAccess`)
- allow/deny ٹول پالیسی (deny کو فوقیت)
- آنے والا میڈیا فعال sandbox ورک اسپیس (`media/inbound/*`) میں کاپی ہوتا ہے تاکہ ٹولز اسے پڑھ سکیں ( `workspaceAccess: "rw"` کے ساتھ یہ ایجنٹ ورک اسپیس میں جاتا ہے)

انتباہ: `scope: "shared"` cross-session isolation کو غیر فعال کر دیتا ہے۔ تمام sessions ایک کنٹینر اور ایک workspace شیئر کرتے ہیں۔

### فی ایجنٹ sandbox پروفائلز (ملٹی ایجنٹ)

اگر آپ multi-agent routing استعمال کرتے ہیں، تو ہر agent sandbox + tool settings کو override کر سکتا ہے: `agents.list[].sandbox` اور `agents.list[].tools` (اور `agents.list[].tools.sandbox.tools`)۔ اس سے آپ ایک ہی gateway میں mixed access levels چلا سکتے ہیں:

- مکمل رسائی (ذاتی ایجنٹ)
- صرف پڑھنے والے ٹولز + صرف پڑھنے والی ورک اسپیس (خاندانی/کام ایجنٹ)
- فائل سسٹم/شیل ٹولز نہیں (عوامی ایجنٹ)

مثالیں، ترجیحی ترتیب اور خرابیوں کے ازالے کے لیے دیکھیں
[Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)۔

### ڈیفالٹ رویہ

- امیج: `openclaw-sandbox:bookworm-slim`
- فی ایجنٹ ایک کنٹینر
- ایجنٹ ورک اسپیس رسائی: `workspaceAccess: "none"` (ڈیفالٹ) `~/.openclaw/sandboxes` استعمال کرتا ہے
  - `"ro"` sandbox ورک اسپیس کو `/workspace` پر رکھتا ہے اور ایجنٹ ورک اسپیس کو صرف پڑھنے کے لیے `/agent` پر ماؤنٹ کرتا ہے ( `write`/`edit`/`apply_patch` غیر فعال)
  - `"rw"` ایجنٹ ورک اسپیس کو پڑھنے/لکھنے کے ساتھ `/workspace` پر ماؤنٹ کرتا ہے
- آٹو پرُون: غیر فعال > 24 گھنٹے یا عمر > 7 دن
- نیٹ ورک: بطورِ طے شدہ `none` (اگر ایگریس درکار ہو تو واضح طور پر آپٹ اِن کریں)
- ڈیفالٹ allow: `exec`, `process`, `read`, `write`, `edit`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- ڈیفالٹ deny: `browser`, `canvas`, `nodes`, `cron`, `discord`, `gateway`

### sandboxing فعال کریں

اگر آپ `setupCommand` میں پیکجز انسٹال کرنے کا ارادہ رکھتے ہیں، تو نوٹ کریں:

- ڈیفالٹ `docker.network`، `"none"` ہے (کوئی ایگریس نہیں)۔
- `readOnlyRoot: true` پیکج انسٹالیشنز کو روکتا ہے۔
- `apt-get` کے لیے `user` کا root ہونا ضروری ہے (`user` چھوڑ دیں یا `user: "0:0"` سیٹ کریں)۔
  OpenClaw کنٹینرز کو خودکار طور پر دوبارہ بناتا ہے جب `setupCommand` (یا docker config) تبدیل ہو، الا یہ کہ کنٹینر **حال ہی میں استعمال** ہوا ہو (تقریباً 5 منٹ کے اندر)۔ Hot کنٹینرز ایک warning لاگ کرتے ہیں جس میں بالکل درست `openclaw sandbox recreate ...` کمانڈ ہوتی ہے۔

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

ہارڈننگ کنٹرولز `agents.defaults.sandbox.docker` کے تحت ہیں:
`network`, `user`, `pidsLimit`, `memory`, `memorySwap`, `cpus`, `ulimits`,
`seccompProfile`, `apparmorProfile`, `dns`, `extraHosts`۔

ملٹی ایجنٹ: فی ایجنٹ `agents.defaults.sandbox.{docker,browser,prune}.*` کو `agents.list[].sandbox.{docker,browser,prune}.*` کے ذریعے اوور رائیڈ کریں
(جب `agents.defaults.sandbox.scope` / `agents.list[].sandbox.scope`، `"shared"` ہو تو نظر انداز)۔

### ڈیفالٹ sandbox امیج بنائیں

```bash
scripts/sandbox-setup.sh
```

یہ `Dockerfile.sandbox` استعمال کرتے ہوئے `openclaw-sandbox:bookworm-slim` بناتا ہے۔

### Sandbox عام امیج (اختیاری)

اگر آپ عام بلڈ ٹولنگ (Node، Go، Rust، وغیرہ) کے ساتھ sandbox امیج چاہتے ہیں، تو عام امیج بنائیں:

```bash
scripts/sandbox-common-setup.sh
```

یہ `openclaw-sandbox-common:bookworm-slim` بناتا ہے۔ اسے استعمال کرنے کے لیے:

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "openclaw-sandbox-common:bookworm-slim" } },
    },
  },
}
```

### Sandbox براؤزر امیج

sandbox کے اندر براؤزر ٹول چلانے کے لیے، براؤزر امیج بنائیں:

```bash
scripts/sandbox-browser-setup.sh
```

یہ `Dockerfile.sandbox-browser` استعمال کرتے ہوئے `openclaw-sandbox-browser:bookworm-slim` بناتا ہے۔ کنٹینر Chromium کو CDP enabled کے ساتھ اور ایک اختیاری noVNC observer (Xvfb کے ذریعے headful) کے ساتھ چلاتا ہے۔

نوٹس:

- Headful (Xvfb) ہیڈ لیس کے مقابلے میں بوٹ بلاکنگ کم کرتا ہے۔
- `agents.defaults.sandbox.browser.headless=true` سیٹ کر کے ہیڈ لیس بھی استعمال کیا جا سکتا ہے۔
- مکمل ڈیسک ٹاپ ماحول (GNOME) درکار نہیں؛ Xvfb ڈسپلے فراہم کرتا ہے۔

کنفیگ استعمال کریں:

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

حسبِ ضرورت براؤزر امیج:

```json5
{
  agents: {
    defaults: {
      sandbox: { browser: { image: "my-openclaw-browser" } },
    },
  },
}
```

فعال ہونے پر، ایجنٹ کو ملتا ہے:

- sandbox براؤزر کنٹرول URL ( `browser` ٹول کے لیے)
- noVNC URL (اگر فعال ہو اور headless=false)

یاد رکھیں: اگر آپ tools کے لیے allowlist استعمال کرتے ہیں، تو `browser` شامل کریں (اور اسے deny سے ہٹا دیں) ورنہ ٹول بلاک رہے گا۔
Prune rules (`agents.defaults.sandbox.prune`) browser کنٹینرز پر بھی لاگو ہوتے ہیں۔

### حسبِ ضرورت sandbox امیج

اپنی امیج بنائیں اور کنفیگ کو اس کی طرف اشارہ کریں:

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

### ٹول پالیسی (allow/deny)

- `deny` کو `allow` پر فوقیت حاصل ہے۔
- اگر `allow` خالی ہو: تمام ٹولز (deny کے سوا) دستیاب ہیں۔
- اگر `allow` خالی نہ ہو: صرف `allow` میں موجود ٹولز دستیاب ہیں (deny منہا)۔

### پرُوننگ حکمتِ عملی

دو کنٹرولز:

- `prune.idleHours`: X گھنٹوں میں استعمال نہ ہونے والے کنٹینرز ہٹائیں (0 = غیر فعال)
- `prune.maxAgeDays`: X دن سے پرانے کنٹینرز ہٹائیں (0 = غیر فعال)

مثال:

- مصروف سیشنز رکھیں مگر عمر محدود کریں:
  `idleHours: 24`, `maxAgeDays: 7`
- کبھی پرُون نہ کریں:
  `idleHours: 0`, `maxAgeDays: 0`

### سکیورٹی نوٹس

- ہارڈ وال صرف **ٹولز** پر لاگو ہوتی ہے (exec/read/write/edit/apply_patch)۔
- ہوسٹ-اونلی ٹولز جیسے browser/camera/canvas بطورِ طے شدہ بلاک ہیں۔
- sandbox میں `browser` کی اجازت دینا **علیحدگی توڑ دیتا ہے** (براؤزر ہوسٹ پر چلتا ہے)۔

## خرابیوں کا ازالہ

- امیج غائب: [`scripts/sandbox-setup.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/sandbox-setup.sh) کے ساتھ بلڈ کریں یا `agents.defaults.sandbox.docker.image` سیٹ کریں۔
- کنٹینر نہیں چل رہا: ضرورت پڑنے پر فی سیشن خودکار طور پر بن جائے گا۔
- sandbox میں اجازت کی غلطیاں: `docker.user` کو ایسے UID:GID پر سیٹ کریں جو آپ کی
  ماؤنٹ شدہ ورک اسپیس کی ملکیت سے میل کھاتا ہو (یا ورک اسپیس فولڈر chown کریں)۔
- Custom tools نہیں مل رہے: OpenClaw کمانڈز کو `sh -lc` (login shell) کے ساتھ چلاتا ہے، جو `/etc/profile` کو source کرتا ہے اور PATH کو ری سیٹ کر سکتا ہے۔ `docker.env.PATH` سیٹ کریں تاکہ آپ کے custom tool paths پہلے شامل ہوں (مثلاً `/custom/bin:/usr/local/share/npm-global/bin`)، یا اپنے Dockerfile میں `/etc/profile.d/` کے تحت ایک اسکرپٹ شامل کریں۔
