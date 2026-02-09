---
summary: "تشغيل OpenClaw Gateway على مدار الساعة 24/7 على جهاز GCP Compute Engine افتراضي (Docker) مع حالة دائمة"
read_when:
  - تريد تشغيل OpenClaw على مدار الساعة 24/7 على GCP
  - تريد Gateway دائم التشغيل بمستوى إنتاجي على جهازك الافتراضي الخاص
  - تريد تحكمًا كاملًا في الاستمرارية والملفات التنفيذية وسلوك إعادة التشغيل
title: "GCP"
---

# OpenClaw على GCP Compute Engine (Docker، دليل VPS للإنتاج)

## الهدف

تشغيل OpenClaw Gateway بشكل دائم على جهاز افتراضي من نوع GCP Compute Engine باستخدام Docker، مع حالة دائمة، وملفات تنفيذية مدمجة، وسلوك آمن لإعادة التشغيل.

إذا كنت تريد «OpenClaw يعمل 24/7 مقابل ~5–12 دولارًا شهريًا»، فهذا إعداد موثوق على Google Cloud.
تختلف الأسعار حسب نوع الجهاز والمنطقة؛ اختر أصغر جهاز افتراضي يلائم حملك ثم قم بالترقية إذا واجهت أخطاء نفاد الذاكرة (OOM).

## ماذا نفعل (بعبارات بسيطة)؟

- إنشاء مشروع GCP وتفعيل الفوترة
- إنشاء جهاز افتراضي Compute Engine
- تثبيت Docker (بيئة تشغيل معزولة للتطبيق)
- تشغيل OpenClaw Gateway داخل Docker
- حفظ `~/.openclaw` + `~/.openclaw/workspace` على المضيف (لتبقى بعد إعادة التشغيل/إعادة البناء)
- الوصول إلى واجهة التحكم من حاسوبك عبر نفق SSH

يمكن الوصول إلى Gateway عبر:

- إعادة توجيه منفذ SSH من حاسوبك
- تعريض المنفذ مباشرة إذا كنت تدير الجدار الناري والرموز بنفسك

يستخدم هذا الدليل Debian على GCP Compute Engine.
يعمل Ubuntu أيضًا؛ فقط طابق الحزم وفقًا لذلك.
للتدفق العام باستخدام Docker، راجع [Docker](/install/docker).

---

## المسار السريع (للمشغّلين ذوي الخبرة)

1. إنشاء مشروع GCP + تفعيل واجهة Compute Engine API
2. إنشاء جهاز افتراضي Compute Engine (e2-small، Debian 12، قرص 20GB)
3. الاتصال بالجهاز عبر SSH
4. تثبيت Docker
5. استنساخ مستودع OpenClaw
6. إنشاء أدلة مضيف دائمة
7. تهيئة `.env` و `docker-compose.yml`
8. الخبز يحتاج إلى ثنائيين، يبني و يطلق

---

## ما الذي تحتاجه

- حساب GCP (الفئة المجانية مؤهلة لـ e2-micro)
- تثبيت gcloud CLI (أو استخدام Cloud Console)
- وصول SSH من حاسوبك
- إلمام أساسي بـ SSH والنسخ/اللصق
- حوالي 20–30 دقيقة
- Docker و Docker Compose
- بيانات اعتماد مصادقة النموذج
- بيانات اعتماد موفّرين اختيارية
  - رمز QR لـ WhatsApp
  - رمز بوت Telegram
  - OAuth لـ Gmail

---

## 1. تثبيت gcloud CLI (أو استخدام Console)

**الخيار A: gcloud CLI** (موصى به للأتمتة)

