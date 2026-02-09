---
summary: "إلغاء تثبيت OpenClaw بالكامل (CLI، الخدمة، الحالة، مساحة العمل)"
read_when:
  - تريد إزالة OpenClaw من جهاز
  - لا تزال خدمة Gateway قيد التشغيل بعد إلغاء التثبيت
title: "إلغاء التثبيت"
---

# إلغاء التثبيت

مساران:

- **المسار السهل** إذا كان `openclaw` لا يزال مُثبّتًا.
- **الإزالة اليدوية للخدمة** إذا اختفى CLI لكن الخدمة لا تزال قيد التشغيل.

## المسار السهل (لا يزال CLI مُثبّتًا)

مُوصى به: استخدم أداة إلغاء التثبيت المدمجة:

```bash
openclaw uninstall
```

غير تفاعلي (الأتمتة / npx):

```bash
openclaw uninstall --all --yes --non-interactive
npx -y openclaw uninstall --all --yes --non-interactive
```

خطوات يدوية (النتيجة نفسها):

1. إيقاف خدمة Gateway:

```bash
openclaw gateway stop
```

2. إلغاء تثبيت خدمة Gateway (launchd/systemd/schtasks):

```bash
openclaw gateway uninstall
```

3. حذف الحالة + التهيئة:

```bash
rm -rf "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
```

إذا قمت بتعيين `OPENCLAW_CONFIG_PATH` إلى موقع مخصّص خارج دليل الحالة، فاحذف ذلك الملف أيضًا.

4. حذف مساحة العمل الخاصة بك (اختياري، يزيل ملفات الوكيل):

```bash
rm -rf ~/.openclaw/workspace
```

5. إزالة تثبيت CLI (اختر الطريقة التي استخدمتها):

```bash
npm rm -g openclaw
pnpm remove -g openclaw
bun remove -g openclaw
```

6. إذا قمت بتثبيت تطبيق macOS:

```bash
rm -rf /Applications/OpenClaw.app
```

ملاحظات:

- إذا استخدمت ملفات تعريف (`--profile` / `OPENCLAW_PROFILE`)، فأعد الخطوة 3 لكل دليل حالة (الافتراضيات هي `~/.openclaw-<profile>`).
- في الوضع البعيد، يوجد دليل الحالة على **مضيف Gateway**، لذا نفّذ الخطوات 1–4 هناك أيضًا.

## الإزالة اليدوية للخدمة (CLI غير مُثبّت)

استخدم هذا إذا استمرت خدمة Gateway في العمل لكن `openclaw` غير موجود.

### macOS (launchd)

الوسم الافتراضي هو `bot.molt.gateway` (أو `bot.molt.<profile>`؛ وقد يظل `com.openclaw.*` القديم موجودًا):

```bash
launchctl bootout gui/$UID/bot.molt.gateway
rm -f ~/Library/LaunchAgents/bot.molt.gateway.plist
```

إذا استخدمت ملف تعريف، فاستبدل الوسم واسم plist بـ `bot.molt.<profile>`. وأزل أي ملفات plist قديمة من `com.openclaw.*` إن وُجدت.

### Linux (وحدة systemd للمستخدم)

اسم الوحدة الافتراضي هو `openclaw-gateway.service` (أو `openclaw-gateway-<profile>.service`):

```bash
systemctl --user disable --now openclaw-gateway.service
rm -f ~/.config/systemd/user/openclaw-gateway.service
systemctl --user daemon-reload
```

### Windows (مهمة مجدولة)

اسم المهمة الافتراضي هو `OpenClaw Gateway` (أو `OpenClaw Gateway (<profile>)`).
يوجد نص المهمة ضمن دليل الحالة لديك.

```powershell
schtasks /Delete /F /TN "OpenClaw Gateway"
Remove-Item -Force "$env:USERPROFILE\.openclaw\gateway.cmd"
```

إذا استخدمت ملف تعريف، فاحذف اسم المهمة المطابق و`~\.openclaw-<profile>\gateway.cmd`.

## التثبيت العادي مقابل استنساخ المصدر

### التثبيت العادي (install.sh / npm / pnpm / bun)

إذا استخدمت `https://openclaw.ai/install.sh` أو `install.ps1`، فقد تم تثبيت CLI باستخدام `npm install -g openclaw@latest`.
قم بإزالته باستخدام `npm rm -g openclaw` (أو `pnpm remove -g` / `bun remove -g` إذا ثبّتَّ بهذه الطريقة).

### استنساخ المصدر (git clone)

إذا كنت تشغّل من مستودع مُستنسخ (`git clone` + `openclaw ...` / `bun run openclaw ...`):

1. ألغِ تثبيت خدمة Gateway **قبل** حذف المستودع (استخدم المسار السهل أعلاه أو الإزالة اليدوية للخدمة).
2. احذف دليل المستودع.
3. أزل الحالة + مساحة العمل كما هو موضح أعلاه.
