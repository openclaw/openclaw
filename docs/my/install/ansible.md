---
summary: "Ansible၊ Tailscale VPN နှင့် firewall ခွဲခြားကာကွယ်မှုတို့ကို အသုံးပြုသော အလိုအလျောက်၊ လုံခြုံရေးအမြင့် OpenClaw တပ်ဆင်ခြင်း"
read_when:
  - လုံခြုံရေးအားကောင်းစေသည့် အလိုအလျောက် ဆာဗာ တပ်ဆင်မှုကို လိုအပ်သည့်အခါ
  - VPN ဝင်ရောက်ခွင့်ပါသော firewall ခွဲခြားထားသည့် တပ်ဆင်မှုကို လိုအပ်သည့်အခါ
  - အဝေးမှ Debian/Ubuntu ဆာဗာများသို့ တပ်ဆင်မည့်အခါ
title: "Ansible"
---

# Ansible ဖြင့် တပ်ဆင်ခြင်း

ထုတ်လုပ်ရေး ဆာဗာများတွင် OpenClaw ကို တပ်ဆင်ရန် အကြံပြုထားသော နည်းလမ်းမှာ **[openclaw-ansible](https://github.com/openclaw/openclaw-ansible)** ဖြစ်ပြီး လုံခြုံရေးကို ဦးစားပေးထားသော ဖွဲ့စည်းပုံပါဝင်သည့် အလိုအလျောက် တပ်ဆင်ကိရိယာတစ်ခု ဖြစ်သည်။

## အမြန်စတင်ရန်

အမိန့်တစ်ကြောင်းဖြင့် တပ်ဆင်နိုင်သည် —

```bash
curl -fsSL https://raw.githubusercontent.com/openclaw/openclaw-ansible/main/install.sh | bash
```

> **📦 လမ်းညွှန်အပြည့်အစုံ: [github.com/openclaw/openclaw-ansible](https://github.com/openclaw/openclaw-ansible)**
>
> openclaw-ansible repo သည် Ansible deployment အတွက် အမှန်တကယ်ကိုးကားရမည့် အရင်းအမြစ်ဖြစ်ပါသည်။ ဤစာမျက်နှာသည် အကျဉ်းချုပ် အကြမ်းဖျဉ်း ဖြစ်ပါသည်။

## သင်ရရှိမည့် အရာများ

- 🔒 **Firewall ကို ဦးစားပေးသော လုံခြုံရေး**: UFW + Docker ခွဲခြားမှု (SSH + Tailscale သာ ဝင်ရောက်နိုင်)
- 🔐 **Tailscale VPN**: ဝန်ဆောင်မှုများကို အများပြည်သူသို့ မဖော်ပြဘဲ လုံခြုံစွာ အဝေးမှ ဝင်ရောက်နိုင်ခြင်း
- 🐳 **Docker**: ခွဲခြားထားသော sandbox ကွန်တိန်နာများ၊ localhost အတွင်းသာ ချိတ်ဆက်ထားမှု
- 🛡️ **Defense in depth**: လုံခြုံရေး အလွှာ ၄ ဆင့်ပါဝင်သော ဖွဲ့စည်းပုံ
- 🚀 **အမိန့်တစ်ကြောင်းဖြင့် တပ်ဆင်မှု**: မိနစ်အနည်းငယ်အတွင်း ပြီးစီးသော တပ်ဆင်မှု
- 🔧 **Systemd ပေါင်းစည်းမှု**: boot 时 အလိုအလျောက် စတင်ပြီး လုံခြုံရေးကို တင်းကျပ်စေခြင်း

## လိုအပ်ချက်များ

- **OS**: Debian 11+ သို့မဟုတ် Ubuntu 20.04+
- **ဝင်ရောက်ခွင့်**: Root သို့မဟုတ် sudo အခွင့်အရေး
- **ကွန်ယက်**: ပက်ကေ့ဂျ်များ ထည့်သွင်းရန် အင်တာနက် ချိတ်ဆက်မှု
- **Ansible**: 2.14+ (အမြန်စတင် script ဖြင့် အလိုအလျောက် ထည့်သွင်းပေးသည်)

## တပ်ဆင်သွားမည့် အရာများ

Ansible playbook သည် အောက်ပါအရာများကို ထည့်သွင်းပြီး ပြင်ဆင်ပေးသည် —

1. **Tailscale** (လုံခြုံသော အဝေးမှ ဝင်ရောက်မှုအတွက် mesh VPN)
2. **UFW firewall** (SSH + Tailscale ပေါက်များသာ ခွင့်ပြု)
3. **Docker CE + Compose V2** (agent sandbox များအတွက်)
4. **Node.js 22.x + pnpm** (runtime လိုအပ်ချက်များ)
5. **OpenClaw** (ဟို့စ်ပေါ်တွင် တိုက်ရိုက် လည်ပတ်၊ container မသုံး)
6. **Systemd service** (လုံခြုံရေးတင်းကျပ်မှုပါဝင်သည့် အလိုအလျောက် စတင်မှု)

မှတ်ချက်: gateway သည် **host ပေါ်တွင် တိုက်ရိုက် chạy လုပ်သည်** (Docker အတွင်းမဟုတ်ပါ)၊ သို့သော် agent sandbox များသည် isolation အတွက် Docker ကို အသုံးပြုပါသည်။ အသေးစိတ်အတွက် [Sandboxing](/gateway/sandboxing) ကို ကြည့်ပါ။

## တပ်ဆင်ပြီးနောက် ပြင်ဆင်မှု

တပ်ဆင်မှု ပြီးဆုံးပါက openclaw အသုံးပြုသူသို့ ပြောင်းပါ —

```bash
sudo -i -u openclaw
```

Post-install script သည် အောက်ပါအဆင့်များကို လမ်းညွှန်ပေးမည် —

1. **onboarding wizard**: OpenClaw ဆက်တင်များကို ပြင်ဆင်ခြင်း
2. **Provider login**: WhatsApp/Telegram/Discord/Signal ချိတ်ဆက်ခြင်း
3. **Gateway စမ်းသပ်ခြင်း**: တပ်ဆင်မှု မှန်ကန်ကြောင်း စစ်ဆေးခြင်း
4. **Tailscale တပ်ဆင်မှု**: သင်၏ VPN mesh သို့ ချိတ်ဆက်ခြင်း

### အမြန် အမိန့်များ

```bash
# Check service status
sudo systemctl status openclaw

# View live logs
sudo journalctl -u openclaw -f

# Restart gateway
sudo systemctl restart openclaw

# Provider login (run as openclaw user)
sudo -i -u openclaw
openclaw channels login
```

## လုံခြုံရေး ဖွဲ့စည်းပုံ

### လုံခြုံရေး အလွှာ ၄ ဆင့်

1. **Firewall (UFW)**: SSH (22) + Tailscale (41641/udp) သာ အများပြည်သူထံ ဖွင့်ထားသည်
2. **VPN (Tailscale)**: Gateway ကို VPN mesh မှတစ်ဆင့်သာ ဝင်ရောက်နိုင်သည်
3. **Docker ခွဲခြားမှု**: DOCKER-USER iptables chain ဖြင့် အပြင်ဘက် ပေါက်များ ဖော်ပြမှုကို တားဆီးသည်
4. **Systemd Hardening**: NoNewPrivileges၊ PrivateTmp၊ အခွင့်အရေးနည်းသော အသုံးပြုသူ

### စစ်ဆေးခြင်း

အပြင်ဘက်မှ တိုက်ခိုက်နိုင်သည့် မျက်နှာပြင်ကို စမ်းသပ်ရန် —

```bash
nmap -p- YOUR_SERVER_IP
```

**port 22** (SSH) ကိုသာ ဖွင့်ထားရပါမည်။ အခြား service များအားလုံး (gateway, Docker) ကို lock down လုပ်ထားပါသည်။

### Docker အသုံးပြုနိုင်မှု

Docker ကို **agent sandbox များ** (tool execution ကို ခွဲထုတ်ထားရန်) အတွက်သာ တပ်ဆင်ထားပြီး gateway ကို chạy လုပ်ရန် မဟုတ်ပါ။ gateway သည် localhost သို့သာ bind လုပ်ပြီး Tailscale VPN မှတစ်ဆင့် ဝင်ရောက်အသုံးပြုနိုင်ပါသည်။

Sandbox ဆက်တင်များအတွက် [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) ကို ကြည့်ပါ။

## လက်ဖြင့် တပ်ဆင်ခြင်း

အလိုအလျောက် လုပ်ဆောင်မှုအပေါ် ထိန်းချုပ်မှုကို ကိုယ်တိုင် လိုလားပါက —

```bash
# 1. Install prerequisites
sudo apt update && sudo apt install -y ansible git

# 2. Clone repository
git clone https://github.com/openclaw/openclaw-ansible.git
cd openclaw-ansible

# 3. Install Ansible collections
ansible-galaxy collection install -r requirements.yml

# 4. Run playbook
./run-playbook.sh

# Or run directly (then manually execute /tmp/openclaw-setup.sh after)
# ansible-playbook playbook.yml --ask-become-pass
```

## OpenClaw ကို အပ်ဒိတ်လုပ်ခြင်း

Ansible installer သည် OpenClaw ကို manual update များအတွက် ပြင်ဆင်ပေးပါသည်။ ပုံမှန် update လုပ်ငန်းစဉ်အတွက် [Updating](/install/updating) ကို ကြည့်ပါ။

Configuration ပြောင်းလဲမှုများအတွက် Ansible playbook ကို ပြန်လည် chạy လုပ်လိုပါက —

```bash
cd openclaw-ansible
./run-playbook.sh
```

မှတ်ချက် — ဤလုပ်ဆောင်မှုသည် idempotent ဖြစ်ပြီး အကြိမ်များစွာ လုပ်ဆောင်နိုင်သည်။

## ပြဿနာဖြေရှင်းခြင်း

### Firewall ကြောင့် ချိတ်ဆက်မရပါ

ဝင်ရောက်မရဖြစ်ပါက —

- ပထမဦးစွာ Tailscale VPN ဖြင့် ဝင်ရောက်နိုင်ကြောင်း သေချာပါစေ
- SSH ဝင်ရောက်မှု (port 22) ကို အမြဲ ခွင့်ပြုထားသည်
- Gateway ကို ဒီဇိုင်းအရ **Tailscale မှတစ်ဆင့်သာ** ဝင်ရောက်နိုင်သည်

### Service မစတင်ပါ

```bash
# Check logs
sudo journalctl -u openclaw -n 100

# Verify permissions
sudo ls -la /opt/openclaw

# Test manual start
sudo -i -u openclaw
cd ~/openclaw
pnpm start
```

### Docker sandbox ပြဿနာများ

```bash
# Verify Docker is running
sudo systemctl status docker

# Check sandbox image
sudo docker images | grep openclaw-sandbox

# Build sandbox image if missing
cd /opt/openclaw/openclaw
sudo -u openclaw ./scripts/sandbox-setup.sh
```

### Provider login မအောင်မြင်ပါ

`openclaw` အသုံးပြုသူအဖြစ် လုပ်ဆောင်နေကြောင်း သေချာပါစေ —

```bash
sudo -i -u openclaw
openclaw channels login
```

## အဆင့်မြင့် ပြင်ဆင်မှု

လုံခြုံရေး ဖွဲ့စည်းပုံနှင့် ပြဿနာဖြေရှင်းမှု အသေးစိတ်အတွက် —

- [Security Architecture](https://github.com/openclaw/openclaw-ansible/blob/main/docs/security.md)
- [Technical Details](https://github.com/openclaw/openclaw-ansible/blob/main/docs/architecture.md)
- [Troubleshooting Guide](https://github.com/openclaw/openclaw-ansible/blob/main/docs/troubleshooting.md)

## ဆက်စပ်အကြောင်းအရာများ

- [openclaw-ansible](https://github.com/openclaw/openclaw-ansible) — တပ်ဆင်မှု လမ်းညွှန်အပြည့်အစုံ
- [Docker](/install/docker) — container ဖြင့် Gateway တပ်ဆင်ခြင်း
- [Sandboxing](/gateway/sandboxing) — agent sandbox ပြင်ဆင်မှု
- [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) — အေးဂျင့်တစ်ခုချင်းစီအလိုက် ခွဲခြားမှု