ثبّت من [https://cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install)

التهيئة والمصادقة:

```bash
gcloud init
gcloud auth login
```

**الخيار B: Cloud Console**

يمكن تنفيذ جميع الخطوات عبر واجهة الويب على [https://console.cloud.google.com](https://console.cloud.google.com)

---

## 2. إنشاء مشروع GCP

**CLI:**

```bash
gcloud projects create my-openclaw-project --name="OpenClaw Gateway"
gcloud config set project my-openclaw-project
```

فعّل الفوترة من [https://console.cloud.google.com/billing](https://console.cloud.google.com/billing) (مطلوبة لـ Compute Engine).

فعّل واجهة Compute Engine API:

```bash
gcloud services enable compute.googleapis.com
```

**Console:**

1. انتقل إلى IAM & Admin > Create Project
2. اسمه وأنشئ
3. فعّل الفوترة للمشروع
4. انتقل إلى APIs & Services > Enable APIs > ابحث عن «Compute Engine API» > Enable

---

## 3. إنشاء الجهاز الافتراضي

**أنواع الأجهزة:**

| النوع    | المواصفات                                   | التكلفة                  | ملاحظات               |
| -------- | ------------------------------------------- | ------------------------ | --------------------- |
| e2-small | 2 vCPU، ذاكرة 2GB                           | ~$12/شهر | موصى به               |
| e2-micro | 2 vCPU (مشتركة)، 1GB RAM | مؤهل للفئة المجانية      | قد يحدث OOM تحت الحمل |

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

1. انتقل إلى Compute Engine > VM instances > Create instance
2. الاسم: `openclaw-gateway`
3. المنطقة: `us-central1`، المنطقة الفرعية: `us-central1-a`
4. نوع الجهاز: `e2-small`
5. قرص الإقلاع: Debian 12، 20GB
6. Create

---

## 4. الاتصال بالجهاز عبر SSH

**CLI:**

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

**Console:**

انقر زر «SSH» بجوار جهازك الافتراضي في لوحة Compute Engine.

ملاحظة: قد يستغرق نشر مفاتيح SSH من 1 إلى 2 دقيقة بعد إنشاء الجهاز. إذا رُفض الاتصال، انتظر ثم أعد المحاولة.

---

## 5. تثبيت Docker (على الجهاز الافتراضي)

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

سجّل الخروج ثم الدخول مرة أخرى لتفعيل تغيير المجموعة:

```bash
exit
```

ثم اتصل عبر SSH مجددًا:

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

تحقق:

```bash
docker --version
docker compose version
```

---

## 6. استنساخ مستودع OpenClaw

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

يفترض هذا الدليل أنك ستبني صورة مخصّصة لضمان استمرارية الملفات التنفيذية.

---

## 7. إنشاء أدلة مضيف دائمة

حاويات Docker مؤقتة.
يجب أن تعيش كل الحالة طويلة الأمد على المضيف.

```bash
mkdir -p ~/.openclaw
mkdir -p ~/.openclaw/workspace
```

---

## 8. تهيئة متغيرات البيئة

أنشئ `.env` في جذر المستودع.

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

ولّد أسرارًا قوية:

```bash
openssl rand -hex 32
```

**لا تقم بإضافة هذا الملف إلى المستودع.**

---

## 9. تهيئة Docker Compose

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

## 10. دمج الملفات التنفيذية المطلوبة في الصورة (أمر حاسم)

تثبيت الملفات التنفيذية داخل حاوية تعمل هو فخ.
أي شيء يُثبَّت وقت التشغيل سيُفقد عند إعادة التشغيل.

يجب تثبيت جميع الملفات التنفيذية الخارجية المطلوبة بواسطة Skills أثناء بناء الصورة.

تُظهر الأمثلة أدناه ثلاث ملفات تنفيذية شائعة فقط:

- `gog` للوصول إلى Gmail
- `goplaces` لـ Google Places
- `wacli` لـ WhatsApp

هذه أمثلة وليست قائمة كاملة.
يمكنك تثبيت أي عدد من الملفات التنفيذية باستخدام النمط نفسه.

إذا أضفت Skills جديدة لاحقًا تعتمد على ملفات تنفيذية إضافية، يجب عليك:

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

## 11. البناء والتشغيل

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

## 12. التحقق من Gateway

```bash
docker compose logs -f openclaw-gateway
```

النجاح:

```
[gateway] listening on ws://0.0.0.0:18789
```

---

## 13. الوصول من حاسوبك

أنشئ نفق SSH لإعادة توجيه منفذ Gateway:

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a -- -L 18789:127.0.0.1:18789
```

افتح في المتصفح:

`http://127.0.0.1:18789/`

الصق رمز Gateway الخاص بك.

---

## ما الذي يستمر وأين (مصدر الحقيقة)

يعمل OpenClaw داخل Docker، لكن Docker ليس مصدر الحقيقة.
يجب أن تبقى كل الحالة طويلة الأمد بعد إعادة التشغيل وإعادة البناء وإعادة الإقلاع.

| المكون               | الموقع                            | آلية الاستمرارية              | ملاحظات                       |
| -------------------- | --------------------------------- | ----------------------------- | ----------------------------- |
| تهيئة Gateway        | `/home/node/.openclaw/`           | تحميل حجم صوت المضيف          | تتضمن `openclaw.json` والرموز |
| ملفات مصادقة النموذج | `/home/node/.openclaw/`           | تحميل حجم صوت المضيف          | رموز OAuth ومفاتيح API        |
| تهيئات Skills        | `/home/node/.openclaw/skills/`    | تحميل حجم صوت المضيف          | حالة على مستوى Skill          |
| مساحة عمل الوكيل     | `/home/node/.openclaw/workspace/` | تحميل حجم صوت المضيف          | الشيفرة وملفات الوكيل         |
| جلسة WhatsApp        | `/home/node/.openclaw/`           | تحميل حجم صوت المضيف          | يحافظ على تسجيل الدخول عبر QR |
| حلقة مفاتيح Gmail    | `/home/node/.openclaw/`           | وحدة تخزين المضيف + كلمة مرور | يتطلب `GOG_KEYRING_PASSWORD`  |
| الثنائيات الخارجية   | `/usr/local/bin/`                 | صورة Docker                   | يجب دمجها وقت البناء          |
| وقت تشغيل Node       | نظام ملفات الحاوية                | صورة Docker                   | يُعاد بناؤه مع كل بناء        |
| حزم نظام التشغيل     | نظام ملفات الحاوية                | صورة Docker                   | لا تثبّت وقت التشغيل          |
| حاوية Docker         | مؤقّت                             | قابلة لإعادة التشغيل          | آمنة للإزالة                  |

---

## التحديثات

لتحديث OpenClaw على الجهاز الافتراضي:

```bash
cd ~/openclaw
git pull
docker compose build
docker compose up -d
```

---

## استكشاف الأخطاء وإصلاحها

**رفض اتصال SSH**

قد يستغرق نشر مفاتيح SSH من 1 إلى 2 دقيقة بعد إنشاء الجهاز. انتظر ثم أعد المحاولة.

**مشكلات OS Login**

تحقق من ملف OS Login الخاص بك:

```bash
gcloud compute os-login describe-profile
```

تأكد من أن حسابك يمتلك أذونات IAM المطلوبة (Compute OS Login أو Compute OS Admin Login).

**نفاد الذاكرة (OOM)**

إذا كنت تستخدم e2-micro وتواجه OOM، قم بالترقية إلى e2-small أو e2-medium:

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

## حسابات الخدمة (أفضل ممارسات الأمان)

للاستخدام الشخصي، يعمل حساب المستخدم الافتراضي لديك بشكل جيد.

للأتمتة أو خطوط CI/CD، أنشئ حساب خدمة مخصصًا بأقل أذونات ممكنة:

1. إنشاء حساب خدمة:

   ```bash
   gcloud iam service-accounts create openclaw-deploy \
     --display-name="OpenClaw Deployment"
   ```

2. منح دور Compute Instance Admin (أو دور مخصص أضيق):

   ```bash
   gcloud projects add-iam-policy-binding my-openclaw-project \
     --member="serviceAccount:openclaw-deploy@my-openclaw-project.iam.gserviceaccount.com" \
     --role="roles/compute.instanceAdmin.v1"
   ```

تجنب استخدام دور Owner للأتمتة. اتبع مبدأ أقل الامتيازات.

راجع [https://cloud.google.com/iam/docs/understanding-roles](https://cloud.google.com/iam/docs/understanding-roles) لتفاصيل أدوار IAM.

---

## الخطوات التالية

- إعداد قنوات المراسلة: [Channels](/channels)
- إقران الأجهزة المحلية كعُقد: [Nodes](/nodes)
- تهيئة Gateway: [Gateway configuration](/gateway/configuration)
