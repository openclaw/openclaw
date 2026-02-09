---
summary: "DigitalOcean ပေါ်တွင် OpenClaw (လွယ်ကူသော အခပေး VPS ရွေးချယ်မှု)"
read_when:
  - DigitalOcean ပေါ်တွင် OpenClaw ကို တပ်ဆင်နေချိန်
  - OpenClaw အတွက် စျေးသက်သာသော VPS hosting ကို ရှာဖွေနေချိန်
title: "DigitalOcean"
---

# DigitalOcean ပေါ်ရှိ OpenClaw

## ရည်မှန်းချက်

DigitalOcean ပေါ်တွင် **တစ်လ $6** (သို့မဟုတ် reserved pricing ဖြင့် $4/လ) ဖြင့် အမြဲတမ်းလည်ပတ်နေသော OpenClaw Gateway တစ်ခုကို အလုပ်လုပ်စေခြင်း။

တစ်လ $0 ဖြင့် အသုံးပြုလိုပြီး ARM + provider အလိုက် သတ်မှတ်ထားသော setup ကို မကြောက်ပါက [Oracle Cloud guide](/platforms/oracle) ကို ကြည့်ပါ။

## ကုန်ကျစရိတ် နှိုင်းယှဉ်မှု (2026)

| Provider     | Plan            | Specs                  | Price/mo                                                       | Notes                                 |
| ------------ | --------------- | ---------------------- | -------------------------------------------------------------- | ------------------------------------- |
| Oracle Cloud | Always Free ARM | up to 4 OCPU, 24GB RAM | $0                                                             | ARM, limited capacity / signup quirks |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM        | €3.79 (~$4) | Cheapest paid option                  |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM        | $6                                                             | Easy UI, good docs                    |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM        | $6                                                             | Many locations                        |
| Linode       | Nanode          | 1 vCPU, 1GB RAM        | $5                                                             | Now part of Akamai                    |

**Provider ကို ရွေးချယ်ခြင်း:**

- DigitalOcean: UX အလွယ်ဆုံး + ခန့်မှန်းနိုင်သော setup (ဤလမ်းညွှန်)
- Hetzner: စျေးနှုန်း/စွမ်းဆောင်ရည် ကောင်း ( [Hetzner guide](/install/hetzner) ကို ကြည့်ပါ)
- Oracle Cloud: တစ်လ $0 ဖြစ်နိုင်သော်လည်း စိတ်ရှုပ်စရာပိုများပြီး ARM သာဖြစ်သည် ([Oracle guide](/platforms/oracle) ကို ကြည့်ပါ)

---

## ကြိုတင်လိုအပ်ချက်များ

