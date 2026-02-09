---
summary: "OpenClaw på DigitalOcean (simpel betalt VPS-mulighed)"
read_when:
  - Opsætning af OpenClaw på DigitalOcean
  - Leder efter billig VPS-hosting til OpenClaw
title: "DigitalOcean"
---

# OpenClaw på DigitalOcean

## Mål

Kør en vedvarende OpenClaw Gateway på DigitalOcean for **$6 / måned** (eller $4 / mdr med reserverede priser).

Hvis du vil have en $0/måned-mulighed og ikke har noget imod ARM + udbyderspecifik opsætning, se [Oracle Cloud-guiden](/platforms/oracle).

## Prissammenligning (2026)

| Udbyder      | Plan            | Specifikationer         | Pris/md.                       | Noter                                         |
| ------------ | --------------- | ----------------------- | ---------------------------------------------- | --------------------------------------------- |
| Oracle Cloud | Always Free ARM | op til 4 OCPU, 24GB RAM | $0                                             | ARM, begrænset kapacitet / tilmeldings-quirks |
| Hetzner      | CX22            | 2 vCPU, 4GB RAM         | €3,79 (~$4) | Billigste betalte mulighed                    |
| DigitalOcean | Basic           | 1 vCPU, 1GB RAM         | $6                                             | Nem UI, god dokumentation                     |
| Vultr        | Cloud Compute   | 1 vCPU, 1GB RAM         | $6                                             | Mange lokationer                              |
| Linode       | Nanode          | 1 vCPU, 1GB RAM         | $5                                             | Nu en del af Akamai                           |

**Valg af udbyder:**

- DigitalOcean: enkleste UX + forudsigelig opsætning (denne guide)
- Hetzner: god pris/ydelse (se [Hetzner-guiden](/install/hetzner))
- Oracle Cloud: kan være $0/md., men er mere finicky og kun ARM (se [Oracle-guiden](/platforms/oracle))

---

## Forudsætninger

- DigitalOcean-konto ([tilmeld dig med $200 gratis kredit](https://m.do.co/c/signup))
- SSH-nøglepar (eller villighed til at bruge adgangskodegodkendelse)
- ~20 minutter

## 1. Opret en Droplet

1. Log ind på [DigitalOcean](https://cloud.digitalocean.com/)
2. Klik **Create → Droplets**
3. Vælg:
   - **Region:** Tættest på dig (eller dine brugere)
   - **Image:** Ubuntu 24.04 LTS
   - **Size:** Basic → Regular → **$6/md.** (1 vCPU, 1GB RAM, 25GB SSD)
   - **Authentication:** SSH-nøgle (anbefalet) eller adgangskode
4. Klik **Create Droplet**
5. Notér IP-adressen

## 2) Forbind via SSH

```bash
ssh root@YOUR_DROPLET_IP
```

## 3. Installér OpenClaw

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

## 4. Kør introduktion

```bash
openclaw onboard --install-daemon
```

Opsætningsguiden fører dig igennem:

- Modelautentificering (API-nøgler eller OAuth)
- Kanalopsætning (Telegram, WhatsApp, Discord, m.fl.)
- Gateway-token (auto-genereret)
- Daemon-installation (systemd)

## 5. Verificér Gateway

```bash
# Check status
openclaw status

# Check service
systemctl --user status openclaw-gateway.service

# View logs
journalctl --user -u openclaw-gateway.service -f
```

## 6. Få adgang til dashboardet

Gateway binder til loopback som standard. For at få adgang til kontrolUI:

**Mulighed A: SSH-tunnel (anbefalet)**

```bash
# From your local machine
ssh -L 18789:localhost:18789 root@YOUR_DROPLET_IP

# Then open: http://localhost:18789
```

**Mulighed B: Tailscale Serve (HTTPS, kun loopback)**

```bash
# On the droplet
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up

# Configure Gateway to use Tailscale Serve
openclaw config set gateway.tailscale.mode serve
openclaw gateway restart
```

Åbn: `https://<magicdns>/`

Noter:

- Serve holder Gateway loopback-only og autentificerer via Tailscale-identitetsheadere.
- For i stedet at kræve token/adgangskode, sæt `gateway.auth.allowTailscale: false` eller brug `gateway.auth.mode: "password"`.

**Mulighed C: Tailnet-bind (uden Serve)**

```bash
openclaw config set gateway.bind tailnet
openclaw gateway restart
```

Åbn: `http://<tailscale-ip>:18789` (token påkrævet).

## 7. Forbind dine kanaler

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

Se [Kanaler](/channels) for andre udbydere.

---

## Optimeringer til 1GB RAM

Den $6 droplet har kun 1GB RAM. For at holde tingene gnidningsløre:

### Tilføj swap (anbefalet)

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

### Brug en lettere model

Hvis du rammer OOMs, overvej:

- At bruge API-baserede modeller (Claude, GPT) i stedet for lokale modeller
- At sætte `agents.defaults.model.primary` til en mindre model

### Overvåg hukommelse

```bash
free -h
htop
```

---

## Persistens

Al tilstand ligger i:

- `~/.openclaw/` — konfiguration, legitimationsoplysninger, sessionsdata
- `~/.openclaw/workspace/` — workspace (SOUL.md, hukommelse, m.m.)

Disse overleve genstarter. Tilbage dem periodisk:

```bash
tar -czvf openclaw-backup.tar.gz ~/.openclaw ~/.openclaw/workspace
```

---

## Oracle Cloud gratis alternativ

Oracle Cloud tilbyder **Always Free** ARM-instanser, der er markant mere kraftfulde end enhver betalt mulighed her — for $0/md.

| Hvad du får          | Specifikationer              |
| -------------------- | ---------------------------- |
| **4 OCPU’er**        | ARM Ampere A1                |
| **24GB RAM**         | Mere end rigeligt            |
| **200GB lager**      | Block volume                 |
| **Gratis for altid** | Ingen kreditkortopkrævninger |

**Forbehold:**

- Tilmelding kan være finicky (prøv igen, hvis det fejler)
- ARM-arkitektur — det meste virker, men nogle binærer kræver ARM-builds

For den fulde opsætningsguide, se [Oracle Cloud](/platforms/oracle). For tilmeldingstips og fejlfinding af tilmeldingsprocessen, se denne [fællesskabsvejledning](https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd).

---

## Fejlfinding

### Gateway vil ikke starte

```bash
openclaw gateway status
openclaw doctor --non-interactive
journalctl -u openclaw --no-pager -n 50
```

### Port er allerede i brug

```bash
lsof -i :18789
kill <PID>
```

### Løbet tør for hukommelse

```bash
# Check memory
free -h

# Add more swap
# Or upgrade to $12/mo droplet (2GB RAM)
```

---

## Se også

- [Hetzner-guiden](/install/hetzner) — billigere, mere kraftfuld
- [Docker-installation](/install/docker) — containeriseret opsætning
- [Tailscale](/gateway/tailscale) — sikker fjernadgang
- [Konfiguration](/gateway/configuration) — fuld konfigurationsreference
