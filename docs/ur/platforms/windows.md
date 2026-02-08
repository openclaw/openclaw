---
summary: "Windows (WSL2) سپورٹ + معاون ایپ کی حیثیت"
read_when:
  - Windows پر OpenClaw انسٹال کرتے وقت
  - Windows معاون ایپ کی حیثیت تلاش کرتے وقت
title: "Windows (WSL2)"
x-i18n:
  source_path: platforms/windows.md
  source_hash: d17df1bd5636502e
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:32Z
---

# Windows (WSL2)

Windows پر OpenClaw کی سفارش **WSL2 کے ذریعے** کی جاتی ہے (Ubuntu کی سفارش کی جاتی ہے)۔  
CLI + Gateway لینکس کے اندر چلتے ہیں، جس سے رن ٹائم یکساں رہتا ہے اور ٹولنگ کہیں زیادہ ہم آہنگ ہوتی ہے (Node/Bun/pnpm، Linux بائنریز، skills)۔  
Native Windows قدرے مشکل ہو سکتا ہے۔ WSL2 آپ کو مکمل Linux تجربہ دیتا ہے — انسٹال کرنے کے لیے ایک ہی کمانڈ: `wsl --install`۔

Native Windows معاون ایپس منصوبہ بندی میں ہیں۔

## Install (WSL2)

- [Getting Started](/start/getting-started) (WSL کے اندر استعمال کریں)
- [Install & updates](/install/updating)
- سرکاری WSL2 گائیڈ (Microsoft): [https://learn.microsoft.com/windows/wsl/install](https://learn.microsoft.com/windows/wsl/install)

## Gateway

- [Gateway runbook](/gateway)
- [Configuration](/gateway/configuration)

## Gateway سروس انسٹال (CLI)

WSL2 کے اندر:

```
openclaw onboard --install-daemon
```

یا:

```
openclaw gateway install
```

یا:

```
openclaw configure
```

پرومپٹ آنے پر **Gateway service** منتخب کریں۔

مرمت/منتقلی:

```
openclaw doctor
```

## Advanced: WSL سروسز کو LAN پر ایکسپوز کریں (portproxy)

WSL کا اپنا ورچوئل نیٹ ورک ہوتا ہے۔ اگر کسی دوسری مشین کو **WSL کے اندر** چلنے والی سروس تک پہنچنا ہو (SSH، ایک مقامی TTS سرور، یا Gateway)، تو آپ کو Windows پورٹ کو موجودہ WSL IP پر فارورڈ کرنا ہوگا۔ WSL IP ری اسٹارٹ کے بعد بدل جاتا ہے، اس لیے آپ کو فارورڈنگ رول تازہ کرنا پڑ سکتا ہے۔

مثال (PowerShell **بطور Administrator**):

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "WSL IP not found." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort
```

Windows Firewall کے ذریعے پورٹ کی اجازت دیں (ایک بار):

```powershell
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

WSL کے ری اسٹارٹ کے بعد portproxy کو ریفریش کریں:

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

نوٹس:

- کسی دوسری مشین سے SSH **Windows host IP** کو ہدف بناتا ہے (مثال: `ssh user@windows-host -p 2222`)۔
- ریموٹ نوڈز کو **قابلِ رسائی** Gateway URL کی طرف اشارہ کرنا چاہیے ( `127.0.0.1` نہیں)؛ تصدیق کے لیے
  `openclaw status --all` استعمال کریں۔
- LAN رسائی کے لیے `listenaddress=0.0.0.0` استعمال کریں؛ `127.0.0.1` اسے صرف مقامی رکھتا ہے۔
- اگر آپ اسے خودکار بنانا چاہتے ہیں تو لاگ اِن پر ریفریش مرحلہ چلانے کے لیے ایک Scheduled Task رجسٹر کریں۔

## مرحلہ وار WSL2 انسٹال

### 1) WSL2 + Ubuntu انسٹال کریں

PowerShell کھولیں (Admin):

```powershell
wsl --install
# Or pick a distro explicitly:
wsl --list --online
wsl --install -d Ubuntu-24.04
```

اگر Windows کہے تو ری بوٹ کریں۔

### 2) systemd فعال کریں (Gateway انسٹال کے لیے ضروری)

اپنے WSL ٹرمینل میں:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

پھر PowerShell سے:

```powershell
wsl --shutdown
```

Ubuntu دوبارہ کھولیں، پھر تصدیق کریں:

```bash
systemctl --user status
```

### 3) OpenClaw انسٹال کریں (WSL کے اندر)

WSL کے اندر Linux Getting Started فلو کی پیروی کریں:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # auto-installs UI deps on first run
pnpm build
openclaw onboard
```

مکمل گائیڈ: [Getting Started](/start/getting-started)

## Windows معاون ایپ

ابھی ہمارے پاس Windows معاون ایپ موجود نہیں ہے۔ اگر آپ اسے ممکن بنانے کے لیے تعاون کرنا چاہتے ہیں تو شراکتیں خوش آئند ہیں۔