- DigitalOcean အကောင့် ([signup with $200 free credit](https://m.do.co/c/signup))
- SSH key pair (သို့မဟုတ် password auth ကို အသုံးပြုလိုစိတ်ရှိခြင်း)
- ~ မိနစ် ၂၀

## 1. Droplet တစ်ခု ဖန်တီးပါ

1. [DigitalOcean](https://cloud.digitalocean.com/) သို့ လော့ဂ်အင် ဝင်ပါ
2. **Create → Droplets** ကို နှိပ်ပါ
3. အောက်ပါတို့ကို ရွေးချယ်ပါ:
   - **Region:** သင် (သို့မဟုတ် သင်၏ အသုံးပြုသူများ) နှင့် အနီးဆုံး
   - **Image:** Ubuntu 24.04 LTS
   - **Size:** Basic → Regular → **$6/mo** (1 vCPU, 1GB RAM, 25GB SSD)
   - **Authentication:** SSH key (အကြံပြု) သို့မဟုတ် password
4. **Create Droplet** ကို နှိပ်ပါ
5. IP address ကို မှတ်ထားပါ

## 2) SSH ဖြင့် ချိတ်ဆက်ပါ

```bash
ssh root@YOUR_DROPLET_IP
```

## 3. OpenClaw ကို ထည့်သွင်းတပ်ဆင်ပါ

```bash
# Update system
apt update && apt upgrade -y

# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

# Install OpenClaw
curl -fsSL https://openclaw.ai/install.sh | bash

# Verify
openclaw --version
```

## 4. Onboarding ကို လုပ်ဆောင်ပါ

```bash
openclaw onboard --install-daemon
```

wizard သည် အောက်ပါတို့ကို အဆင့်လိုက် ညွှန်ပြပေးပါလိမ့်မည်—

- Model auth (API keys သို့မဟုတ် OAuth)
- Channel setup (Telegram, WhatsApp, Discord စသည်)
- Gateway token (အလိုအလျောက် ထုတ်ပေးသည်)
- Daemon installation (systemd)

## 5. Gateway ကို အတည်ပြုပါ

```bash
# Check status
openclaw status

# Check service
systemctl --user status openclaw-gateway.service

# View logs
journalctl --user -u openclaw-gateway.service -f
```

## 6. Dashboard သို့ ဝင်ရောက်ခြင်း

35. gateway သည် ပုံမှန်အားဖြင့် loopback သို့ bind လုပ်ထားပါသည်။ 36. Control UI ကို ဝင်ရောက်ရန်:

**Option A: SSH Tunnel (အကြံပြု)**

```bash
# From your local machine
ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP

# Then open: http://localhost:18789
```

**Option B: Tailscale Serve (HTTPS, loopback-only)**

```bash
# On the droplet
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# Configure Gateway to use Tailscale Serve
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

ဖွင့်ရန်: `https://<magicdns>/`

မှတ်ချက်များ:

- Serve သည် Gateway ကို loopback-only အဖြစ် ထိန်းသိမ်းထားပြီး Tailscale identity headers ဖြင့် authentication ပြုလုပ်သည်။
- token/password ကို လိုအပ်စေလိုပါက `gateway.auth.allowTailscale: false` ကို သတ်မှတ်ပါ သို့မဟုတ် `gateway.auth.mode: "password"` ကို အသုံးပြုပါ။

**Option C: Tailnet bind (Serve မပါ)**

```bash
openclaw config set gateway.bind tailnet
openclaw gateway restart
```

ဖွင့်ရန်: `http://<tailscale-ip>:18789` (token လိုအပ်သည်)။

## 7. သင်၏ Channels များကို ချိတ်ဆက်ပါ

### Telegram

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

### WhatsApp

```bash
openclaw channels login whatsapp
# Scan QR code
```

အခြား provider များအတွက် [Channels](/channels) ကို ကြည့်ပါ။

---

## 1GB RAM အတွက် အကောင်းဆုံး ပြင်ဆင်မှုများ

37. $6 droplet တွင် RAM 1GB သာရှိပါသည်။ To keep things running smoothly:

### Swap ထည့်ပါ (အကြံပြု)

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### ပေါ့ပါးသော model ကို အသုံးပြုပါ

OOM ဖြစ်နေပါက အောက်ပါတို့ကို စဉ်းစားပါ—

- local models အစား API-based models (Claude, GPT) ကို အသုံးပြုခြင်း
- `agents.defaults.model.primary` ကို ပိုသေးသော model သို့ သတ်မှတ်ခြင်း

### Memory ကို စောင့်ကြည့်ပါ

```bash
free -h
htop
```

---

## Persistence

State အားလုံးကို အောက်ပါတို့တွင် သိမ်းဆည်းထားပါသည်—

- `~/.openclaw/` — config, credentials, session data
- `~/.openclaw/workspace/` — workspace (SOUL.md, memory စသည်)

39. ဤအရာများသည် reboot ပြုလုပ်ပြီးနောက်လည်း ဆက်လက်တည်ရှိပါသည်။ 40. ၎င်းတို့ကို အချိန်အခါအားလျော်စွာ backup လုပ်ပါ:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Oracle Cloud အခမဲ့ အခြားရွေးချယ်မှု

Oracle Cloud သည် **Always Free** ARM instances များကို ပေးထားပြီး၊ ဤနေရာရှိ အခပေးရွေးချယ်မှုများအားလုံးထက် စွမ်းဆောင်ရည် ပိုမိုမြင့်မားသည် — တစ်လ $0 ဖြင့်။

| သင်ရရှိမည့်အရာ    | Specs                          |
| ----------------- | ------------------------------ |
| **4 OCPUs**       | ARM Ampere A1                  |
| **24GB RAM**      | လုံလောက်သည်ထက် ပိုများ         |
| **200GB storage** | Block volume                   |
| **အမြဲအခမဲ့**     | Credit card အခကြေးငွေ မကောက်ခံ |

**သတိပြုရန်:**

- Signup လုပ်စဉ် အနည်းငယ် စိတ်ရှုပ်စရာ ရှိနိုင်သည် (မအောင်မြင်ပါက ထပ်ကြိုးစားပါ)
- ARM architecture — အများစု အလုပ်လုပ်သော်လည်း binary အချို့မှာ ARM build လိုအပ်သည်

41. setup လမ်းညွှန်အပြည့်အစုံအတွက် [Oracle Cloud](/platforms/oracle) ကို ကြည့်ပါ။ 42. signup အကြံပြုချက်များနှင့် enrollment လုပ်ငန်းစဉ်ကို troubleshooting လုပ်ရန်အတွက် ဤ [community guide](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd) ကို ကြည့်ပါ။

---

## ပြဿနာဖြေရှင်းခြင်း

### Gateway မစတင်နိုင်ပါ

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl -u openclaw --no-pager -n 50
```

### Port ကို အသုံးပြုပြီးသား ဖြစ်နေသည်

```bash
lsof -i :18789
kill <PID>
```

### Memory မလုံလောက်ခြင်း

```bash
# Check memory
free -h

# Add more swap
# Or upgrade to $12/mo droplet (2GB RAM)
```

---

## ထပ်မံကြည့်ရှုရန်

- [Hetzner guide](/install/hetzner) — စျေးသက်သာပြီး စွမ်းဆောင်ရည်ပိုကောင်း
- [Docker install](/install/docker) — containerized setup
- [Tailscale](/gateway/tailscale) — လုံခြုံသော အဝေးမှ ဝင်ရောက်ခြင်း
- [Configuration](/gateway/configuration) — config reference အပြည့်အစုံ
