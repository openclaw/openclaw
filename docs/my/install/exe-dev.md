---
summary: "အဝေးမှ ဝင်ရောက်အသုံးပြုရန် exe.dev (VM + HTTPS proxy) ပေါ်တွင် OpenClaw Gateway ကို လည်ပတ်စေပါ"
read_when:
  - Gateway အတွက် စျေးသက်သာပြီး အမြဲလည်ပတ်နေသော Linux ဟို့စ် တစ်ခု လိုအပ်သောအခါ
  - ကိုယ်ပိုင် VPS မလုပ်ဘဲ အဝေးမှ Control UI ကို ဝင်ရောက်အသုံးပြုလိုသောအခါ
title: "exe.dev"
x-i18n:
  source_path: install/exe-dev.md
  source_hash: 72ab798afd058a76
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:32Z
---

# exe.dev

ရည်ရွယ်ချက်: exe.dev VM ပေါ်တွင် OpenClaw Gateway ကို လည်ပတ်စေပြီး သင့်လက်ပ်တော့မှ `https://<vm-name>.exe.xyz` မှတဆင့် ဝင်ရောက်နိုင်စေရန်

ဤစာမျက်နှာသည် exe.dev ၏ မူလ **exeuntu** image ကို အခြေခံထားပါသည်။ အခြား distro ကို ရွေးထားပါက package များကို သင့်တော်အောင် ပြောင်းလဲသတ်မှတ်ပါ။

## Beginner quick path

1. [https://exe.new/openclaw](https://exe.new/openclaw)
2. လိုအပ်ပါက သင့် auth key/token ကို ဖြည့်ပါ
3. သင့် VM ဘေးရှိ "Agent" ကို နှိပ်ပြီး စောင့်ပါ…
4. ???
5. အကျိုးအမြတ်!

## What you need

- exe.dev အကောင့်
- [exe.dev](https://exe.dev) virtual machines သို့ `ssh exe.dev` ဝင်ရောက်ခွင့် (ရွေးချယ်နိုင်သည်)

## Automated Install with Shelley

Shelley သည် [exe.dev](https://exe.dev) ၏ agent ဖြစ်ပြီး၊ ကျွန်ုပ်တို့၏
prompt ကို အသုံးပြု၍ OpenClaw ကို ချက်ချင်း ထည့်သွင်းနိုင်ပါသည်။ အသုံးပြုသော prompt သည် အောက်ပါအတိုင်း ဖြစ်ပါသည်—

```
Set up OpenClaw (https://docs.openclaw.ai/install) on this VM. Use the non-interactive and accept-risk flags for openclaw onboarding. Add the supplied auth or token as needed. Configure nginx to forward from the default port 18789 to the root location on the default enabled site config, making sure to enable Websocket support. Pairing is done by "openclaw devices list" and "openclaw device approve <request id>". Make sure the dashboard shows that OpenClaw's health is OK. exe.dev handles forwarding from port 8000 to port 80/443 and HTTPS for us, so the final "reachable" should be <vm-name>.exe.xyz, without port specification.
```

## Manual installation

## 1) Create the VM

သင့်စက်မှ—

```bash
ssh exe.dev new
```

ထို့နောက် ချိတ်ဆက်ပါ—

```bash
ssh <vm-name>.exe.xyz
```

အကြံပြုချက်: ဤ VM ကို **stateful** အဖြစ် ထားပါ။ OpenClaw သည် `~/.openclaw/` နှင့် `~/.openclaw/workspace/` အောက်တွင် state ကို သိမ်းဆည်းထားပါသည်။

## 2) Install prerequisites (on the VM)

```bash
sudo apt-get update
sudo apt-get install -y git curl jq ca-certificates openssl
```

## 3) Install OpenClaw

OpenClaw install script ကို လုပ်ဆောင်ပါ—

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

## 4) Setup nginx to proxy OpenClaw to port 8000

`/etc/nginx/sites-enabled/default` ကို ပြင်ဆင်ပြီး အောက်ပါအတိုင်း ထည့်ပါ—

```
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    listen 8000;
    listen [::]:8000;

    server_name _;

    location / {
        proxy_pass http://127.0.0.1:18789;
        proxy_http_version 1.1;

        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Standard proxy headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeout settings for long-lived connections
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

## 5) Access OpenClaw and grant privileges

`https://<vm-name>.exe.xyz/` ကို ဝင်ရောက်ပါ (onboarding အတွင်း Control UI output ကို ကြည့်ပါ)။ auth တောင်းဆိုလာပါက VM ပေါ်ရှိ `gateway.auth.token` မှ token ကို ကူးထည့်ပါ (`openclaw config get gateway.auth.token` ဖြင့် ပြန်လည်ရယူနိုင်သည်၊ သို့မဟုတ် `openclaw doctor --generate-gateway-token` ဖြင့် အသစ်ဖန်တီးနိုင်သည်)။ စက်များကို `openclaw devices list` နှင့်
`openclaw devices approve <requestId>` ဖြင့် အတည်ပြုခွင့်ပေးပါ။ မသေချာပါက သင့်ဘရောက်ဇာမှ Shelley ကို အသုံးပြုပါ!

## Remote Access

Remote access ကို [exe.dev](https://exe.dev) ၏ authentication မှ ကိုင်တွယ်ဆောင်ရွက်ပါသည်။ မူလအနေဖြင့် port 8000 မှ HTTP traffic ကို email auth ဖြင့် `https://<vm-name>.exe.xyz` သို့ forward လုပ်ပေးပါသည်။

## Updating

```bash
npm i -g openclaw@latest
openclaw doctor
openclaw gateway restart
openclaw health
```

လမ်းညွှန်: [Updating](/install/updating)
