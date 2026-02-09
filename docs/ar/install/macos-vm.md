---
summary: "تشغيل OpenClaw داخل VM macOS معزول (محلي أو مُستضاف) عندما تحتاج إلى العزل أو iMessage"
read_when:
  - تريد عزل OpenClaw عن بيئة macOS الأساسية لديك
  - تريد تكامل iMessage ‏(BlueBubbles) داخل sandbox
  - تريد بيئة macOS قابلة لإعادة الضبط ويمكن استنساخها
  - تريد مقارنة خيارات VM macOS المحلية مقابل المُستضافة
title: "VMs macOS"
---

# OpenClaw على VMs macOS (Sandboxing)

## الإعداد الافتراضي الموصى به (لمعظم المستخدمين)

- **VPS لينكس صغير** لبوابة Gateway تعمل دائمًا وبتكلفة منخفضة. راجع [VPS hosting](/vps).
- **عتاد مخصّص** (Mac mini أو جهاز لينكس) إذا كنت تريد تحكمًا كاملًا و**عنوان IP سكني** لأتمتة المتصفح. تحظر العديد من المواقع عناوين IP الخاصة بمراكز البيانات، لذا غالبًا ما يعمل التصفح المحلي بشكل أفضل.
- **هجين:** أبقِ الـ Gateway على VPS رخيص، ووصل جهاز Mac لديك كـ **عُقدة** عند الحاجة إلى أتمتة المتصفح/واجهة المستخدم. راجع [Nodes](/nodes) و[Gateway remote](/gateway/remote).

استخدم VM macOS عندما تحتاج تحديدًا إلى قدرات حصرية لـ macOS (iMessage/BlueBubbles) أو عندما تريد عزلًا صارمًا عن جهاز Mac اليومي.

## خيارات VM macOS

### VM محلي على جهاز Apple Silicon Mac (Lume)

شغّل OpenClaw داخل VM macOS معزول على جهاز Apple Silicon Mac الحالي باستخدام [Lume](https://cua.ai/docs/lume).

يوفّر لك ذلك:

- بيئة macOS كاملة ومعزولة (يبقى النظام المضيف نظيفًا)
- دعم iMessage عبر BlueBubbles (غير ممكن على لينكس/ويندوز)
- إعادة ضبط فورية عبر استنساخ الـ VMs
- دون عتاد إضافي أو تكاليف سحابية

### مزوّدو Mac المُستضاف (السحابة)

إذا أردت macOS في السحابة، فمزوّدو Mac المُستضاف يعملون أيضًا:

- [MacStadium](https://www.macstadium.com/) (أجهزة Mac مُستضافة)
- يعمل مزوّدون آخرون لـ Mac المُستضاف أيضًا؛ اتبع مستندات VM + SSH الخاصة بهم

بمجرد حصولك على وصول SSH إلى VM macOS، تابع من الخطوة 6 أدناه.

---

## المسار السريع (Lume، للمستخدمين المتمرّسين)

1. تثبيت Lume
2. `lume create openclaw --os macos --ipsw latest`
3. إكمال Setup Assistant وتمكين Remote Login ‏(SSH)
4. `lume run openclaw --no-display`
5. الدخول عبر SSH، تثبيت OpenClaw، تهيئة القنوات
6. تم

---

## ما تحتاجه (Lume)

- جهاز Apple Silicon Mac ‏(M1/M2/M3/M4)
- macOS Sequoia أو أحدث على النظام المضيف
- ~60 جيجابايت مساحة قرص حرة لكل VM
- ~20 دقيقة

---

## 1. تثبيت Lume

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/trycua/cua/main/libs/lume/scripts/install.sh)"
```

إذا لم يكن `~/.local/bin` موجودًا في PATH لديك:

```bash
echo 'export PATH="$PATH:$HOME/.local/bin"' >> ~/.zshrc && source ~/.zshrc
```

تحقّق:

```bash
lume --version
```

المستندات: [Lume Installation](https://cua.ai/docs/lume/guide/getting-started/installation)

---

## 2. إنشاء VM macOS

```bash
lume create openclaw --os macos --ipsw latest
```

يقوم هذا بتنزيل macOS وإنشاء الـ VM. تُفتح نافذة VNC تلقائيًا.

ملاحظة: قد يستغرق التنزيل بعض الوقت حسب اتصالك.

---

## 3. إكمال Setup Assistant

في نافذة VNC:

1. اختر اللغة والمنطقة
2. تخطَّ Apple ID (أو سجّل الدخول إذا أردت iMessage لاحقًا)
3. أنشئ حساب مستخدم (تذكّر اسم المستخدم وكلمة المرور)
4. تخطَّ جميع الميزات الاختيارية

بعد اكتمال الإعداد، فعّل SSH:

1. افتح System Settings → General → Sharing
2. فعّل "Remote Login"

---

## 4. الحصول على عنوان IP للـ VM

```bash
lume get openclaw
```

ابحث عن عنوان IP (غالبًا `192.168.64.x`).

---

## 5. الدخول إلى الـ VM عبر SSH

```bash
ssh youruser@192.168.64.X
```

استبدل `youruser` بالحساب الذي أنشأته، واستبدل عنوان IP بعنوان الـ VM الخاص بك.

---

## 6. تثبيت OpenClaw

داخل الـ VM:

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

اتبع مطالبات التهيئة الأولية لإعداد موفّر النموذج لديك (Anthropic، OpenAI، إلخ).

---

## 7. تهيئة القنوات

حرّر ملف التهيئة:

```bash
nano ~/.openclaw/openclaw.json
```

أضف قنواتك:

```json
{
  "channels": {
    "whatsapp": {
      "dmPolicy": "allowlist",
      "allowFrom": ["+15551234567"]
    },
    "telegram": {
      "botToken": "YOUR_BOT_TOKEN"
    }
  }
}
```

ثم سجّل الدخول إلى WhatsApp (مسح رمز QR):

```bash
openclaw channels login
```

---

## 8. تشغيل الـ VM دون واجهة

أوقف الـ VM وأعد تشغيله دون عرض:

```bash
lume stop openclaw
lume run openclaw --no-display
```

سيعمل الـ VM في الخلفية. يحافظ daemon الخاص بـ OpenClaw على تشغيل الـ Gateway.

للتحقق من الحالة:

```bash
ssh youruser@192.168.64.X "openclaw status"
```

---

## إضافة: تكامل iMessage

هذه هي الميزة الحاسمة للتشغيل على macOS. استخدم [BlueBubbles](https://bluebubbles.app) لإضافة iMessage إلى OpenClaw.

داخل الـ VM:

1. نزّل BlueBubbles من bluebubbles.app
2. سجّل الدخول باستخدام Apple ID
3. فعّل Web API وحدّد كلمة مرور
4. وجّه Webhooks الخاصة بـ BlueBubbles إلى الـ Gateway لديك (مثال: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`)

