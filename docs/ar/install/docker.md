---
summary: "إعداد اختياري قائم على Docker وتهيئة أولية لـ OpenClaw"
read_when:
  - تريد Gateway مُحَوْسَبًا بالحاويات بدل التثبيتات المحلية
  - تقوم بالتحقق من مسار Docker
title: "Docker"
---

# Docker (اختياري)

Docker **اختياري**. استخدمه فقط إذا كنت تريد Gateway مُحَوْسَبًا بالحاويات أو للتحقق من مسار Docker.

## هل Docker مناسب لي؟

- **نعم**: تريد بيئة Gateway معزولة وسهلة الاستبدال، أو تشغيل OpenClaw على مضيف دون تثبيتات محلية.
- **لا**: تعمل على جهازك الشخصي وتريد أسرع دورة تطوير. استخدم مسار التثبيت العادي بدلًا من ذلك.
- **ملاحظة sandboxing**: يستخدم sandboxing الخاص بالوكيل Docker أيضًا، لكنه **لا** يتطلب تشغيل Gateway بالكامل داخل Docker. راجع [Sandboxing](/gateway/sandboxing).

يغطي هذا الدليل:

- Gateway مُحَوْسَب بالحاويات (OpenClaw كامل داخل Docker)
- Sandbox وكيل لكل جلسة (Gateway على المضيف + أدوات وكيل معزولة بـ Docker)

تفاصيل sandboxing: [Sandboxing](/gateway/sandboxing)

## المتطلبات

- Docker Desktop (أو Docker Engine) + Docker Compose v2
- مساحة قرص كافية للصور + السجلات

## Gateway مُحَوْسَب بالحاويات (Docker Compose)

### البدء السريع (موصى به)

من جذر المستودع:

```bash
./docker-setup.sh
```

يقوم هذا السكربت بما يلي:

- يبني صورة الـ Gateway
- تشغيل معالج أونبواردينغ
- يطبع تلميحات إعداد الموفّرين الاختيارية
- يبدأ الـ Gateway عبر Docker Compose
- يولّد رمز Gateway ويكتبه إلى `.env`

إختيار النيف فار:

- `OPENCLAW_DOCKER_APT_PACKAGES` — تثبيت حِزَم apt إضافية أثناء البناء
- `OPENCLAW_EXTRA_MOUNTS` — إضافة ربطات bind إضافية من المضيف
- `OPENCLAW_HOME_VOLUME` — الإبقاء على `/home/node` في وحدة تخزين مُسماة

بعد الانتهاء:

- افتح `http://127.0.0.1:18789/` في المتصفح.
- الصق الرمز في واجهة التحكم (الإعدادات → الرمز).
- هل تحتاج إلى عنوان URL مرة أخرى؟ هل تحتاج العنوان مرة أخرى؟ شغّل `docker compose run --rm openclaw-cli dashboard --no-open`.

يكتب الإعداد/مساحة العمل على المضيف:

- `~/.openclaw/`
- `~/.openclaw/workspace`

تشغيل على VPS؟ تعمل على VPS؟ راجع [Hetzner (Docker VPS)](/install/hetzner).

### المسار اليدوي (compose)

```bash
docker build -t openclaw:local -f Dockerfile .
docker compose run --rm openclaw-cli onboard
docker compose up -d openclaw-gateway
```

ملاحظة: شغّل `docker compose ...` من جذر المستودع. إذا فعّلت
`OPENCLAW_EXTRA_MOUNTS` أو `OPENCLAW_HOME_VOLUME`، فإن سكربت الإعداد يكتب
`docker-compose.extra.yml`؛ ضمّنه عند تشغيل Compose في مكان آخر:

```bash
docker compose -f docker-compose.yml -f docker-compose.extra.yml <command>
```

### رمز واجهة التحكم + الاقتران (Docker)

إذا رأيت «unauthorized» أو «disconnected (1008): pairing required»، فاحصل على
رابط لوحة معلومات جديد ووافق جهاز المتصفح:

