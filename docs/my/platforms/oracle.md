---
summary: "Oracle Cloud (Always Free ARM) ပေါ်တွင် OpenClaw"
read_when:
  - Oracle Cloud ပေါ်တွင် OpenClaw ကို တပ်ဆင်နေစဉ်
  - OpenClaw အတွက် ကုန်ကျစရိတ်နည်းသော VPS hosting ကို ရှာဖွေနေစဉ်
  - သေးငယ်သော ဆာဗာပေါ်တွင် 24/7 OpenClaw ကို အသုံးပြုလိုသည့်အခါ
title: "Oracle Cloud"
---

# Oracle Cloud (OCI) ပေါ်ရှိ OpenClaw

## ရည်ရွယ်ချက်

Oracle Cloud ၏ **Always Free** ARM tier ပေါ်တွင် အမြဲတမ်း အလုပ်လုပ်နေသော OpenClaw Gateway ကို လည်ပတ်ရန်။

Oracle ၏ free tier သည် OpenClaw အတွက် (အထူးသဖြင့် OCI အကောင့်ရှိပြီးသား ဖြစ်ပါက) သင့်တော်နိုင်သော်လည်း အပြန်အလှန်အလျှောက် အချို့ ရှိပါသည်—

- ARM architecture (အရာအများစု အလုပ်လုပ်သော်လည်း binary အချို့မှာ x86 သာ ထောက်ပံ့နိုင်သည်)
- စွမ်းရည်နှင့် စာရင်းသွင်းမှုမှာ တစ်ခါတစ်ရံ အဆင်မပြေဖြစ်နိုင်သည်

## ကုန်ကျစရိတ် နှိုင်းယှဉ်ချက် (2026)

| Provider     | Plan            | Specs                  | Price/mo             | Notes                 |
| ------------ | --------------- | ---------------------- | -------------------- | --------------------- |
| Oracle Cloud | Always Free ARM | up to 4 OCPU, 24GB RAM | $0                   | ARM, limited capacity |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM        | ~ $4 | Cheapest paid option  |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM        | $6                   | Easy UI, good docs    |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM        | $6                   | Many locations        |
| Linode       | Nanode          | 1 vCPU, 1GB RAM        | $5                   | Now part of Akamai    |

---

## ကြိုတင်လိုအပ်ချက်များ