أضِف إلى تهيئة OpenClaw:

```json
{
  "channels": {
    "bluebubbles": {
      "serverUrl": "http://localhost:1234",
      "password": "your-api-password",
      "webhookPath": "/bluebubbles-webhook"
    }
  }
}
```

أعد تشغيل الـ Gateway. الآن يمكن للوكيل إرسال واستقبال iMessages.

تفاصيل الإعداد الكاملة: [BlueBubbles channel](/channels/bluebubbles)

---

## حفظ صورة ذهبية

قبل إجراء تخصيصات إضافية، التقط لقطة لحالتك النظيفة:

```bash
lume stop openclaw
lume clone openclaw openclaw-golden
```

إعادة الضبط في أي وقت:

```bash
lume stop openclaw && lume delete openclaw
lume clone openclaw-golden openclaw
lume run openclaw --no-display
```

---

## التشغيل على مدار الساعة 24/7

حافظ على تشغيل الـ VM عبر:

- إبقاء جهاز Mac موصولًا بالطاقة
- تعطيل السكون في System Settings → Energy Saver
- استخدام `caffeinate` عند الحاجة

للتشغيل الدائم الحقيقي، فكّر في Mac mini مخصّص أو VPS صغير. راجع [VPS hosting](/vps).

---

## استكشاف الأخطاء وإصلاحها

| المشكلة                   | الحل                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| لا يمكن الدخول عبر SSH    | تأكّد من تمكين "Remote Login" في System Settings داخل الـ VM                                                 |
| لا يظهر IP للـ VM         | انتظر حتى يكتمل إقلاع الـ VM، ثم شغّل `lume get openclaw` مرة أخرى                                           |
| أمر Lume غير موجود        | أضِف `~/.local/bin` إلى PATH لديك                                                                            |
| لا يتم مسح QR لـ WhatsApp | تأكّد من تسجيل دخولك داخل الـ VM (وليس النظام المضيف) عند تشغيل `openclaw channels login` |

---

## مستندات ذات صلة

- [VPS hosting](/vps)
- [Nodes](/nodes)
- [Gateway remote](/gateway/remote)
- [BlueBubbles channel](/channels/bluebubbles)
- [Lume Quickstart](https://cua.ai/docs/lume/guide/getting-started/quickstart)
- [Lume CLI Reference](https://cua.ai/docs/lume/reference/cli-reference)
- [Unattended VM Setup](https://cua.ai/docs/lume/guide/fundamentals/unattended-setup) (متقدم)
- [Docker Sandboxing](/install/docker) (نهج بديل للعزل)