```bash
docker compose run --rm openclaw-cli dashboard --no-open
docker compose run --rm openclaw-cli devices list
docker compose run --rm openclaw-cli devices approve <requestId>
```

تفاصيل إضافية: [Dashboard](/web/dashboard)، [Devices](/cli/devices).

### ربطات إضافية (اختياري)

إذا أردت ربط أدلة إضافية من المضيف داخل الحاويات، فاضبط
`OPENCLAW_EXTRA_MOUNTS` قبل تشغيل `docker-setup.sh`. يقبل هذا
قائمة مفصولة بفواصل من ربطات Docker bind ويطبّقها على كلٍّ من
`openclaw-gateway` و `openclaw-cli` عبر توليد `docker-compose.extra.yml`.

مثال:

```bash
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

ملاحظات:

- يجب مشاركة المسارات مع Docker Desktop على macOS/Windows.
- إذا عدّلت `OPENCLAW_EXTRA_MOUNTS`، فأعد تشغيل `docker-setup.sh` لإعادة توليد
  ملف compose الإضافي.
- يتم توليد `docker-compose.extra.yml`. لا تعدّله يدويًا.

### الإبقاء على دليل المنزل الكامل للحاوية (اختياري)

إذا أردت أن يبقى `/home/node` عبر إعادة إنشاء الحاوية، فاضبط وحدة تخزين مُسماة
عبر `OPENCLAW_HOME_VOLUME`. ينشئ هذا وحدة تخزين Docker ويربطها عند
`/home/node`، مع الحفاظ على ربطات الإعداد/مساحة العمل القياسية. استخدم
وحدة تخزين مُسماة هنا (وليس مسار bind)؛ وبالنسبة لربطات bind، استخدم
`OPENCLAW_EXTRA_MOUNTS`.

مثال:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

يمكنك دمج ذلك مع ربطات إضافية:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

ملاحظات:

- إذا غيّرت `OPENCLAW_HOME_VOLUME`، فأعد تشغيل `docker-setup.sh` لإعادة توليد
  ملف compose الإضافي.
- تستمر وحدة التخزين المُسماة حتى تُزال باستخدام `docker volume rm <name>`.

### تثبيت حِزَم apt إضافية (اختياري)

إذا احتجت إلى حِزَم نظام داخل الصورة (على سبيل المثال، أدوات بناء أو
مكتبات وسائط)، فاضبط `OPENCLAW_DOCKER_APT_PACKAGES` قبل تشغيل `docker-setup.sh`.
يُثبّت هذا الحِزَم أثناء بناء الصورة، لذا تبقى حتى لو حُذفت الحاوية.

مثال:

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg build-essential"
./docker-setup.sh
```

ملاحظات:

- يقبل هذا قائمة أسماء حِزَم apt مفصولة بمسافات.
- إذا غيّرت `OPENCLAW_DOCKER_APT_PACKAGES`، فأعد تشغيل `docker-setup.sh` لإعادة بناء
  الصورة.

### حاوية متقدمة/كاملة الميزات (اختياري)

صورة Docker الافتراضية **أمنية أولًا** وتعمل كمستخدم غير جذري `node`. يقلّل ذلك سطح الهجوم، لكنه يعني:

- عدم تثبيت حِزَم النظام أثناء التشغيل
- عدم وجود Homebrew افتراضيًا
- عدم تضمين متصفحات Chromium/Playwright

إذا أردت حاوية أكثر اكتمالًا، فاستخدم مفاتيح الاشتراك هذه:

1. **الإبقاء على `/home/node`** بحيث تبقى تنزيلات المتصفح ومخابئ الأدوات:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

