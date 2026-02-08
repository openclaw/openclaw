---
summary: "تشغيل OpenClaw Gateway على مدار الساعة 24/7 على VPS منخفض التكلفة من Hetzner (Docker) مع حالة دائمة وثنائيات مضمّنة"
read_when:
  - "تريد تشغيل OpenClaw على مدار الساعة 24/7 على VPS سحابي (وليس على حاسوبك المحمول)"
  - "تريد Gateway جاهزًا للإنتاج يعمل دائمًا على VPS خاص بك"
  - "تريد تحكمًا كاملًا في الاستمرارية والثنائيات وسلوك إعادة التشغيل"
  - "تشغّل OpenClaw داخل Docker على Hetzner أو مزوّد مشابه"
title: "Hetzner"
x-i18n:
  source_path: install/hetzner.md
  source_hash: 84d9f24f1a803aa1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:48:29Z
---

# OpenClaw على Hetzner (Docker، دليل VPS للإنتاج)

## الهدف

تشغيل OpenClaw Gateway بشكل دائم على VPS من Hetzner باستخدام Docker، مع حالة دائمة، وثنائيات مضمّنة، وسلوك آمن لإعادة التشغيل.

إذا كنت تريد «OpenClaw على مدار الساعة مقابل ~$5»، فهذا أبسط إعداد موثوق.
تتغير أسعار Hetzner؛ اختر أصغر VPS بنظام Debian/Ubuntu ثم وسّع إذا واجهت أخطاء نفاد الذاكرة (OOM).

## ماذا نفعل (بمصطلحات بسيطة)؟

- استئجار خادم Linux صغير (VPS من Hetzner)
- تثبيت Docker (بيئة تشغيل معزولة للتطبيق)
- تشغيل OpenClaw Gateway داخل Docker
- حفظ `~/.openclaw` + `~/.openclaw/workspace` على المضيف (لتجاوز إعادة التشغيل/إعادة البناء)
- الوصول إلى واجهة التحكم من حاسوبك المحمول عبر نفق SSH

يمكن الوصول إلى Gateway عبر:

- إعادة توجيه منفذ SSH من حاسوبك المحمول
- تعريض المنفذ مباشرة إذا كنت تدير الجدار الناري والرموز بنفسك

يفترض هذا الدليل استخدام Ubuntu أو Debian على Hetzner.  
إذا كنت على VPS بنظام Linux آخر، فقم بمواءمة الحزم وفقًا لذلك.
للتدفق العام لـ Docker، راجع [Docker](/install/docker).

---

## المسار السريع (للمشغّلين ذوي الخبرة)

1. تجهيز VPS من Hetzner
2. تثبيت Docker
3. استنساخ مستودع OpenClaw
4. إنشاء أدلة مضيف دائمة
5. تهيئة `.env` و `docker-compose.yml`
6. تضمين الثنائيات المطلوبة داخل الصورة
7. `docker compose up -d`
8. التحقق من الاستمرارية والوصول إلى Gateway

---

## ما تحتاجه

- VPS من Hetzner مع وصول root
- وصول SSH من حاسوبك المحمول
- إلمام أساسي بـ SSH + النسخ/اللصق
- ~20 دقيقة
- Docker و Docker Compose
- بيانات اعتماد مصادقة النموذج
- بيانات اعتماد موفّر اختيارية
  - رمز QR لـ WhatsApp
  - رمز بوت Telegram
  - OAuth لـ Gmail

---

## 1) تجهيز الـ VPS

أنشئ VPS بنظام Ubuntu أو Debian في Hetzner.

اتصل كمستخدم root:

```bash
ssh root@YOUR_VPS_IP
```

يفترض هذا الدليل أن الـ VPS ذو حالة (stateful).
لا تتعامل معه كبنية تحتية قابلة للتخلص.

---

## 2) تثبيت Docker (على الـ VPS)

```bash
apt-get update
apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sh
```

تحقق:

```bash
docker --version
docker compose version
```

---

## 3) استنساخ مستودع OpenClaw

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

يفترض هذا الدليل أنك ستبني صورة مخصّصة لضمان استمرارية الثنائيات.

---

## 4) إنشاء أدلة مضيف دائمة

حاويات Docker مؤقتة.
يجب أن تعيش كل الحالة طويلة الأمد على المضيف.

