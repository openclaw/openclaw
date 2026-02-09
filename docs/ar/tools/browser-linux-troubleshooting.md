---
summary: "إصلاح مشكلات بدء تشغيل CDP في Chrome/Brave/Edge/Chromium للتحكم بالمتصفح في OpenClaw على Linux"
read_when: "يفشل التحكم بالمتصفح على Linux، خصوصًا مع Chromium بنظام snap"
title: "استكشاف أخطاء المتصفح وإصلاحها"
---

# استكشاف أخطاء المتصفح وإصلاحها (Linux)

## المشكلة: "Failed to start Chrome CDP on port 18800"

يفشل خادم التحكم بالمتصفح في OpenClaw في تشغيل Chrome/Brave/Edge/Chromium مع الخطأ:

```
{"error":"Error: Failed to start Chrome CDP on port 18800 for profile \"openclaw\"."}
```

### السبب الجذري

على Ubuntu (والعديد من توزيعات Linux)، يكون تثبيت Chromium الافتراضي عبارة عن **حزمة snap**. يتعارض تقييد AppArmor في snap مع الطريقة التي يقوم بها OpenClaw بإنشاء عملية المتصفح ومراقبتها.

يقوم الأمر `apt install chromium` بتثبيت حزمة وسيطة تعيد التوجيه إلى snap:

```
Note, selecting 'chromium-browser' instead of 'chromium'
chromium-browser is already the newest version (2:1snap1-0ubuntu2).
```

هذا **ليس** متصفحًا حقيقيًا — بل مجرد غلاف.

### الحل 1: تثبيت Google Chrome (موصى به)

قم بتثبيت حزمة Google Chrome الرسمية `.deb`، وهي غير معزولة بواسطة snap:

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
sudo apt --fix-broken install -y  # if there are dependency errors
```

ثم حدّث تهيئة OpenClaw لديك (`~/.openclaw/openclaw.json`):

```json
{
  "browser": {
    "enabled": true,
    "executablePath": "/usr/bin/google-chrome-stable",
    "headless": true,
    "noSandbox": true
  }
}
```

### الحل 2: استخدام Snap Chromium مع وضع «الارتباط فقط»

إذا كان لا بد من استخدام Chromium بنظام snap، فقم بتهيئة OpenClaw ليرتبط بمتصفح تم تشغيله يدويًا:

1. تحديث الإعداد:

```json
{
  "browser": {
    "enabled": true,
    "attachOnly": true,
    "headless": true,
    "noSandbox": true
  }
}
```

2. شغّل Chromium يدويًا:

```bash
chromium-browser --headless --no-sandbox --disable-gpu \
  --remote-debugging-port=18800 \
  --user-data-dir=$HOME/.openclaw/browser/openclaw/user-data \
  about:blank &
```

3. اختياريًا، أنشئ خدمة مستخدم systemd لبدء Chrome تلقائيًا:

```ini
# ~/.config/systemd/user/openclaw-browser.service
[Unit]
Description=OpenClaw Browser (Chrome CDP)
After=network.target

[Service]
ExecStart=/snap/bin/chromium --headless --no-sandbox --disable-gpu --remote-debugging-port=18800 --user-data-dir=%h/.openclaw/browser/openclaw/user-data about:blank
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

فعِّلها باستخدام: `systemctl --user enable --now openclaw-browser.service`

### التحقق من عمل المتصفح

تحقق من الحالة:

```bash
curl -s http://127.0.0.1:18791/ | jq '{running, pid, chosenBrowser}'
```

اختبر التصفح:

```bash
curl -s -X POST http://127.0.0.1:18791/start
curl -s http://127.0.0.1:18791/tabs
```

### مرجع التهيئة

| الخيار                   | الوصف                                                                            | الافتراضي                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `browser.enabled`        | تمكين التحكم بالمتصفح                                                            | `true`                                                                                          |
| `browser.executablePath` | مسار ملف متصفح قائم على Chromium (Chrome/Brave/Edge/Chromium) | يتم الاكتشاف تلقائيًا (يُفضِّل المتصفح الافتراضي إن كان قائمًا على Chromium) |
| `browser.headless`       | التشغيل دون واجهة رسومية                                                         | `false`                                                                                         |
| `browser.noSandbox`      | إضافة علامة `--no-sandbox` (مطلوبة لبعض إعدادات Linux)        | `false`                                                                                         |
| `browser.attachOnly`     | عدم تشغيل المتصفح، والاكتفاء بالارتباط بمتصفح موجود                              | `false`                                                                                         |
| `browser.cdpPort`        | منفذ بروتوكول أدوات المطوّر في Chrome                                            | `18800`                                                                                         |

### المشكلة: "Chrome extension relay is running, but no tab is connected"

أنت تستخدم ملف التعريف `chrome` (وسيط الامتداد). وهو يتوقع أن يكون امتداد متصفح OpenClaw مرتبطًا بعلامة تبويب نشطة.

خيارات الإصلاح:

1. **استخدام المتصفح المُدار:** `openclaw browser start --browser-profile openclaw`
   (أو تعيين `browser.defaultProfile: "openclaw"`).
2. **استخدام وسيط الامتداد:** ثبّت الامتداد، وافتح علامة تبويب، ثم انقر على أيقونة امتداد OpenClaw لربطه.

ملاحظات:

- يستخدم ملف التعريف `chrome` **متصفح Chromium الافتراضي للنظام** متى أمكن.
- تقوم ملفات التعريف المحلية `openclaw` بتعيين `cdpPort`/`cdpUrl` تلقائيًا؛ لا تقم بتعيينهما إلا لـ CDP البعيد.
