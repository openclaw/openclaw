---
summary: "Windows (WSL2) ပံ့ပိုးမှု + companion app အခြေအနေ"
read_when:
  - Windows တွင် OpenClaw ကို ထည့်သွင်းတပ်ဆင်နေချိန်
  - Windows companion app အခြေအနေကို ရှာဖွေနေချိန်
title: "Windows (WSL2)"
---

# Windows (WSL2)

Windows ပေါ်တွင် OpenClaw ကို **WSL2 မှတစ်ဆင့်** (Ubuntu ကို အကြံပြုပါသည်) အသုံးပြုရန် အကြံပြုပါသည်။ CLI + Gateway သည် Linux အတွင်းတွင် run လုပ်သဖြင့် runtime ကို တူညီစေပြီး tooling ကို ပိုမို ကိုက်ညီစေပါသည် (Node/Bun/pnpm, Linux binaries, skills)။ Native Windows တွင် အသုံးပြုရာတွင် ပိုမို ခက်ခဲနိုင်ပါသည်။ WSL2 သည် Linux အပြည့်အစုံကို ပေးစွမ်းပြီး — install လုပ်ရန် command တစ်ကြိမ်သာ လိုအပ်ပါသည်: `wsl --install`။

Native Windows companion app များကို စီစဉ်ရေးဆွဲထားပြီးဖြစ်ပါသည်။

## Install (WSL2)

- [Getting Started](/start/getting-started) (WSL အတွင်းတွင် အသုံးပြုပါ)
- [Install & updates](/install/updating)
- Official WSL2 guide (Microsoft): [https://learn.microsoft.com/windows/wsl/install](https://learn.microsoft.com/windows/wsl/install)

## Gateway

- [Gateway runbook](/gateway)
- [Configuration](/gateway/configuration)

## Gateway service install (CLI)

WSL2 အတွင်းမှ:

```
openclaw onboard --install-daemon
```

သို့မဟုတ်:

```
openclaw gateway install
```

သို့မဟုတ်:

```
openclaw configure
```

မေးမြန်းလာပါက **Gateway service** ကို ရွေးချယ်ပါ။

Repair/migrate:

```
openclaw doctor
```

## Advanced: WSL services ကို LAN ပေါ်သို့ ဖော်ပြခြင်း (portproxy)

WSL တွင် ကိုယ်ပိုင် virtual network ရှိပါသည်။ အခြား machine တစ်လုံးမှ **WSL အတွင်း** run လုပ်နေသော service တစ်ခု (SSH, local TTS server, သို့မဟုတ် Gateway) ကို ချိတ်ဆက်လိုပါက Windows port တစ်ခုကို လက်ရှိ WSL IP သို့ forward လုပ်ရပါမည်။ WSL IP သည် restart ပြုလုပ်ပြီးနောက် ပြောင်းလဲသွားသဖြင့် forwarding rule ကို ပြန်လည် update လုပ်ရန် လိုအပ်နိုင်ပါသည်။

ဥပမာ (PowerShell **Administrator အဖြစ်**):

```powershell
$Distro = "Ubuntu-24.04"
$ListenPort = 2222
$TargetPort = 22

$WslIp = (wsl -d $Distro -- hostname -I).Trim().Split(" ")[0]
if (-not $WslIp) { throw "WSL IP not found." }

netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$ListenPort `
  connectaddress=$WslIp connectport=$TargetPort
```

Windows Firewall မှတစ်ဆင့် port ကို ခွင့်ပြုပါ (တစ်ကြိမ်တည်း):

```powershell
New-NetFirewallRule -DisplayName "WSL SSH $ListenPort" -Direction Inbound `
  -Protocol TCP -LocalPort $ListenPort -Action Allow
```

WSL restart ပြီးတိုင်း portproxy ကို refresh လုပ်ပါ:

```powershell
netsh interface portproxy delete v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 | Out-Null
netsh interface portproxy add v4tov4 listenport=$ListenPort listenaddress=0.0.0.0 `
  connectaddress=$WslIp connectport=$TargetPort | Out-Null
```

မှတ်ချက်များ:

- အခြားစက်မှ SSH ချိတ်ဆက်ရာတွင် **Windows host IP** ကို ဦးတည်ပါ (ဥပမာ: `ssh user@windows-host -p 2222`)။
- Remote နိုဒ်များသည် **ရောက်ရှိနိုင်သော** Gateway URL ကို ညွှန်ပြရပါမည် (`127.0.0.1` မဟုတ်ပါ) — အတည်ပြုရန် `openclaw status --all` ကို အသုံးပြုပါ။
- LAN ဝင်ရောက်မှုအတွက် `listenaddress=0.0.0.0` ကို အသုံးပြုပါ; `127.0.0.1` သည် local အတွင်းသာ ထိန်းထားပေးပါသည်။
- အလိုအလျောက် ပြုလုပ်လိုပါက login အချိန်တွင် refresh အဆင့်ကို လည်ပတ်စေရန် Scheduled Task တစ်ခုကို မှတ်ပုံတင်ပါ။

## WSL2 ထည့်သွင်းခြင်း အဆင့်လိုက်

### 1. WSL2 + Ubuntu ကို ထည့်သွင်းပါ

PowerShell (Admin) ကို ဖွင့်ပါ:

```powershell
wsl --install
# Or pick a distro explicitly:
wsl --list --online
wsl --install -d Ubuntu-24.04
```

Windows မှ reboot လုပ်ရန် တောင်းဆိုပါက ပြန်လည်စတင်ပါ။

### 2. systemd ကို ဖွင့်ပါ (gateway install အတွက် မဖြစ်မနေ လိုအပ်)

WSL terminal အတွင်းတွင်:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

ထို့နောက် PowerShell မှ:

```powershell
wsl --shutdown
```

Ubuntu ကို ပြန်ဖွင့်ပြီး အတည်ပြုပါ:

```bash
systemctl --user status
```

### 3. OpenClaw ကို ထည့်သွင်းပါ (WSL အတွင်း)

WSL အတွင်းမှ Linux Getting Started လမ်းကြောင်းကို လိုက်နာပါ:

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # auto-installs UI deps on first run
pnpm build
openclaw onboard
```

လမ်းညွှန် အပြည့်အစုံ: [Getting Started](/start/getting-started)

## Windows companion app

ယခုအချိန်တွင် Windows companion app မရှိသေးပါ။ ၎င်းကို အကောင်အထည်ဖော်ရန် ပါဝင်ကူညီလိုပါက contributions များကို ကြိုဆိုပါသည်။