```bash
mkdir -p /root/.openclaw
mkdir -p /root/.openclaw/workspace

# Set ownership to the container user (uid 1000):
chown -R 1000:1000 /root/.openclaw
chown -R 1000:1000 /root/.openclaw/workspace
```

---

## 5) تهيئة متغيرات البيئة

أنشئ `.env` في جذر المستودع.

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

ولّد أسرارًا قوية:

```bash
openssl rand -hex 32
```

**لا تقم بإضافة هذا الملف إلى المستودع.**

---

## 6) تهيئة Docker Compose

أنشئ أو حدّث `docker-compose.yml`.

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

## 7) تضمين الثنائيات المطلوبة داخل الصورة (أمر حاسم)

تثبيت الثنائيات داخل حاوية قيد التشغيل فخّ.
أي شيء يُثبَّت وقت التشغيل سيُفقد عند إعادة التشغيل.

يجب تثبيت جميع الثنائيات الخارجية المطلوبة من Skills أثناء بناء الصورة.

تُظهر الأمثلة أدناه ثلاث ثنائيات شائعة فقط:

- `gog` للوصول إلى Gmail
- `goplaces` لـ Google Places
- `wacli` لـ WhatsApp

هذه أمثلة وليست قائمة كاملة.
يمكنك تثبيت أي عدد من الثنائيات باستخدام النمط نفسه.

إذا أضفت Skills جديدة لاحقًا تعتمد على ثنائيات إضافية، فيجب عليك:

1. تحديث Dockerfile
2. إعادة بناء الصورة
3. إعادة تشغيل الحاويات

**مثال Dockerfile**

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

## 8) البناء والتشغيل

```bash
docker compose build
docker compose up -d openclaw-gateway
```

تحقق من الثنائيات:

```bash
docker compose exec openclaw-gateway which gog
docker compose exec openclaw-gateway which goplaces
docker compose exec openclaw-gateway which wacli
```

المخرجات المتوقعة:

```
/usr/local/bin/gog
/usr/local/bin/goplaces
/usr/local/bin/wacli
```

---

## 9) التحقق من Gateway

```bash
docker compose logs -f openclaw-gateway
```

النجاح:

```
[gateway] listening on ws://0.0.0.0:18789
```

من حاسوبك المحمول:

```bash
ssh -N -L 18789:127.0.0.1:18789 root@YOUR_VPS_IP
```

افتح:

`http://127.0.0.1:18789/`

الصق رمز Gateway الخاص بك.

---

## ما الذي يستمر وأين (مصدر الحقيقة)

يعمل OpenClaw داخل Docker، لكن Docker ليس مصدر الحقيقة.
يجب أن تبقى كل الحالة طويلة الأمد عبر إعادة التشغيل وإعادة البناء وإعادة الإقلاع.

| المكوّن              | الموقع                            | آلية الاستمرارية              | ملاحظات                        |
| -------------------- | --------------------------------- | ----------------------------- | ------------------------------ |
| تهيئة Gateway        | `/home/node/.openclaw/`           | ربط وحدة تخزين للمضيف         | تتضمن `openclaw.json`، والرموز |
| ملفات مصادقة النموذج | `/home/node/.openclaw/`           | ربط وحدة تخزين للمضيف         | رموز OAuth، مفاتيح API         |
| تهيئات Skills        | `/home/node/.openclaw/skills/`    | ربط وحدة تخزين للمضيف         | حالة على مستوى Skill           |
| مساحة عمل الوكيل     | `/home/node/.openclaw/workspace/` | ربط وحدة تخزين للمضيف         | الشيفرة ومواد الوكيل           |
| جلسة WhatsApp        | `/home/node/.openclaw/`           | ربط وحدة تخزين للمضيف         | يحفظ تسجيل الدخول عبر QR       |
| حلقة مفاتيح Gmail    | `/home/node/.openclaw/`           | وحدة تخزين للمضيف + كلمة مرور | يتطلب `GOG_KEYRING_PASSWORD`   |
| الثنائيات الخارجية   | `/usr/local/bin/`                 | صورة Docker                   | يجب تضمينها وقت البناء         |
| بيئة تشغيل Node      | نظام ملفات الحاوية                | صورة Docker                   | تُعاد بناؤها مع كل بناء للصورة |
| حزم نظام التشغيل     | نظام ملفات الحاوية                | صورة Docker                   | لا تُثبَّت وقت التشغيل         |
| حاوية Docker         | مؤقتة                             | قابلة لإعادة التشغيل          | آمنة للإزالة                   |
