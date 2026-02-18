---
summary: "အဝေးမှ ဝင်ရောက်အသုံးပြုရန် exe.dev (VM + HTTPS proxy) ပေါ်တွင် OpenClaw Gateway ကို လည်ပတ်စေပါ"
read_when:
  - Gateway အတွက် စျေးသက်သာပြီး အမြဲလည်ပတ်နေသော Linux ဟို့စ် တစ်ခု လိုအပ်သောအခါ
  - ကိုယ်ပိုင် VPS မလုပ်ဘဲ အဝေးမှ Control UI ကို ဝင်ရောက်အသုံးပြုလိုသောအခါ
title: "exe.dev"
---

# exe.dev

ရည်ရွယ်ချက်: exe.dev VM ပေါ်တွင် OpenClaw Gateway ကို လည်ပတ်စေပြီး သင့်လက်ပ်တော့မှ `https://<vm-name>.exe.xyz` မှတဆင့် ဝင်ရောက်နိုင်စေရန်

ဒီစာမျက်နှာက exe.dev ရဲ့ မူလ **exeuntu** image ကို အခြေခံထားပါတယ်။ မတူတဲ့ distro ကို ရွေးထားရင် packages တွေကို လိုက်လျောညီထွေ mapping လုပ်ပါ။

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

Shelley, [exe.dev](https://exe.dev) ရဲ့ agent က ကျွန်ုပ်တို့ရဲ့ prompt ကို အသုံးပြုပြီး OpenClaw ကို ချက်ချင်း install လုပ်ပေးနိုင်ပါတယ်။ အသုံးပြုထားတဲ့ prompt က အောက်ပါအတိုင်း ဖြစ်ပါတယ်။

```
Set up OpenClaw (https://docs.openclaw.ai/install) on this VM. Use the non-interactive and accept-risk flags for openclaw onboarding. Add the supplied auth or token as needed. Configure nginx to forward from the default port 18789 to the root location on the default enabled site config, making sure to enable Websocket support. Pairing is done by "openclaw devices list" and "openclaw device approve <request id>". Make sure the dashboard shows that OpenClaw's health is OK. exe.dev handles forwarding from port 8000 to port 80/443 and HTTPS for us, so the final "reachable" should be <vm-name>.exe.xyz, without port specification.
```

## Manual installation

## 1. Create the VM

သင့်စက်မှ—

```bash
ssh exe.dev new
```

ထို့နောက် ချိတ်ဆက်ပါ—

```bash
ssh <vm-name>.exe.xyz
```

အကြံပြုချက်: ဒီ VM ကို **stateful** အဖြစ် ထားပါ။ OpenClaw က state ကို `~/.openclaw/` နဲ့ `~/.openclaw/workspace/` အောက်မှာ သိမ်းဆည်းထားပါတယ်။

## 2. Install prerequisites (on the VM)

```bash
sudo apt-get update
sudo apt-get install -y git curl jq ca-certificates openssl
```

## 3. Install OpenClaw

OpenClaw install script ကို လုပ်ဆောင်ပါ—

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

## 4. Setup nginx to proxy OpenClaw to port 8000

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

## 5. Access OpenClaw and grant privileges

`https://<vm-name>.exe.xyz/` ကို ဝင်ရောက်ပါ (onboarding အချိန် Control UI output ကို ကြည့်ပါ)။ Auth တောင်းဆိုလာရင် VM ပေါ်က `gateway.auth.token` ကို ကူးထည့်ပါ (`openclaw config get gateway.auth.token` နဲ့ ရယူနိုင်သလို `openclaw doctor --generate-gateway-token` နဲ့ အသစ်ဖန်တီးနိုင်ပါတယ်)။ `openclaw devices list` နဲ့ devices တွေကို အတည်ပြုပါ၊ ပြီးတော့ `openclaw devices approve <requestId>` ကို သုံးပါ။ မသေချာရင် သင့် browser ကနေ Shelley ကို သုံးပါ!

## Remote Access

Remote access ကို [exe.dev](https://exe.dev) ရဲ့ authentication က ကိုင်တွယ်ပေးပါတယ်။ မူလအတိုင်း port 8000 မှ HTTP traffic ကို email auth နဲ့ `https://<vm-name>.exe.xyz` သို့ forward လုပ်ပေးပါတယ်။

## Updating

```bash
npm i -g openclaw@latest
openclaw doctor
openclaw gateway restart
openclaw health
```

လမ်းညွှန်: [Updating](/install/updating)