2. **خبز تبعيات النظام داخل الصورة** (قابل للتكرار + دائم):

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="git curl jq"
./docker-setup.sh
```

3. **تثبيت متصفحات Playwright دون `npx`** (يتجنب تعارضات تجاوز npm):

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

إذا احتجت Playwright لتثبيت تبعيات النظام، فأعد بناء الصورة باستخدام
`OPENCLAW_DOCKER_APT_PACKAGES` بدل استخدام `--with-deps` أثناء التشغيل.

4. **الإبقاء على تنزيلات متصفح Playwright**:

- اضبط `PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright` في
  `docker-compose.yml`.
- تأكّد من بقاء `/home/node` عبر `OPENCLAW_HOME_VOLUME`، أو اربط
  `/home/node/.cache/ms-playwright` عبر `OPENCLAW_EXTRA_MOUNTS`.

### الأذونات + EACCES

تعمل الصورة كمستخدم `node` (uid 1000). إذا رأيت أخطاء أذونات على
`/home/node/.openclaw`، فتأكد من أن ربطات المضيف مملوكة لـ uid 1000.

مثال (مضيف Linux):

```bash
sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
```

إذا اخترت التشغيل كمستخدم root للتسهيل، فإنك تقبل المفاضلة الأمنية.

### إعادة بناء أسرع (موصى به)

لتسريع إعادة البناء، رتّب Dockerfile بحيث تُخزَّن طبقات التبعيات مؤقتًا.
هذا يتجنب إعادة تشغيل `pnpm install` ما لم تتغير ملفات القفل:

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

### إعداد القنوات (اختياري)

استخدم حاوية CLI لتهيئة القنوات، ثم أعد تشغيل Gateway إذا لزم الأمر.

WhatsApp (رمز QR):

```bash
docker compose run --rm openclaw-cli channels login
```

Telegram (رمز البوت):

```bash
docker compose run --rm openclaw-cli channels add --channel telegram --token "<token>"
```

Discord (رمز البوت):

```bash
docker compose run --rm openclaw-cli channels add --channel discord --token "<token>"
```

الوثائق: [WhatsApp](/channels/whatsapp)، [Telegram](/channels/telegram)، [Discord](/channels/discord)

### OAuth لـ OpenAI Codex (Docker دون واجهة)

إذا اخترت OAuth لـ OpenAI Codex في المعالج، فسيُفتح عنوان متصفح ويحاول
التقاط ردّ على `http://127.0.0.1:1455/auth/callback`. في Docker أو
الإعدادات دون واجهة قد يظهر خطأ متصفح. انسخ عنوان إعادة التوجيه الكامل
الذي تصل إليه والصقه مجددًا في المعالج لإتمام المصادقة.

### فحص الصحة

