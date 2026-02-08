---
summary: "Linux ပံ့ပိုးမှု + companion app အခြေအနေ"
read_when:
  - Linux companion app အခြေအနေကို ရှာဖွေနေချိန်
  - ပလက်ဖောင်း အကျုံးဝင်မှု သို့မဟုတ် ပါဝင်ကူညီမှုများကို စီစဉ်နေချိန်
title: "Linux အက်ပ်"
x-i18n:
  source_path: platforms/linux.md
  source_hash: 93b8250cd1267004
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:35Z
---

# Linux အက်ပ်

Gateway（ဂိတ်ဝေး） ကို Linux တွင် အပြည့်အဝ ပံ့ပိုးထားပါသည်။ **Node ကို အကြံပြုထားသော runtime** အဖြစ် သုံးရန် အကြံပြုပါသည်။
Gateway အတွက် Bun ကို မအကြံပြုပါ (WhatsApp/Telegram အပြစ်အနာအဆာများကြောင့်)။

Native Linux companion apps များကို စီမံကိန်းအဖြစ် စီစဉ်ထားပါသည်။ တစ်ခုတည်ဆောက်ရန် ကူညီလိုပါက ပါဝင်ကူညီနိုင်ပါသည်။

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

OpenClaw သည် ပုံမှန်အားဖြင့် systemd **user** service ကို ထည့်သွင်းတပ်ဆင်ပါသည်။ မျှဝေသုံးစွဲရန် သို့မဟုတ် အမြဲဖွင့်ထားရသော ဆာဗာများအတွက် **system** service ကို အသုံးပြုပါ။ unit အပြည့်အစုံ ဥပမာနှင့် လမ်းညွှန်ချက်များကို [Gateway runbook](/gateway) တွင် ရရှိနိုင်ပါသည်။

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