- Oracle Cloud အကောင့် ([signup](https://www.oracle.com/cloud/free/)) — ပြဿနာကြုံပါက [community signup guide](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd) ကို ကြည့်ပါ
- Tailscale အကောင့် ([tailscale.com](https://tailscale.com) တွင် အခမဲ့)
- ~ မိနစ် 30 ခန့်

## 1. OCI Instance တစ်ခု ဖန်တီးခြင်း

1. [Oracle Cloud Console](https://cloud.oracle.com/) သို့ လော့ဂ်အင် ဝင်ပါ
2. **Compute → Instances → Create Instance** သို့ သွားပါ
3. အောက်ပါအတိုင်း ပြင်ဆင်ပါ—
   - **Name:** `openclaw`
   - **Image:** Ubuntu 24.04 (aarch64)
   - **Shape:** `VM.Standard.A1.Flex` (Ampere ARM)
   - **OCPUs:** 2 (သို့မဟုတ် 4 အထိ)
   - **Memory:** 12 GB (သို့မဟုတ် 24 GB အထိ)
   - **Boot volume:** 50 GB (အခမဲ့ 200 GB အထိ)
   - **SSH key:** သင့် public key ကို ထည့်ပါ
4. **Create** ကို နှိပ်ပါ
5. public IP address ကို မှတ်သားထားပါ

**အကြံပြုချက်:** instance ဖန်တီးရာတွင် "Out of capacity" ဟုပြသပြီး မအောင်မြင်ပါက availability domain ကိုပြောင်းကြည့်ပါ သို့မဟုတ် နောက်မှ ပြန်ကြိုးစားပါ။ Free tier ၏ capacity သည် ကန့်သတ်ထားပါသည်။

## 2. ချိတ်ဆက်ခြင်းနှင့် Update ပြုလုပ်ခြင်း

```bash
# Connect via public IP
ssh ubuntu@YOUR_PUBLIC_IP

# Update system
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential
```

**မှတ်ချက်:** ARM ပေါ်တွင် dependency အချို့ကို compile လုပ်ရန် `build-essential` လိုအပ်ပါသည်။

## 3. User နှင့် Hostname ကို ပြင်ဆင်ခြင်း

```bash
# Set hostname
sudo hostnamectl set-hostname openclaw

# Set password for ubuntu user
sudo passwd ubuntu

# Enable lingering (keeps user services running after logout)
sudo loginctl enable-linger ubuntu
```

## 4. Tailscale ထည့်သွင်းခြင်း

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname=openclaw
```

ဤအဆင့်သည် Tailscale SSH ကို ဖွင့်ပေးပါသည်။ ထို့ကြောင့် သင့် tailnet အတွင်းရှိ မည်သည့် device မဆိုမှ `ssh openclaw` ဖြင့် ချိတ်ဆက်နိုင်ပါသည် — public IP မလိုအပ်ပါ။

စစ်ဆေးရန်—

```bash
tailscale status
```

**ယခုမှစ၍ Tailscale ဖြင့်သာ ချိတ်ဆက်ပါ:** `ssh ubuntu@openclaw` (သို့မဟုတ် Tailscale IP ကို အသုံးပြုပါ)

## 5. OpenClaw ထည့်သွင်းခြင်း

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
source ~/.bashrc
```

"How do you want to hatch your bot?" ဟုပြမေးသောအခါ **"Do this later"** ကို ရွေးချယ်ပါ။

> မှတ်ချက်: ARM-native build ပြဿနာများ ကြုံပါက Homebrew ကို မသုံးမီ system packages (ဥပမာ `sudo apt install -y build-essential`) ဖြင့် စတင်ပါ။

## 6. Gateway (loopback + token auth) ကို ပြင်ဆင်ပြီး Tailscale Serve ကို ဖွင့်ခြင်း

default အနေဖြင့် token auth ကို အသုံးပြုပါ။ ၎င်းသည် ခန့်မှန်းနိုင်ပြီး “insecure auth” Control UI flags မလိုအပ်စေပါ။

```bash
# Keep the Gateway private on the VM
openclaw config set gateway.bind loopback

# Require auth for the Gateway + Control UI
openclaw config set gateway.auth.mode token
openclaw doctor --generate-gateway-token

# Expose over Tailscale Serve (HTTPS + tailnet access)
openclaw config set gateway.tailscale.mode serve
openclaw config set gateway.trustedProxies '["127.0.0.1"]'

systemctl --user restart openclaw-gateway
```

## 7. အတည်ပြုစစ်ဆေးခြင်း

```bash
# Check version
openclaw --version

# Check daemon status
systemctl --user status openclaw-gateway

# Check Tailscale Serve
tailscale serve status

# Test local response
curl http://localhost:18789
```

## 8. VCN Security ကို တင်းကျပ်စေခြင်း

အရာအားလုံး အလုပ်လုပ်နေပြီဖြစ်သောကြောင့် Tailscale မှလွဲ၍ traffic အားလုံးကို ပိတ်ရန် VCN ကို lock down လုပ်ပါ။ OCI ၏ Virtual Cloud Network သည် network edge တွင် firewall အဖြစ် လုပ်ဆောင်ပြီး — traffic သည် instance ထိ မရောက်မီပင် ပိတ်ဆို့ထားပါသည်။

1. OCI Console တွင် **Networking → Virtual Cloud Networks** သို့ သွားပါ
2. သင့် VCN ကို နှိပ်ပြီး → **Security Lists** → Default Security List
3. အောက်ပါတစ်ခုမှလွဲ၍ ingress rules အားလုံးကို **ဖယ်ရှားပါ**—
   - `0.0.0.0/0 UDP 41641` (Tailscale)
4. default egress rules (အပြင်ဘက်သို့ အားလုံး ခွင့်ပြုထားခြင်း) ကို ထားရှိပါ

၎င်းသည် network edge တွင် SSH (port 22), HTTP, HTTPS နှင့် အခြားအားလုံးကို ပိတ်ဆို့ပါသည်။ ယခုမှစပြီး Tailscale မှတစ်ဆင့်သာ ချိတ်ဆက်နိုင်ပါမည်။

---

## Control UI ကို ဝင်ရောက်ခြင်း

သင့် Tailscale network အတွင်းရှိ မည်သည့် device မဆိုမှ—

```
https://openclaw.<tailnet-name>.ts.net/
```

`<tailnet-name>` ကို သင့် tailnet အမည်ဖြင့် အစားထိုးပါ ( `tailscale status` တွင် မြင်နိုင်ပါသည် )။

SSH tunnel မလိုအပ်ပါ။ Tailscale သည် အောက်ပါအရာများကို ပံ့ပိုးပေးပါသည်:

- HTTPS encryption (အလိုအလျောက် certificate များ)
- Tailscale identity ဖြင့် authentication
- သင့် tailnet အတွင်းရှိ မည်သည့် device မဆိုမှ ဝင်ရောက်နိုင်ခြင်း (laptop၊ ဖုန်း စသည်)

---

## လုံခြုံရေး: VCN + Tailscale (အကြံပြု အခြေခံ)

VCN ကို တင်းကျပ်ထားပြီး (UDP 41641 သာ ဖွင့်ထားခြင်း) Gateway ကို loopback သို့ bind လုပ်ထားပါက defense-in-depth ကို ခိုင်မာစွာ ရရှိပါသည်။ Public traffic ကို network edge တွင် ပိတ်ထားပြီး admin access ကို သင့် tailnet မှတစ်ဆင့်သာ ပြုလုပ်ပါသည်။

ဤ setup သည် Internet အနှံ့ SSH brute force ကို တားဆီးရန် host-based firewall rules အပိုများ မလိုအပ်တော့စေတတ်သော်လည်း OS ကို အမြဲ update လုပ်ထားရန်၊ `openclaw security audit` ကို လည်ပတ်ထားရန်နှင့် public interfaces ပေါ်တွင် မတော်တဆ listen မလုပ်နေကြောင်း စစ်ဆေးသင့်ပါသည်။

### အလိုအလျောက် ကာကွယ်ထားပြီးသား အချက်များ

| Traditional Step   | Needed?     | Why                                                                             |
| ------------------ | ----------- | ------------------------------------------------------------------------------- |
| UFW firewall       | No          | VCN သည် traffic ကို instance မရောက်မီပင် ပိတ်ဆို့ထားသည်                         |
| fail2ban           | No          | port 22 ကို VCN တွင် ပိတ်ထားသောကြောင့် brute force မရှိပါ                       |
| sshd hardening     | No          | Tailscale SSH သည် sshd ကို မအသုံးပြုပါ                                          |
| Disable root login | No          | Tailscale သည် system user မဟုတ်ဘဲ Tailscale identity ကို အသုံးပြုသည်            |
| SSH key-only auth  | No          | Tailscale သည် သင့် tailnet မှတစ်ဆင့် authentication ပြုလုပ်သည်                  |
| IPv6 hardening     | Usually not | သင့် VCN/subnet setting ပေါ်မူတည်သည်; အမှန်တကယ် assign/expose ဖြစ်နေတာကို စစ်ပါ |

### ဆက်လက် အကြံပြုထားသည့် အချက်များ

- **Credential permissions:** `chmod 700 ~/.openclaw`
- **Security audit:** `openclaw security audit`
- **System updates:** `sudo apt update && sudo apt upgrade` ကို ပုံမှန် လုပ်ဆောင်ပါ
- **Monitor Tailscale:** [Tailscale admin console](https://login.tailscale.com/admin) တွင် device များကို စစ်ဆေးပါ

### လုံခြုံရေး အခြေအနေ စစ်ဆေးခြင်း

```bash
# Confirm no public ports listening
sudo ss -tlnp | grep -v '127.0.0.1\|::1'

# Verify Tailscale SSH is active
tailscale status | grep -q 'offers: ssh' && echo "Tailscale SSH active"

# Optional: disable sshd entirely
sudo systemctl disable --now ssh
```

---

## အရန်ရွေးချယ်မှု: SSH Tunnel

Tailscale Serve အလုပ်မလုပ်ပါက SSH tunnel ကို အသုံးပြုပါ—

```bash
# From your local machine (via Tailscale)
ssh -L 18789:127.0.0.1:18789 ubuntu@openclaw
```

ပြီးလျှင် `http://localhost:18789` ကို ဖွင့်ပါ။

---

## ပြဿနာဖြေရှင်းခြင်း

### Instance ဖန်တီးမှု မအောင်မြင်ပါ ("Out of capacity")

Free tier ARM instances များသည် လူကြိုက်များပါသည်။ စမ်းကြည့်ပါ:

- availability domain ကို ပြောင်းပါ
- လူနည်းချိန် (မနက်စောစော) တွင် ထပ်ကြိုးစားပါ
- shape ရွေးချယ်ရာတွင် "Always Free" filter ကို အသုံးပြုပါ

### Tailscale မချိတ်ဆက်နိုင်ပါ

```bash
# Check status
sudo tailscale status

# Re-authenticate
sudo tailscale up --ssh --hostname=openclaw --reset
```

### Gateway မစတင်နိုင်ပါ

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl --user -u openclaw-gateway -n 50
```

### Control UI ကို မရောက်နိုင်ပါ

```bash
# Verify Tailscale Serve is running
tailscale serve status

# Check gateway is listening
curl http://localhost:18789

# Restart if needed
systemctl --user restart openclaw-gateway
```

### ARM binary ပြဿနာများ

အချို့သော tools များတွင် ARM builds မရှိနိုင်ပါ။ စစ်ဆေးပါ:

```bash
uname -m  # Should show aarch64
```

npm packages အများစုမှာ ပြဿနာမရှိဘဲ အလုပ်လုပ်ပါသည်။ binaries များအတွက် `linux-arm64` သို့မဟုတ် `aarch64` releases များကို ရှာဖွေပါ။

---

## အမြဲတမ်း ထိန်းသိမ်းထားမှု (Persistence)

State အားလုံးသည် အောက်ပါတို့တွင် တည်ရှိပါသည်—

- `~/.openclaw/` — config၊ credentials၊ session data
- `~/.openclaw/workspace/` — workspace (SOUL.md၊ memory၊ artifacts)

အချိန်အခါလိုက် backup ပြုလုပ်ပါ—

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## ထပ်မံဖတ်ရှုရန်

- [Gateway remote access](/gateway/remote) — အခြား remote access ပုံစံများ
- [Tailscale integration](/gateway/tailscale) — Tailscale စာရွက်စာတမ်း အပြည့်အစုံ
- [Gateway configuration](/gateway/configuration) — config ရွေးချယ်မှုများအားလုံး
- [DigitalOcean guide](/platforms/digitalocean) — ပိုမိုလွယ်ကူသော signup နှင့် paid option
- [Hetzner guide](/install/hetzner) — Docker အခြေခံ အစားထိုးရွေးချယ်မှု
