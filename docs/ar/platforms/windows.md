---
summary: "دعم Windows (WSL2) + حالة التطبيق المُرافِق"
read_when:
  - تثبيت OpenClaw على Windows
  - البحث عن حالة تطبيق Windows المُرافِق
title: "Windows (WSL2)"
---

# Windows (WSL2)

يُنصَح بتشغيل OpenClaw على Windows **عبر WSL2** (يوصى بـ Ubuntu). يعمل كلٌّ من
CLI وGateway داخل Linux، ما يحافظ على اتساق بيئة التشغيل ويجعل الأدوات أكثر
توافقًا بكثير (Node/Bun/pnpm، ثنائيات Linux، Skills). قد يكون Windows الأصلي
أكثر تعقيدًا. يوفّر WSL2 تجربة Linux كاملة — أمر واحد للتثبيت: `wsl --install`.

التطبيقات المُرافِقة الأصلية لـ Windows مُخطَّط لها.

## التثبيت (WSL2)

- [بدء الاستخدام](/start/getting-started) (استخدمه داخل WSL)
- [التثبيت والتحديثات](/install/updating)
- دليل WSL2 الرسمي (Microsoft): [https://learn.microsoft.com/windows/wsl/install](https://learn.microsoft.com/windows/wsl/install)

## Gateway

- [دليل تشغيل Gateway](/gateway)
- [التهيئة](/gateway/configuration)

## تثبيت خدمة Gateway (CLI)

داخل WSL2:

```
openclaw onboard --install-daemon
```

أو:

```
openclaw gateway install
```

أو:

```
openclaw configure
```

اختر **Gateway service** عند المطالبة.

الإصلاح/الترحيل:

```
openclaw doctor
```

## متقدم: إتاحة خدمات WSL عبر الشبكة المحلية (portproxy)

يمتلك WSL شبكة افتراضية خاصة به. إذا احتاج جهاز آخر إلى الوصول إلى خدمة
تعمل **داخل WSL** (SSH، خادم TTS محلي، أو Gateway)، فيجب
إعادة توجيه منفذ Windows إلى عنوان IP الحالي لـ WSL. يتغيّر عنوان IP لـ WSL بعد
إعادة التشغيل، لذا قد تحتاج إلى تحديث قاعدة إعادة التوجيه.

مثال (PowerShell **كمسؤول**):

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "WSL IP not found." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort
```

السماح للمنفذ عبر جدار حماية Windows (مرة واحدة):

```powershell
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

تحديث portproxy بعد إعادة تشغيل WSL:

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

ملاحظات:

- يستهدف SSH من جهاز آخر **عنوان IP لمضيف Windows** (مثال: `ssh user@windows-host -p 2222`).
- يجب أن تشير العُقد البعيدة إلى عنوان URL لـ Gateway **قابل للوصول** (وليس `127.0.0.1`)؛ استخدم
  `openclaw status --all` للتأكيد.
- استخدم `listenaddress=0.0.0.0` للوصول عبر الشبكة المحلية؛ و`127.0.0.1` يبقيه محليًا فقط.
- إذا رغبت في الأتمتة، سجّل مهمة مجدولة لتشغيل خطوة التحديث عند تسجيل الدخول.

## تثبيت WSL2 خطوة بخطوة

### 1. تثبيت WSL2 + Ubuntu

افتح PowerShell (كمسؤول):

```powershell
wsl --install
# Or pick a distro explicitly:
wsl --list --online
wsl --install -d Ubuntu-24.04
```

أعِد التشغيل إذا طلب Windows ذلك.

### 2. تمكين systemd (مطلوب لتثبيت Gateway)

في طرفية WSL لديك:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

ثم من PowerShell:

```powershell
wsl --shutdown
```

أعِد فتح Ubuntu، ثم تحقّق:

```bash
systemctl --user status
```

### 3. تثبيت OpenClaw (داخل WSL)

اتبع مسار «بدء الاستخدام» الخاص بـ Linux داخل WSL:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # auto-installs UI deps on first run
pnpm build
openclaw onboard
```

الدليل الكامل: [بدء الاستخدام](/start/getting-started)

## تطبيق Windows المُرافِق

لا يتوفر لدينا تطبيق مُرافِق لـ Windows بعد. نرحّب بالمساهمات إذا رغبت
في المساعدة على تحقيق ذلك.
