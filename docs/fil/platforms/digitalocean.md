---
summary: "OpenClaw sa DigitalOcean (simpleng bayad na opsyon ng VPS)"
read_when:
  - Pagse-setup ng OpenClaw sa DigitalOcean
  - Naghahanap ng murang VPS hosting para sa OpenClaw
title: "DigitalOcean"
---

# OpenClaw sa DigitalOcean

## Layunin

Magpatakbo ng persistent na OpenClaw Gateway sa DigitalOcean sa halagang **$6/buwan** (o $4/buwan gamit ang reserved pricing).

Kung gusto mo ng $0/buwan na opsyon at ayos lang sa iyo ang ARM + provider-specific na setup, tingnan ang [Oracle Cloud guide](/platforms/oracle).

## Paghahambing ng Gastos (2026)

| Provider     | Plan            | Specs                     | Presyo/buwan                                                   | Mga tala                                    |
| ------------ | --------------- | ------------------------- | -------------------------------------------------------------- | ------------------------------------------- |
| Oracle Cloud | Always Free ARM | hanggang 4 OCPU, 24GB RAM | $0                                                             | ARM, limitadong capacity / quirks sa signup |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM           | €3.79 (~$4) | Pinakamurang bayad na opsyon                |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM           | $6                                                             | Madaling UI, magagandang docs               |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM           | $6                                                             | Maraming lokasyon                           |
| Linode       | Nanode          | 1 vCPU, 1GB RAM           | $5                                                             | Bahagi na ngayon ng Akamai                  |

**Pagpili ng provider:**

- DigitalOcean: pinakasimpleng UX + predictable na setup (ang gabay na ito)
- Hetzner: magandang presyo/performance (tingnan ang [Hetzner guide](/install/hetzner))
- Oracle Cloud: puwedeng $0/buwan, pero mas maselan at ARM-only (tingnan ang [Oracle guide](/platforms/oracle))

---

## Mga paunang kinakailangan

- DigitalOcean account ([mag-sign up na may $200 free credit](https://m.do.co/c/signup))
- SSH key pair (o kahandaang gumamit ng password auth)
- ~20 minuto

## 1. Gumawa ng Droplet

1. Mag-log in sa [DigitalOcean](https://cloud.digitalocean.com/)
2. I-click ang **Create → Droplets**
3. Piliin:
   - **Region:** Pinakamalapit sa iyo (o sa iyong mga user)
   - **Image:** Ubuntu 24.04 LTS
   - **Size:** Basic → Regular → **$6/buwan** (1 vCPU, 1GB RAM, 25GB SSD)
   - **Authentication:** SSH key (inirerekomenda) o password
4. I-click ang **Create Droplet**
5. Itala ang IP address

## 2) Kumonekta sa pamamagitan ng SSH

```bash
ssh root@YOUR_DROPLET_IP
```

## 3. I-install ang OpenClaw

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

## 4. Patakbuhin ang Onboarding

```bash
openclaw onboard --install-daemon
```

Gagabayan ka ng wizard sa:

- Model auth (API keys o OAuth)
- Setup ng channel (Telegram, WhatsApp, Discord, atbp.)
- Gateway token (auto-generated)
- Pag-install ng daemon (systemd)

## 5. I-verify ang Gateway

```bash
# Check status
openclaw status

# Check service
systemctl --user status openclaw-gateway.service

# View logs
journalctl --user -u openclaw-gateway.service -f
```

## 6. I-access ang Dashboard

The gateway binds to loopback by default. To access the Control UI:

**Opsyon A: SSH Tunnel (inirerekomenda)**

```bash
# From your local machine
ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP

# Then open: http://localhost:18789
```

**Opsyon B: Tailscale Serve (HTTPS, loopback-only)**

```bash
# On the droplet
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# Configure Gateway to use Tailscale Serve
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

Buksan: `https://<magicdns>/`

Mga tala:

- Pinapanatili ng Serve ang Gateway na loopback-only at nag-a-authenticate gamit ang Tailscale identity headers.
- Para mangailangan ng token/password sa halip, itakda ang `gateway.auth.allowTailscale: false` o gamitin ang `gateway.auth.mode: "password"`.

**Opsyon C: Tailnet bind (walang Serve)**

```bash
openclaw config set gateway.bind tailnet
openclaw gateway restart
```

Buksan: `http://<tailscale-ip>:18789` (kailangan ng token).

## 7. Ikonekta ang Iyong mga Channel

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

Tingnan ang [Channels](/channels) para sa iba pang provider.

---

## Mga Optimisasyon para sa 1GB RAM

The $6 droplet only has 1GB RAM. To keep things running smoothly:

### Magdagdag ng swap (inirerekomenda)

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### Gumamit ng mas magaan na model

Kung nakakaranas ka ng OOMs, isaalang-alang ang:

- Paggamit ng API-based na mga model (Claude, GPT) sa halip na local models
- Pag-set ng `agents.defaults.model.primary` sa mas maliit na model

### I-monitor ang memory

```bash
free -h
htop
```

---

## Persistence

Lahat ng state ay nasa:

- `~/.openclaw/` — config, credentials, session data
- `~/.openclaw/workspace/` — workspace (SOUL.md, memory, atbp.)

These survive reboots. Back them up periodically:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Oracle Cloud Free na Alternatibo

Nag-aalok ang Oracle Cloud ng **Always Free** ARM instances na mas makapangyarihan nang malaki kaysa sa alinmang bayad na opsyon dito — sa halagang $0/buwan.

| Ano ang makukuha mo | Specs                        |
| ------------------- | ---------------------------- |
| **4 OCPUs**         | ARM Ampere A1                |
| **24GB RAM**        | Higit pa sa sapat            |
| **200GB storage**   | Block volume                 |
| **Forever free**    | Walang singil sa credit card |

**Mga paalala:**

- Maaaring maging maselan ang signup (subukang muli kung pumalya)
- ARM architecture — karamihan ay gumagana, pero may ilang binary na nangangailangan ng ARM builds

Para sa kumpletong gabay sa setup, tingnan ang [Oracle Cloud](/platforms/oracle). Para sa mga tip sa pag-sign up at pag-troubleshoot ng proseso ng enrollment, tingnan ang [community guide](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd).

---

## Pag-troubleshoot

### Hindi nagsisimula ang Gateway

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl -u openclaw --no-pager -n 50
```

### Ginagamit na ang port

```bash
lsof -i :18789
kill <PID>
```

### Kulang sa memory

```bash
# Check memory
free -h

# Add more swap
# Or upgrade to $12/mo droplet (2GB RAM)
```

---

## Tingnan din

- [Hetzner guide](/install/hetzner) — mas mura, mas makapangyarihan
- [Docker install](/install/docker) — containerized na setup
- [Tailscale](/gateway/tailscale) — secure na remote access
- [Configuration](/gateway/configuration) — kumpletong reference ng config
