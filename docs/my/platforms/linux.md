---
summary: "Linux ပံ့ပိုးမှု + companion app အခြေအနေ"
read_when:
  - Linux companion app အခြေအနေကို ရှာဖွေနေချိန်
  - ပလက်ဖောင်း အကျုံးဝင်မှု သို့မဟုတ် ပါဝင်ကူညီမှုများကို စီစဉ်နေချိန်
title: "Linux အက်ပ်"
---

# Linux အက်ပ်

9. Gateway ကို Linux ပေါ်တွင် အပြည့်အဝ ပံ့ပိုးထားပါသည်။ 10. **Node သည် အကြံပြုထားသော runtime ဖြစ်သည်**။
10. Gateway အတွက် Bun ကို မအကြံပြုပါ (WhatsApp/Telegram bug များကြောင့်)။

12. Native Linux companion app များကို စီစဉ်ထားပါသည်။ Contributions are welcome if you want to help build one.

## Beginner quick path (VPS)

1. Node 22+ ကို ထည့်သွင်းတပ်ဆင်ပါ
2. `npm i -g openclaw@latest`
3. `openclaw onboard --install-daemon`
4. သင့်လက်ပ်တော့မှ: `ssh -N -L 18789:127.0.0.1:18789 <user>@<host>`
5. `http://127.0.0.1:18789/` ကို ဖွင့်ပြီး သင့် token ကို ကူးထည့်ပါ

VPS အတွက် အဆင့်လိုက် လမ်းညွှန်: [exe.dev](/install/exe-dev)

## Install

- [Getting Started](/start/getting-started)
- [Install & updates](/install/updating)
- Optional flows: [Bun (experimental)](/install/bun), [Nix](/install/nix), [Docker](/install/docker)

## Gateway

- [Gateway runbook](/gateway)
- [Configuration](/gateway/configuration)

## Gateway service install (CLI)

အောက်ပါထဲမှ တစ်ခုကို အသုံးပြုပါ:

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

ပြုပြင်ခြင်း/ပြောင်းရွှေ့ခြင်း:

```
openclaw doctor
```

## System control (systemd user unit)

14. OpenClaw သည် ပုံမှန်အားဖြင့် systemd **user** service ကို ထည့်သွင်းပေးပါသည်။ 15. မျှဝေသုံးစွဲသည့် သို့မဟုတ် အမြဲဖွင့်ထားသော server များအတွက် **system** service ကို အသုံးပြုပါ။ 16. unit အပြည့်အစုံ ဥပမာနှင့် လမ်းညွှန်ချက်များကို [Gateway runbook](/gateway) တွင် ကြည့်နိုင်ပါသည်။

အနည်းဆုံး တပ်ဆင်ခြင်း:

`~/.config/systemd/user/openclaw-gateway[-<profile>].service` ကို ဖန်တီးပါ:

```
[Unit]
Description=OpenClaw Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

ဖွင့်အသုံးပြုရန်:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```