```bash
docker compose exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

### اختبار دخان E2E (Docker)

```bash
scripts/e2e/onboard-docker.sh
```

### اختبار دخان لاستيراد QR (Docker)

```bash
pnpm test:docker:qr
```

### ملاحظات

- ربط Gateway الافتراضي هو `lan` لاستخدام الحاويات.
- يستخدم CMD في Dockerfile ‏`--allow-unconfigured`؛ سيبدأ التكوين المُثبّت مع `gateway.mode` وليس `local`. غيّر CMD لفرض الحارس.
- حاوية Gateway هي مصدر الحقيقة للجلسات (`~/.openclaw/agents/<agentId>/sessions/`).

## Sandbox الوكيل (Gateway على المضيف + أدوات Docker)

تعمّق: [Sandboxing](/gateway/sandboxing)

### ما الذي يفعله

عند تمكين `agents.defaults.sandbox`، تعمل **الجلسات غير الرئيسية** على تشغيل الأدوات داخل
حاوية Docker. يبقى Gateway على مضيفك، لكن تنفيذ الأدوات يكون معزولًا:

- النطاق: `"agent"` افتراضيًا (حاوية واحدة + مساحة عمل لكل وكيل)
- النطاق: `"session"` للعزل لكل جلسة
- مجلد مساحة عمل لكل نطاق مُثبت عند `/workspace`
- وصول اختياري لمساحة عمل الوكيل (`agents.defaults.sandbox.workspaceAccess`)
- سياسة أدوات سماح/منع (المنع له الأسبقية)
- تُنسخ الوسائط الواردة إلى مساحة عمل الـ sandbox النشطة (`media/inbound/*`) ليتمكنـت الأدوات من قراءتها (ومع `workspaceAccess: "rw"`، تهبط في مساحة عمل الوكيل)

تحذير: يعطّل `scope: "shared"` العزل بين الجلسات. تشترك جميع الجلسات في
حاوية واحدة ومساحة عمل واحدة.

### ملفات تعريف sandbox لكل وكيل (متعدد الوكلاء)

إذا استخدمت توجيهًا متعدد الوكلاء، يمكن لكل وكيل تجاوز إعدادات sandbox + الأدوات:
`agents.list[].sandbox` و `agents.list[].tools` (بالإضافة إلى `agents.list[].tools.sandbox.tools`). يتيح لك ذلك تشغيل
مستويات وصول مختلطة في Gateway واحد:

- وصول كامل (وكيل شخصي)
- أدوات للقراءة فقط + مساحة عمل للقراءة فقط (وكيل عائلة/عمل)
- بدون أدوات نظام ملفات/قشرة (وكيل عام)

راجع [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) للأمثلة،
وأولوية الإعدادات، واستكشاف الأخطاء وإصلاحها.

### السلوك الافتراضي

- الصورة: `openclaw-sandbox:bookworm-slim`
- حاوية واحدة لكل وكيل
- وصول مساحة عمل الوكيل: `workspaceAccess: "none"` (افتراضي) يستخدم `~/.openclaw/sandboxes`
  - يحافظ `"ro"` على مساحة عمل الـ sandbox عند `/workspace` ويربط مساحة عمل الوكيل للقراءة فقط عند `/agent` (يعطّل `write`/`edit`/`apply_patch`)
  - يربط `"rw"` مساحة عمل الوكيل قراءة/كتابة عند `/workspace`
- التنظيف التلقائي: خمول > 24 ساعة أو العمر > 7 أيام
- الشبكة: `none` افتراضيًا (اشترك صراحة إذا احتجت الخروج)
- السماح الافتراضي: `exec`، `process`، `read`، `write`، `edit`، `sessions_list`، `sessions_history`، `sessions_send`، `sessions_spawn`، `session_status`
- المنع الافتراضي: `browser`، `canvas`، `nodes`، `cron`، `discord`، `gateway`

### تمكين sandboxing

إذا كنت تخطط لتثبيت حِزَم في `setupCommand`، فلاحظ:

- القيمة الافتراضية لـ `docker.network` هي `"none"` (لا خروج).
- يمنع `readOnlyRoot: true` تثبيت الحِزَم.
- يجب أن يكون `user` مستخدم root من أجل `apt-get` (احذف `user` أو اضبط `user: "0:0"`).
  يعيد OpenClaw إنشاء الحاويات تلقائيًا عند تغيّر `setupCommand` (أو إعدادات docker)
  ما لم تكن الحاوية **مستخدمة مؤخرًا** (خلال ~5 دقائق). تسجّل الحاويات الساخنة
  تحذيرًا مع أمر `openclaw sandbox recreate ...` الدقيق.

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

توجد مفاتيح التقسية تحت `agents.defaults.sandbox.docker`:
`network`، `user`، `pidsLimit`، `memory`، `memorySwap`، `cpus`، `ulimits`،
`seccompProfile`، `apparmorProfile`، `dns`، `extraHosts`.

متعدد الوكلاء: تجاوز `agents.defaults.sandbox.{docker,browser,prune}.*` لكل وكيل عبر `agents.list[].sandbox.{docker,browser,prune}.*`
(يُتجاهل عندما تكون `agents.defaults.sandbox.scope` / `agents.list[].sandbox.scope` هي `"shared"`).

### بناء صورة sandbox الافتراضية

```bash
scripts/sandbox-setup.sh
```

يبني هذا `openclaw-sandbox:bookworm-slim` باستخدام `Dockerfile.sandbox`.

### صورة sandbox مشتركة (اختياري)

إذا أردت صورة sandbox تحتوي أدوات بناء شائعة (Node، Go، Rust، إلخ)، فابنِ الصورة المشتركة:

```bash
scripts/sandbox-common-setup.sh
```

يبني هذا `openclaw-sandbox-common:bookworm-slim`. لاستخدامها:

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "openclaw-sandbox-common:bookworm-slim" } },
    },
  },
}
```

### صورة متصفح sandbox

لتشغيل أداة المتصفح داخل sandbox، ابنِ صورة المتصفح:

```bash
scripts/sandbox-browser-setup.sh
```

يبني هذا `openclaw-sandbox-browser:bookworm-slim` باستخدام
`Dockerfile.sandbox-browser`. تشغّل الحاوية Chromium مع تمكين CDP
ومراقب noVNC اختياري (واجهة مرئية عبر Xvfb).

ملاحظات:

- الرأسي (Xvfb) يقلل من حجب البوت مقابل بلا رأس.
- يمكن استخدام الوضع دون واجهة عبر ضبط `agents.defaults.sandbox.browser.headless=true`.
- لا حاجة لبيئة سطح مكتب كاملة (GNOME)؛ يوفر Xvfb العرض.

استخدم التهيئة:

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

صورة متصفح مخصّصة:

```json5
{
  agents: {
    defaults: {
      sandbox: { browser: { image: "my-openclaw-browser" } },
    },
  },
}
```

عند التمكين، يتلقى الوكيل:

- عنوان تحكم متصفح sandbox (لأداة `browser`)
- عنوان noVNC (إن كان مُمكّنًا و headless=false)

تذكير: إذا استخدمت قائمة سماح للأدوات، فأضف `browser` (وأزِله من
المنع) وإلا ستظل الأداة محظورة.
تنطبق قواعد التنظيف (`agents.defaults.sandbox.prune`) على حاويات المتصفح أيضًا.

### صورة sandbox مخصّصة

ابنِ صورتك الخاصة وأشِر إليها في التهيئة:

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

### سياسة الأدوات (سماح/منع)

- `deny` يتغلب على `allow`.
- إذا كان `allow` فارغًا: تتوفر جميع الأدوات (باستثناء المنع).
- إذا كان `allow` غير فارغ: تتوفر فقط الأدوات ضمن `allow` (مع طرح المنع).

### استراتيجية التنظيف

عقدات:

- `prune.idleHours`: إزالة الحاويات غير المستخدمة خلال X ساعات (0 = تعطيل)
- `prune.maxAgeDays`: إزالة الحاويات الأقدم من X أيام (0 = تعطيل)

مثال:

- الاحتفاظ بالجلسات النشطة مع تحديد العمر:
  `idleHours: 24`، `maxAgeDays: 7`
- عدم التنظيف مطلقًا:
  `idleHours: 0`، `maxAgeDays: 0`

### ملاحظات أمنية

- الجدار الصلب ينطبق فقط على **الأدوات** (exec/read/write/edit/apply_patch).
- أدوات المضيف فقط مثل browser/camera/canvas محظورة افتراضيًا.
- السماح بـ `browser` داخل sandbox **يكسر العزل** (يعمل المتصفح على المضيف).

## استكشاف الأخطاء وإصلاحها

- الصورة مفقودة: ابنِها باستخدام [`scripts/sandbox-setup.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/sandbox-setup.sh) أو اضبط `agents.defaults.sandbox.docker.image`.
- الحاوية لا تعمل: ستُنشأ تلقائيًا لكل جلسة عند الطلب.
- أخطاء أذونات داخل sandbox: اضبط `docker.user` إلى UID:GID يطابق
  ملكية مساحة العمل المُثبتة (أو غيّر ملكية مجلد مساحة العمل).
- لم تُعثر على أدوات مخصّصة: يشغّل OpenClaw الأوامر باستخدام `sh -lc` (قشرة تسجيل دخول)، والتي
  تُصدِر `/etc/profile` وقد تعيد ضبط PATH. اضبط `docker.env.PATH` لإضافة
  مسارات أدواتك المخصّصة (مثل `/custom/bin:/usr/local/share/npm-global/bin`)، أو أضِف
  سكربتًا تحت `/etc/profile.d/` في Dockerfile الخاص بك.
