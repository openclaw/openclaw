---
summary: "OpenClaw sa Oracle Cloud (Always Free ARM)"
read_when:
  - Pagse-setup ng OpenClaw sa Oracle Cloud
  - Naghahanap ng murang VPS hosting para sa OpenClaw
  - Gusto ng 24/7 OpenClaw sa isang maliit na server
title: "Oracle Cloud"
---

# OpenClaw sa Oracle Cloud (OCI)

## Layunin

Magpatakbo ng persistent na OpenClaw Gateway sa **Always Free** ARM tier ng Oracle Cloud.

Maaaring maging magandang opsyon ang free tier ng Oracle para sa OpenClaw (lalo na kung may OCI account ka na), pero may kaakibat itong mga kompromiso:

- ARM architecture (karamihan ay gumagana, pero may ilang binary na x86-only)
- Maaaring maselan ang capacity at signup

## Paghahambing ng Gastos (2026)

| Provider     | Plan            | Specs                     | Presyo/buwan         | Mga tala                      |
| ------------ | --------------- | ------------------------- | -------------------- | ----------------------------- |
| Oracle Cloud | Always Free ARM | hanggang 4 OCPU, 24GB RAM | $0                   | ARM, limitadong capacity      |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM           | ~ $4 | Pinakamurang paid option      |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM           | $6                   | Madaling UI, magagandang docs |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM           | $6                   | Maraming lokasyon             |
| Linode       | Nanode          | 1 vCPU, 1GB RAM           | $5                   | Bahagi na ng Akamai           |

---

## Mga paunang kinakailangan

- Oracle Cloud account ([signup](https://www.oracle.com/cloud/free/)) — tingnan ang [community signup guide](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd) kung may ma-encounter na isyu
- Tailscale account (libre sa [tailscale.com](https://tailscale.com))
- ~30 minuto

## 1. Gumawa ng OCI Instance

1. Mag-log in sa [Oracle Cloud Console](https://cloud.oracle.com/)
2. Pumunta sa **Compute → Instances → Create Instance**
3. I-configure:
   - **Name:** `openclaw`
   - **Image:** Ubuntu 24.04 (aarch64)
   - **Shape:** `VM.Standard.A1.Flex` (Ampere ARM)
   - **OCPUs:** 2 (o hanggang 4)
   - **Memory:** 12 GB (o hanggang 24 GB)
   - **Boot volume:** 50 GB (hanggang 200 GB libre)
   - **SSH key:** Idagdag ang iyong public key
4. I-click ang **Create**
5. Tandaan ang public IP address

**Tip:** Kung pumalya ang paggawa ng instance na may "Out of capacity", subukan ang ibang availability domain o mag-retry sa ibang oras. Limitado ang kapasidad ng free tier.

## 2. Kumonekta at Mag-update

```bash
# Connect via public IP
ssh ubuntu@YOUR_PUBLIC_IP

# Update system
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential
```

**Tala:** Kailangan ang `build-essential` para sa ARM compilation ng ilang dependency.

## 3. I-configure ang User at Hostname

```bash
# Set hostname
sudo hostnamectl set-hostname openclaw

# Set password for ubuntu user
sudo passwd ubuntu

# Enable lingering (keeps user services running after logout)
sudo loginctl enable-linger ubuntu
```

## 4. I-install ang Tailscale

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh --hostname=openclaw
```

Ina-enable nito ang Tailscale SSH, kaya maaari kang kumonekta gamit ang `ssh openclaw` mula sa anumang device sa iyong tailnet — hindi na kailangan ng public IP.

I-verify:

```bash
tailscale status
```

**Mula ngayon, kumonekta sa pamamagitan ng Tailscale:** `ssh ubuntu@openclaw` (o gamitin ang Tailscale IP).

## 5. I-install ang OpenClaw

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
source ~/.bashrc
```

Kapag tinanong na "How do you want to hatch your bot?", piliin ang **"Do this later"**.

> Tala: Kung makaranas ka ng ARM-native build issues, magsimula muna sa system packages (hal. `sudo apt install -y build-essential`) bago gumamit ng Homebrew.

## 6. I-configure ang Gateway (loopback + token auth) at i-enable ang Tailscale Serve

Gamitin ang token auth bilang default. Ito ay predictable at iniiwasan ang pangangailangan ng anumang “insecure auth” Control UI flags.

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

## 7. I-verify

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

## 8. Higpitan ang VCN Security

Ngayong gumagana na ang lahat, i-lock down ang VCN upang harangan ang lahat ng trapiko maliban sa Tailscale. Ang Virtual Cloud Network ng OCI ay kumikilos bilang firewall sa gilid ng network — nahaharangan ang trapiko bago pa ito makarating sa iyong instance.

1. Pumunta sa **Networking → Virtual Cloud Networks** sa OCI Console
2. I-click ang iyong VCN → **Security Lists** → Default Security List
3. **Alisin** ang lahat ng ingress rules maliban sa:
   - `0.0.0.0/0 UDP 41641` (Tailscale)
4. Panatilihin ang default egress rules (payagan ang lahat ng outbound)

Hinaharangan nito ang SSH sa port 22, HTTP, HTTPS, at lahat ng iba pa sa gilid ng network. Mula ngayon, maaari ka na lamang kumonekta sa pamamagitan ng Tailscale.

---

## I-access ang Control UI

Mula sa anumang device sa iyong Tailscale network:

```
https://openclaw.<tailnet-name>.ts.net/
```

Palitan ang `<tailnet-name>` ng pangalan ng iyong tailnet (makikita sa `tailscale status`).

Hindi na kailangan ng SSH tunnel. Nagbibigay ang Tailscale ng:

- HTTPS encryption (automatic certs)
- Authentication gamit ang Tailscale identity
- Access mula sa anumang device sa iyong tailnet (laptop, phone, atbp.)

---

## Security: VCN + Tailscale (inirerekomendang baseline)

Kapag naka-lock down ang VCN (tanging UDP 41641 lang ang bukas) at ang Gateway ay naka-bind sa loopback, nakakakuha ka ng matibay na defense-in-depth: bina-block ang public traffic sa network edge, at ang admin access ay dumadaan sa iyong tailnet.

Madalas nitong inaalis ang _pangailangan_ para sa dagdag na host-based firewall rules para lang pigilan ang Internet-wide SSH brute force — pero dapat mo pa ring panatilihing updated ang OS, patakbuhin ang `openclaw security audit`, at i-verify na hindi ka aksidenteng nakikinig sa mga public interface.

### Ano ang Protektado na

| Tradisyunal na Hakbang   | Kailangan?      | Bakit                                                                                |
| ------------------------ | --------------- | ------------------------------------------------------------------------------------ |
| UFW firewall             | Hindi           | Hinaharang ng VCN bago pa makarating ang traffic sa instance                         |
| fail2ban                 | Hindi           | Walang brute force kung naka-block ang port 22 sa VCN                                |
| sshd hardening           | Hindi           | Hindi gumagamit ng sshd ang Tailscale SSH                                            |
| I-disable ang root login | Hindi           | Tailscale identity ang gamit, hindi system users                                     |
| SSH key-only auth        | Hindi           | Tailscale ang nag-a-authenticate sa pamamagitan ng iyong tailnet                     |
| IPv6 hardening           | Karaniwan hindi | Depende sa VCN/subnet settings; i-verify kung ano talaga ang naka-assign/naka-expose |

### Inirerekomenda Pa Rin

- **Mga pahintulot ng credential:** `chmod 700 ~/.openclaw`
- **Security audit:** `openclaw security audit`
- **System updates:** patakbuhin ang `sudo apt update && sudo apt upgrade` nang regular
- **I-monitor ang Tailscale:** Suriin ang mga device sa [Tailscale admin console](https://login.tailscale.com/admin)

### I-verify ang Security Posture

```bash
# Confirm no public ports listening
sudo ss -tlnp | grep -v '127.0.0.1\|::1'

# Verify Tailscale SSH is active
tailscale status | grep -q 'offers: ssh' && echo "Tailscale SSH active"

# Optional: disable sshd entirely
sudo systemctl disable --now ssh
```

---

## Fallback: SSH Tunnel

Kung hindi gumagana ang Tailscale Serve, gumamit ng SSH tunnel:

```bash
# From your local machine (via Tailscale)
ssh -L 18789:127.0.0.1:18789 ubuntu@openclaw
```

Pagkatapos ay buksan ang `http://localhost:18789`.

---

## Pag-troubleshoot

### Pumapalya ang paggawa ng instance ("Out of capacity")

Sikat ang free tier ARM instances. Subukan:

- Ibang availability domain
- Mag-retry sa off-peak hours (maagang umaga)
- Gamitin ang "Always Free" filter kapag pumipili ng shape

### Ayaw kumonekta ng Tailscale

```bash
# Check status
sudo tailscale status

# Re-authenticate
sudo tailscale up --ssh --hostname=openclaw --reset
```

### Ayaw mag-start ng Gateway

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl --user -u openclaw-gateway -n 50
```

### Hindi maabot ang Control UI

```bash
# Verify Tailscale Serve is running
tailscale serve status

# Check gateway is listening
curl http://localhost:18789

# Restart if needed
systemctl --user restart openclaw-gateway
```

### Mga isyu sa ARM binary

Maaaring walang ARM builds ang ilang tool. Suriin:

```bash
uname -m  # Should show aarch64
```

Karamihan sa mga npm package ay gumagana nang maayos. Para sa mga binary, hanapin ang `linux-arm64` o `aarch64` na mga release.

---

## Persistence

Nasa mga sumusunod ang lahat ng state:

- `~/.openclaw/` — config, credentials, session data
- `~/.openclaw/workspace/` — workspace (SOUL.md, memory, artifacts)

Mag-back up nang pana-panahon:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Tingnan Din

- [Gateway remote access](/gateway/remote) — iba pang pattern ng remote access
- [Tailscale integration](/gateway/tailscale) — kumpletong Tailscale docs
- [Gateway configuration](/gateway/configuration) — lahat ng opsyon sa config
- [DigitalOcean guide](/platforms/digitalocean) — kung gusto mo ng paid + mas madaling signup
- [Hetzner guide](/install/hetzner) — Docker-based na alternatibo
